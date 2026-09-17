// GPEXE -> Training Load import plan (pilot). Pure: no database, no
// network, no file access — it turns already-fetched GPEXE REST responses
// into a provider-neutral plan that gpexeImportWriter.js writes.
//
// Every rule below was verified against real GPEXE v6 responses (team 980,
// session 186942), not against the 2020 handbook, whose examples differ:
// - Naive timestamps (team_session.start_timestamp, track.timestamp,
//   thresholds validity) are UTC: track.timestamp equals track.utc_timestamp.
//   The local zone comes from track.timezone. validateTrackTimestamps()
//   re-checks this on every import so a server-side change can't silently
//   shift local dates.
// - Numeric athlete_session fields are SI (total_time s, total_distance m,
//   max_v m/s) regardless of the account's user_units; only formatted
//   strings follow user_units.
// - One athlete_session row per athlete, track and part: drill === null is
//   the whole session, drill === n is drill n. Every row's teamsession is
//   the parent session. The whole-session value already equals the sum of
//   the drills, so the two levels are stored separately and never added.
// - /more/ carries per-row zone distances (complementary_data) with each
//   zone's boundaries, and event counts with their thresholds.
//
// Only values GPEXE itself reports are imported: one GPEXE field, or one
// GPEXE zone exactly as GPEXE delimits it, at most unit-converted. Values
// computed from several GPEXE values (m/min, Acc+Dec, Burst+brakes, and
// HMLD / EXP as sums of power zones) are NOT imported: they belong to a
// future OptiMove derived metrics feature with a formula and a formula
// version (GPEXE_DERIVED_NOT_IMPORTED).

export const GPEXE_SOURCE_SYSTEM = "gpexe";

// Only categories whose meaning is confirmed for the pilot are importable.
const ACTIVITY_TYPE_BY_CATEGORY = new Map([["FULL TRAINING", "training_session"]]);

export class GpexeMappingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function finiteNumber(raw) {
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Distance of the ONE GPEXE zone whose extremes are exactly [lower, upper]
// (upper null = open top zone), as GPEXE reports it. Both boundaries must be
// team thresholds valid on the session date and the zone must exist with
// exactly those extremes, so a changed or added threshold (e.g. 25 -> 24
// W/kg, or a new 50 W/kg split) skips the metric instead of importing a
// zone with a different meaning. Nothing is summed.
function zoneDistance(zones, configuredThresholds, [lower, upper]) {
  if (!Array.isArray(configuredThresholds) || [lower, upper].some((b) => b !== null && !configuredThresholds.includes(b))) return { skip: "team_threshold_missing" };
  if (configuredThresholds.some((t) => t > lower && (upper === null || t < upper))) return { skip: "team_threshold_split" };
  if (!Array.isArray(zones) || zones.length === 0) return { skip: "zones_missing" };
  const matching = zones.filter((z) => Array.isArray(z?.extremes) && z.extremes[0] === lower && (z.extremes[1] ?? null) === upper);
  if (matching.length > 1) return { skip: "zone_boundary_ambiguous" };
  if (matching.length === 0) return { skip: "zone_boundary_missing" };
  if (matching[0].is_ready !== true) return { skip: "zones_not_ready" };
  const distance = finiteNumber(matching[0].distance);
  return distance === null ? { skip: "zone_distance_missing" } : { value: distance };
}

function powerZoneSpec(lower, upper) {
  const range = upper === null ? `≥${lower}` : `${lower}–${upper}`;
  return {
    key: upper === null ? `gpexe_power_zone_${lower}_plus_distance` : `gpexe_power_zone_${lower}_${upper}_distance`,
    label: `GPEXE zona snage ${range} W/kg`, unit: "m", dailyAggregationMethod: "sum", definition: "confirmed",
    sourceContext: {
      field: "more.complementary_data.power[].distance", sourceUnit: "m", zoneUnit: "W/kg", gpexeZoneExtremes: [lower, upper],
      teamThresholdField: "power_thresholds", conversion: null,
    },
    extract: ({ more, thresholds }) => zoneDistance(more?.complementary_data?.power, thresholds?.power_thresholds, [lower, upper]),
  };
}

// GPEXE may report a threshold as a number or as a numeric string. The set is
// stored and hashed as provenance, so it is normalized to numbers first: a
// changed representation of the same set must not read as a changed set.
function numberOrNull(raw) {
  return finiteNumber(raw);
}

function numberArrayOrNull(raw) {
  if (!Array.isArray(raw)) return null;
  const numbers = raw.map(finiteNumber);
  return numbers.some((n) => n === null) ? null : numbers;
}

function eventCount(events, prefix, expectedThreshold, expectedDuration) {
  if (!events) return { skip: "events_missing" };
  if (events[`${prefix}_threshold_value`] !== expectedThreshold) return { skip: "threshold_mismatch" };
  if (events[`${prefix}_duration`] !== expectedDuration) return { skip: "duration_mismatch" };
  const count = finiteNumber(events[`${prefix}_count`]);
  if (count === null) return { skip: "count_missing" };
  return { value: count };
}

function detailsNumber(playerDetails, field) {
  if (!playerDetails) return { skip: "details_not_fetched" };
  const entry = playerDetails[field];
  if (!entry) return { skip: "field_missing" };
  if (entry.unit !== "number") return { skip: "unexpected_unit" };
  const value = finiteNumber(entry.value);
  return value === null ? { skip: "value_missing" } : { value };
}

// definition: "confirmed" = source field, unit and meaning proven on real
// responses; "unconfirmed" = a real GPEXE value whose own definition is not
// confirmed yet — imported under a label that says so.
// sourceContext is stored with the metric definition version and is part of
// every imported value's content hash.
export const GPEXE_METRIC_SPECS = [
  {
    key: "gpexe_time_min", label: "TIME", unit: "min", dailyAggregationMethod: "sum", definition: "confirmed",
    sourceContext: { field: "athlete_session.total_time", sourceUnit: "s", conversion: "divide by 60" },
    extract: ({ row }) => {
      const seconds = finiteNumber(row.total_time);
      return seconds === null ? { skip: "total_time_missing" } : { value: seconds / 60 };
    },
  },
  {
    key: "gpexe_total_distance", label: "TotDist", unit: "m", dailyAggregationMethod: "sum", definition: "confirmed",
    sourceContext: { field: "athlete_session.total_distance", sourceUnit: "m", conversion: null },
    extract: ({ row }) => {
      const meters = finiteNumber(row.total_distance);
      return meters === null ? { skip: "total_distance_missing" } : { value: meters };
    },
  },
  powerZoneSpec(25, 60),
  powerZoneSpec(60, 75),
  powerZoneSpec(75, null),
  {
    key: "gpexe_acceleration_events", label: "GPEXE acceleration events ≥2.5 m/s²", unit: "n", dailyAggregationMethod: "sum", definition: "confirmed",
    sourceContext: { field: "more.events.acceleration_events_count", sourceUnit: "n", thresholdMps2: 2.5, minDurationS: 0.3, conversion: null },
    extract: ({ more }) => eventCount(more?.events, "acceleration_events", 2.5, 0.3),
  },
  {
    key: "gpexe_deceleration_events", label: "GPEXE deceleration events ≤−2.5 m/s²", unit: "n", dailyAggregationMethod: "sum", definition: "confirmed",
    sourceContext: { field: "more.events.deceleration_events_count", sourceUnit: "n", thresholdMps2: -2.5, minDurationS: 0.3, conversion: null },
    extract: ({ more }) => eventCount(more?.events, "deceleration_events", -2.5, 0.3),
  },
  {
    key: "gpexe_sprint_distance_7mps", label: "Sprint distanca ≥25,2 km/h", unit: "m", dailyAggregationMethod: "sum", definition: "confirmed",
    sourceContext: { field: "more.complementary_data.speed[].distance", sourceUnit: "m", zoneUnit: "m/s", gpexeZoneExtremes: [7, null], gpexeThresholdMps: 7, equalsKmh: 25.2, teamThresholdField: "speed_thresholds", conversion: null },
    extract: ({ more, thresholds }) => zoneDistance(more?.complementary_data?.speed, thresholds?.speed_thresholds, [7, null]),
  },
  {
    key: "gpexe_burst_events", label: "GPEXE burst events (definicija nepotvrđena)", unit: "n", dailyAggregationMethod: "sum", definition: "unconfirmed",
    sourceContext: { field: "details.players[athlete].tot_burst_events", sourceUnit: "n", thresholds: "not reported by the GPEXE API", conversion: null },
    extract: ({ playerDetails }) => detailsNumber(playerDetails, "tot_burst_events"),
  },
  {
    key: "gpexe_brake_events", label: "GPEXE brake events (definicija nepotvrđena)", unit: "n", dailyAggregationMethod: "sum", definition: "unconfirmed",
    sourceContext: { field: "details.players[athlete].tot_brake_events", sourceUnit: "n", thresholds: "not reported by the GPEXE API", conversion: null },
    extract: ({ playerDetails }) => detailsNumber(playerDetails, "tot_brake_events"),
  },
  {
    key: "gpexe_max_speed", label: "SPEEDmax", unit: "km/h", dailyAggregationMethod: "max", definition: "confirmed",
    sourceContext: { field: "athlete_session.max_v", sourceUnit: "m/s", conversion: "multiply by 3.6" },
    extract: ({ row }) => {
      const mps = finiteNumber(row.max_v);
      return mps === null ? { skip: "max_v_missing" } : { value: mps * 3.6 };
    },
  },
];

export const GPEXE_DERIVED_NOT_IMPORTED = [
  { label: "m/min", formula: "gpexe_total_distance / gpexe_time_min" },
  { label: "Acc+Dec", formula: "gpexe_acceleration_events + gpexe_deceleration_events" },
  { label: "Burst&brakes", formula: "gpexe_burst_events + gpexe_brake_events" },
  { label: "HMLD ≥25 W/kg (m)", formula: "gpexe_power_zone_25_60_distance + gpexe_power_zone_60_75_distance + gpexe_power_zone_75_plus_distance" },
  { label: "EXPDist ≥60 W/kg (m)", formula: "gpexe_power_zone_60_75_distance + gpexe_power_zone_75_plus_distance" },
];

function parseNaiveUtc(naive, field) {
  if (typeof naive !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(naive)) {
    throw new GpexeMappingError("invalid_timestamp", `${field} is not a naive ISO timestamp: ${naive}`);
  }
  const date = new Date(`${naive}Z`);
  if (Number.isNaN(date.getTime())) throw new GpexeMappingError("invalid_timestamp", `${field} is not a valid timestamp: ${naive}`);
  return date;
}

export function localDateInTimezone(instant, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function localTimeInTimezone(instant, timezone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
}

// Intl silently falls back to the machine's zone for an undefined timeZone,
// so a missing value must be rejected before the Intl check.
function validTimezone(timezone) {
  if (typeof timezone !== "string" || timezone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// track.timestamp (naive) must be the same instant as track.utc_timestamp
// (epoch seconds) — the evidence that naive GPEXE timestamps are UTC.
function validateTrackTimestamps(track) {
  const naive = parseNaiveUtc(track.timestamp, `track ${track.id} timestamp`);
  const epochMs = finiteNumber(track.utc_timestamp) * 1000;
  if (!Number.isFinite(epochMs) || Math.abs(naive.getTime() - epochMs) > 1000) {
    throw new GpexeMappingError("timestamp_semantics_changed", `track ${track.id}: timestamp ${track.timestamp} is not the UTC instant of utc_timestamp ${track.utc_timestamp}`);
  }
}

// The team threshold set must belong to the session's team and be valid at
// the session start (GET team/:id/thresholds/?valid_on=<session day>).
// Its id, validity window and the thresholds the import actually depends on
// are carried through the plan so the writer can store them with the event:
// which set was in force is a different fact from a metric's own static
// bounds in condition_description, and GPEXE can change a set later.
function validateTeamThresholds(thresholds, session, startInstant) {
  if (!thresholds) throw new GpexeMappingError("thresholds_missing", `team thresholds for team ${session.team} were not fetched.`);
  if (String(thresholds.team) !== String(session.team)) {
    throw new GpexeMappingError("thresholds_wrong_team", `thresholds ${thresholds.id} belong to team ${thresholds.team}, session team is ${session.team}.`);
  }
  const validFrom = parseNaiveUtc(thresholds.validity_start, "thresholds.validity_start");
  const validTo = thresholds.validity_end ? parseNaiveUtc(thresholds.validity_end, "thresholds.validity_end") : null;
  if (startInstant < validFrom || (validTo && startInstant >= validTo)) {
    throw new GpexeMappingError("thresholds_not_valid_for_session", `thresholds ${thresholds.id} (valid ${thresholds.validity_start} – ${thresholds.validity_end ?? "open"}) do not cover session start ${startInstant.toISOString()}.`);
  }
  // Field names verified on the real response for team 980, valid_on
  // 2026-09-14 (set 1473). A renamed or missing field would otherwise be
  // snapshotted as null and a later change of it would not be noticed, so an
  // incomplete set stops the import instead.
  const payload = {
    power_thresholds: numberArrayOrNull(thresholds.power_thresholds),
    speed_thresholds: numberArrayOrNull(thresholds.speed_thresholds),
    acceleration_events_threshold: numberOrNull(thresholds.acceleration_events_threshold),
    acceleration_events_duration: numberOrNull(thresholds.acceleration_events_duration),
    deceleration_events_threshold: numberOrNull(thresholds.deceleration_events_threshold),
    deceleration_events_duration: numberOrNull(thresholds.deceleration_events_duration),
  };
  const missing = Object.keys(payload).filter((k) => payload[k] === null);
  if (missing.length) {
    throw new GpexeMappingError("thresholds_payload_incomplete", `thresholds ${thresholds.id} is missing ${missing.join(", ")} — the set cannot be recorded as the provenance of this session.`);
  }
  return {
    id: String(thresholds.id),
    validityStart: validFrom.toISOString(),
    validityEnd: validTo ? validTo.toISOString() : null,
    payload,
  };
}

// bundle = {
//   teamSession: GET team_session/:id/,
//   athleteSessions: [GET athlete_session/:id/, ...] (whole + drill rows),
//   more: { [athleteSessionId]: GET athlete_session/:id/more/ },
//   tracks: { [trackId]: GET track/:id/ },
//   teamThresholds: GET team/:team/thresholds/?valid_on=<session day>,
//   details: { full: GET team_session/:id/details/, drills: { [n]: ...details/?drill=n } },
// }
export function buildGpexeImportPlan(bundle, { metricSpecs = GPEXE_METRIC_SPECS } = {}) {
  const session = bundle?.teamSession;
  if (!session?.id) throw new GpexeMappingError("session_missing", "teamSession is required.");
  if (session.is_stats_valid !== true) throw new GpexeMappingError("session_stats_invalid", `team_session ${session.id} has is_stats_valid=${session.is_stats_valid}.`);
  const activityTypeKey = ACTIVITY_TYPE_BY_CATEGORY.get(session.category_name);
  if (!activityTypeKey) throw new GpexeMappingError("unsupported_category", `team_session ${session.id} category "${session.category_name}" is not importable in the pilot.`);
  const sessionId = String(session.id);
  const startInstant = parseNaiveUtc(session.start_timestamp, "team_session.start_timestamp");
  const endInstant = parseNaiveUtc(session.end_timestamp, "team_session.end_timestamp");
  const sourceReportedAt = parseNaiveUtc(session.updated_on, "team_session.updated_on");
  const drillsCount = Number(session.drills_count ?? 0);
  if (!Number.isInteger(drillsCount) || drillsCount < 0) throw new GpexeMappingError("invalid_drills_count", `drills_count ${session.drills_count} is not a non-negative integer.`);
  const thresholdsUsed = validateTeamThresholds(bundle.teamThresholds, session, startInstant);

  const anomalies = [];
  const rows = (bundle.athleteSessions || []).filter((row) => String(row.teamsession) === sessionId);
  const foreignRows = (bundle.athleteSessions || []).length - rows.length;
  if (foreignRows > 0) anomalies.push({ kind: "foreign_athlete_session_ignored", detail: `${foreignRows} row(s) belong to another team_session` });

  // Group by athlete; an athlete recorded on more than one track in the
  // same session (e.g. a device restart) is reported and not imported.
  const byAthlete = new Map();
  for (const row of rows) {
    const athleteId = String(row.athlete);
    if (!byAthlete.has(athleteId)) byAthlete.set(athleteId, []);
    byAthlete.get(athleteId).push(row);
  }

  const timezones = new Set();
  const participants = [];
  const metricSkips = [];
  for (const [gpexeAthleteId, athleteRows] of [...byAthlete.entries()].sort(([a], [b]) => Number(a) - Number(b))) {
    const trackIds = [...new Set(athleteRows.map((r) => String(r.track)))];
    if (trackIds.length > 1) {
      anomalies.push({ kind: "multiple_tracks", gpexeAthleteId, detail: `tracks ${trackIds.join(", ")} — not imported, needs review` });
      continue;
    }
    const track = bundle.tracks?.[trackIds[0]];
    if (!track) throw new GpexeMappingError("track_missing", `track ${trackIds[0]} for athlete ${gpexeAthleteId} was not fetched.`);
    if (String(track.athlete) !== gpexeAthleteId) throw new GpexeMappingError("track_athlete_mismatch", `track ${track.id} belongs to athlete ${track.athlete}, not ${gpexeAthleteId}.`);
    validateTrackTimestamps(track);
    if (!validTimezone(track.timezone)) throw new GpexeMappingError("invalid_timezone", `track ${track.id} timezone "${track.timezone}" is not recognized.`);
    timezones.add(track.timezone);

    const invalid = athleteRows.filter((r) => r.is_stats_valid !== true);
    if (invalid.length) {
      anomalies.push({ kind: "stats_invalid", gpexeAthleteId, detail: `athlete_session ${invalid.map((r) => r.id).join(", ")} has is_stats_valid!=true — athlete not imported` });
      continue;
    }
    const wholeRows = athleteRows.filter((r) => r.drill === null || r.drill === undefined);
    if (wholeRows.length !== 1) {
      anomalies.push({ kind: "whole_session_row_count", gpexeAthleteId, detail: `${wholeRows.length} whole-session rows — athlete not imported` });
      continue;
    }
    const drillRows = athleteRows.filter((r) => r.drill !== null && r.drill !== undefined);
    const drillIndexes = drillRows.map((r) => Number(r.drill));
    if (drillIndexes.some((i) => !Number.isInteger(i) || i < 0 || i >= drillsCount)) {
      throw new GpexeMappingError("drill_index_out_of_range", `athlete ${gpexeAthleteId} has drill index outside 0..${drillsCount - 1}.`);
    }
    if (new Set(drillIndexes).size !== drillIndexes.length) {
      throw new GpexeMappingError("duplicate_drill_row", `athlete ${gpexeAthleteId} has more than one row for the same drill.`);
    }

    const results = [];
    for (const row of [wholeRows[0], ...drillRows.sort((a, b) => a.drill - b.drill)]) {
      const level = row.drill === null || row.drill === undefined ? "full" : "drill";
      const drillIndex = level === "drill" ? Number(row.drill) : null;
      const more = bundle.more?.[String(row.id)];
      if (!more || String(more.athletesession_id) !== String(row.id)) {
        throw new GpexeMappingError("more_missing", `/more/ for athlete_session ${row.id} was not fetched.`);
      }
      const details = level === "full" ? bundle.details?.full : bundle.details?.drills?.[String(drillIndex)];
      const playerDetails = details?.players?.[gpexeAthleteId] ?? null;
      const values = [];
      for (const spec of metricSpecs) {
        const extracted = spec.extract({ row, more, thresholds: bundle.teamThresholds, playerDetails });
        if (extracted.skip) {
          metricSkips.push({ gpexeAthleteId, athleteSessionId: String(row.id), level, drillIndex, metricKey: spec.key, reason: extracted.skip });
          continue;
        }
        values.push({ metricKey: spec.key, value: extracted.value, unit: spec.unit, sourceContext: spec.sourceContext });
      }
      results.push({
        externalId: level === "full" ? `athlete_session:${row.id}:full` : `athlete_session:${row.id}:drill:${drillIndex}`,
        athleteSessionId: String(row.id),
        level,
        drillIndex,
        values,
      });
    }

    // Whole-session totals already equal the sum of their drills when the
    // athlete has all drills; a mismatch is reported, never "fixed".
    if (drillsCount > 0 && drillRows.length === drillsCount) {
      for (const field of ["total_time", "total_distance"]) {
        const whole = finiteNumber(wholeRows[0][field]);
        const sum = drillRows.reduce((acc, r) => acc + (finiteNumber(r[field]) ?? 0), 0);
        if (whole !== null && Math.abs(whole - sum) > Math.max(1, whole * 0.001)) {
          anomalies.push({ kind: "whole_differs_from_drills", gpexeAthleteId, detail: `${field}: whole ${whole} vs drills ${sum}` });
        }
      }
    }
    participants.push({ gpexeAthleteId, timezone: track.timezone, results });
  }

  if (timezones.size > 1) throw new GpexeMappingError("mixed_timezones", `tracks report more than one timezone: ${[...timezones].join(", ")}.`);
  if (participants.length === 0) throw new GpexeMappingError("no_importable_participants", `team_session ${sessionId} has no importable athlete.`);
  const timezone = [...timezones][0];

  const segments = [];
  for (let drillIndex = 0; drillIndex < drillsCount; drillIndex += 1) {
    if (participants.some((p) => p.results.some((r) => r.drillIndex === drillIndex))) {
      segments.push({ drillIndex, order: drillIndex + 1, label: `Drill ${drillIndex + 1}` });
    }
  }

  return {
    sourceSystem: GPEXE_SOURCE_SYSTEM,
    gpexeTeamId: String(session.team),
    teamSessionId: sessionId,
    thresholdsUsed,
    event: {
      sourceExternalId: `team_session:${sessionId}`,
      name: `GPEXE ${session.category_name} ${localDateInTimezone(startInstant, timezone)} ${localTimeInTimezone(startInstant, timezone)}`,
      activityTypeKey,
      occurredInstant: startInstant.toISOString(),
      endedInstant: endInstant.toISOString(),
      occurredLocalDate: localDateInTimezone(startInstant, timezone),
      timezone,
      sourceReportedAt: sourceReportedAt.toISOString(),
    },
    metrics: metricSpecs.map(({ key, label, unit, dailyAggregationMethod, definition, sourceContext }) => ({ key, label, unit, dailyAggregationMethod, definition, sourceContext })),
    segments,
    participants,
    anomalies,
    metricSkips,
    derivedNotImported: GPEXE_DERIVED_NOT_IMPORTED,
  };
}

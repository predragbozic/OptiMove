// A frozen copy of the GPEXE metric specs the importer used before phase 9
// (9-B, contract J17 section 8.1): GPEXE_METRIC_SPECS and its helpers of
// backend/src/gpexeImportMapper.js as they stood at 8fa0ea7, verbatim. Since
// 9-B the importer has no spec list of its own - every value comes through an
// open mapping activation - and this copy is the characterisation test's
// oracle: one JavaScript double per (athlete, level, drill, legacy key),
// compared with what the mapped import writes. Test code only; never imported
// by backend/src.

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
export const LEGACY_SPECS = Object.freeze([
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
]);

// The registry key, the version's source parameters (the M2 API form), the
// revision's confirmation, the canonical variable's unit and the conversion
// that give today's value of each legacy spec through a mapping.
const closed = (lower, upper) => ({
  condition: { kind: "zone", operator: "between", lower, upper, unit: "W/kg" },
  sourceParameters: { lower, upper },
});
export const SPEC_REGISTRY = Object.freeze({
  gpexe_time_min: { sourceMetricKey: "athlete_session.total_time", confirmation: { unit: "s" }, targetUnit: "min", conversionNote: "Seconds to minutes.", toLegacy: (raw) => raw / 60 },
  gpexe_total_distance: { sourceMetricKey: "athlete_session.total_distance", confirmation: { unit: "m" }, targetUnit: "m", toLegacy: (raw) => raw },
  gpexe_power_zone_25_60_distance: { sourceMetricKey: "more.complementary_data.power.distance", confirmation: { unit: "m", boundUnit: "W/kg", operator: "between" }, targetUnit: "m", ...closed("25", "60"), toLegacy: (raw) => raw },
  gpexe_power_zone_60_75_distance: { sourceMetricKey: "more.complementary_data.power.distance", confirmation: { unit: "m", boundUnit: "W/kg", operator: "between" }, targetUnit: "m", ...closed("60", "75"), toLegacy: (raw) => raw },
  gpexe_power_zone_75_plus_distance: {
    sourceMetricKey: "more.complementary_data.power.distance.open_top", confirmation: { unit: "m", boundUnit: "W/kg", operator: ">=" }, targetUnit: "m",
    condition: { kind: "zone", operator: ">=", value: "75", unit: "W/kg" }, sourceParameters: { lower: "75", upper: null }, toLegacy: (raw) => raw,
  },
  gpexe_acceleration_events: {
    sourceMetricKey: "more.events.acceleration_events_count", confirmation: { unit: "count", boundUnit: "m/s2", operator: ">=" }, targetUnit: "count",
    condition: { kind: "event_threshold", operator: ">=", value: "2.5", durationSeconds: "0.3", unit: "m/s2" }, sourceParameters: { thresholdValue: "2.5", durationSeconds: "0.3" }, toLegacy: (raw) => raw,
  },
  gpexe_deceleration_events: {
    sourceMetricKey: "more.events.deceleration_events_count", confirmation: { unit: "count", boundUnit: "m/s2", operator: "<=" }, targetUnit: "count",
    condition: { kind: "event_threshold", operator: "<=", value: "-2.5", durationSeconds: "0.3", unit: "m/s2" }, sourceParameters: { thresholdValue: "-2.5", durationSeconds: "0.3" }, toLegacy: (raw) => raw,
  },
  gpexe_sprint_distance_7mps: {
    sourceMetricKey: "more.complementary_data.speed.distance", confirmation: { unit: "m", boundUnit: "m/s", operator: ">=" }, targetUnit: "m",
    condition: { kind: "zone", operator: ">=", value: "7", unit: "m/s" }, sourceParameters: { lower: "7", upper: null }, toLegacy: (raw) => raw,
  },
  gpexe_burst_events: { sourceMetricKey: "details.players.tot_burst_events", confirmation: { unit: "count" }, targetUnit: "count", toLegacy: (raw) => raw },
  gpexe_brake_events: { sourceMetricKey: "details.players.tot_brake_events", confirmation: { unit: "count" }, targetUnit: "count", toLegacy: (raw) => raw },
  gpexe_max_speed: { sourceMetricKey: "athlete_session.max_v", confirmation: { unit: "m/s" }, targetUnit: "km/h", conversionNote: "Metres per second to kilometres per hour.", toLegacy: (raw) => raw * 3.6 },
});

// The legacy values of a bundle, as the importer computed them before 9-B,
// through the same per-row inputs (the plan builder's gates are applied by
// the caller, who passes the kept rows): one entry per (athlete, level, drill
// index, legacy key) with a value, and one per skip with its code.
export function legacyRowValues({ row, more, thresholds, playerDetails }) {
  const out = [];
  for (const spec of LEGACY_SPECS) {
    const extracted = spec.extract({ row, more, thresholds, playerDetails });
    out.push(extracted.skip ? { key: spec.key, skip: extracted.skip } : { key: spec.key, value: extracted.value });
  }
  return out;
}

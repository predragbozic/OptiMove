// Phase 7f - the extractor registry (backend/src/sourceMetricExtractors.js).
// Contract: docs/ai/phase7f-extractor-registry-contract.md (J12), section 7.
// Pure: no database, no network. The registry against its table, the exact
// decimal comparison (R2), the zone rules J7 leaves to 7f, the event
// thresholds, two teams with two variables (OD1), a characterisation against
// today's mapper (GPEXE_METRIC_SPECS) on the synthetic GPEXE bundles of
// _gpexe-fixtures.mjs, and the architecture guards. The route enforcement (T4
// create, A1, GET /fields) is source-metric-extractors-routes-7f.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTRACTORS, ExtractorError, canonicalDecimal, compareDecimal, extractabilityCode, extractorFor, sameDecimal, setExtractorFallbackForTests,
} from "../src/sourceMetricExtractors.js";
import { GPEXE_METRIC_SPECS, buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { BUNDLE_FIELDS, projectMore } from "../src/gpexeRestV1Adapter.js";
import { defaultThresholds, makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../src");

const G = (sourceMetricKey) => extractorFor({ sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey });
const zone = (lower, upper, operator = upper === null ? ">=" : "between", unit = "W/kg") => ({ lower, operator, unit, upper });
const threshold = (thresholdValue, durationSeconds, operator, unit = "m/s2") => ({ duration_seconds: durationSeconds, operator, threshold_value: thresholdValue, unit });

// J12 section 1 / 2.1: the ten keys, their shape, kind, zone and direction.
const TABLE = [
  ["athlete_session.total_time", "number", "none", null, null],
  ["athlete_session.total_distance", "number", "none", null, null],
  ["athlete_session.max_v", "number", "none", null, null],
  ["more.complementary_data.power.distance", "zone_distance", "zone_bounds", "closed", null],
  ["more.complementary_data.power.distance.open_top", "zone_distance", "zone_bounds", "open_top", null],
  ["more.complementary_data.speed.distance", "zone_distance", "zone_bounds", "open", null],
  ["more.events.acceleration_events_count", "event_count", "event_threshold", null, "up"],
  ["more.events.deceleration_events_count", "event_count", "event_threshold", null, "down"],
  ["details.players.tot_burst_events", "unit_value_object", "none", null, null],
  ["details.players.tot_brake_events", "unit_value_object", "none", null, null],
];

test("1. the registry holds exactly the ten gpexe / rest_v1 fields, frozen, each with its shape, kind, zone and direction; nothing else is found", () => {
  assert.deepEqual(Object.keys(EXTRACTORS).sort(), TABLE.map(([k]) => `gpexe/rest_v1/${k}`).sort());
  assert.ok(Object.isFrozen(EXTRACTORS));
  assert.equal(Object.getPrototypeOf(EXTRACTORS), null, "no inherited key can be found");
  for (const [key, valueShape, parameterKind, zoneShape, direction] of TABLE) {
    const e = G(key);
    assert.ok(e, key);
    assert.ok(Object.isFrozen(e), key);
    assert.deepEqual([e.key, e.valueShape, e.parameterKind, e.zone, e.direction], [key, valueShape, parameterKind, zoneShape, direction], key);
    assert.equal(typeof e.checkParameters, "function");
    assert.equal(typeof e.extract, "function");
  }
  for (const bad of [
    { sourceSystem: "gpexe", apiFamily: "api", sourceMetricKey: "athlete_session.total_time" },
    { sourceSystem: "catapult", apiFamily: "rest_v1", sourceMetricKey: "athlete_session.total_time" },
    { sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: "athlete_session.unknown" },
    { sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: "toString" },
    { sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: "__proto__" },
    { sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: "m2.test.f1234" },
    { sourceSystem: "gpexe", apiFamily: "rest_v1" },
    {},
  ]) assert.equal(extractorFor(bad), null, JSON.stringify(bad));
  assert.equal(extractorFor(), null);
});

test("2. the exact decimal: one canonical text, 25 = 25.0, 2.5 = \"2.50\", 2.5 is never 2.4999999, exponents written out, order exact", () => {
  for (const [raw, text] of [
    [25, "25"], [25.0, "25"], ["25.0", "25"], ["0025.500", "25.5"], ["-0.0", "0"], [-0, "0"], [0.3, "0.3"], [-2.5, "-2.5"],
    [1.5e-7, "0.00000015"], [1e21, "1000000000000000000000"], ["-12.340", "-12.34"], [2.4999999, "2.4999999"],
  ]) assert.equal(canonicalDecimal(raw), text, JSON.stringify(raw));
  for (const raw of [null, undefined, "", "abc", "1e3", "1.", ".5", "+1", Infinity, NaN, true, {}, []]) assert.equal(canonicalDecimal(raw), null, String(raw));
  assert.equal(sameDecimal(25, "25.0"), true);
  assert.equal(sameDecimal(2.5, "2.50"), true);
  assert.equal(sameDecimal(2.5, 2.4999999), false);
  assert.equal(sameDecimal(-2.5, 2.5), false, "a threshold of another sign");
  assert.equal(sameDecimal(null, null), false, "nothing equals a missing value");
  assert.equal(compareDecimal("7", "60"), -1);
  assert.equal(compareDecimal("60", "7"), 1);
  assert.equal(compareDecimal("-2.5", "-2.49"), -1);
  assert.equal(compareDecimal("25", "25"), 0);
  assert.equal(compareDecimal("0.1", "0.09999999999999999999"), 1, "beyond a double's precision, still exact");
});

test("3. checkParameters: the closed power zone takes only between with upper above lower; the open top and the speed zone only >= with no upper", () => {
  const closed = G("more.complementary_data.power.distance");
  const openTop = G("more.complementary_data.power.distance.open_top");
  const speed = G("more.complementary_data.speed.distance");
  assert.equal(closed.checkParameters(zone(25, 60)), null);
  assert.equal(closed.checkParameters(zone("25", "60.0")), null, "the decimal text of the service and the numbers of a stored version");
  for (const bad of [zone(75, null), zone(25, null, "between"), zone(60, 25), zone(25, 25), zone(25, 60, ">="), zone(25, 60, "between", ""),
    { lower: 25, operator: "between", upper: 60 }, { ...zone(25, 60), extra: 1 }, zone("x", 60), null, {}, []]) {
    assert.equal(closed.checkParameters(bad), "parameters_unsupported", JSON.stringify(bad));
  }
  for (const e of [openTop, speed]) {
    assert.equal(e.checkParameters(zone(75, null)), null);
    for (const bad of [zone(25, 60), zone(75, null, ">"), zone(75, null, "between"), zone(75, 80, ">="), zone(75, null, "<="), {}, null]) {
      assert.equal(e.checkParameters(bad), "parameters_unsupported", `${e.key} ${JSON.stringify(bad)}`);
    }
  }
});

test("4. checkParameters: an event takes a one-sided operator of its direction, decimals and a duration that is not negative; a field without parameters takes {} or null", () => {
  const acc = G("more.events.acceleration_events_count");
  const dec = G("more.events.deceleration_events_count");
  for (const op of [">=", ">"]) assert.equal(acc.checkParameters(threshold(2.5, 0.3, op)), null, op);
  for (const op of ["<=", "<"]) assert.equal(dec.checkParameters(threshold(-2.5, 0.3, op)), null, op);
  for (const op of ["<=", "<", "between", "=", null]) assert.equal(acc.checkParameters(threshold(2.5, 0.3, op)), "parameters_unsupported", String(op));
  for (const op of [">=", ">", "between"]) assert.equal(dec.checkParameters(threshold(-2.5, 0.3, op)), "parameters_unsupported", op);
  assert.equal(acc.checkParameters(threshold(2.5, -0.3, ">=")), "parameters_unsupported", "a negative duration");
  assert.equal(acc.checkParameters(threshold("2.50", "0", ">=")), null, "a zero duration, decimal text");
  assert.equal(acc.checkParameters({ operator: ">=", threshold_value: 2.5, unit: "m/s2" }), "parameters_unsupported");
  assert.equal(acc.checkParameters({ ...threshold(2.5, 0.3, ">="), value: 1 }), "parameters_unsupported");
  assert.equal(acc.checkParameters(zone(25, 60)), "parameters_unsupported");
  for (const key of ["athlete_session.total_time", "athlete_session.total_distance", "athlete_session.max_v", "details.players.tot_burst_events", "details.players.tot_brake_events"]) {
    assert.equal(G(key).checkParameters({}), null, key);
    assert.equal(G(key).checkParameters(null), null, key);
    for (const bad of [zone(25, 60), { operator: ">=" }, [], "x", 0]) assert.equal(G(key).checkParameters(bad), "parameters_unsupported", `${key} ${JSON.stringify(bad)}`);
  }
});

test("5. extract refuses parameters its entry refuses (a configuration error, never a value) and never converts", () => {
  const closed = G("more.complementary_data.power.distance");
  assert.throws(() => closed.extract({}, zone(75, null)), (e) => e instanceof ExtractorError && e.code === "parameters_unsupported");
  assert.throws(() => G("athlete_session.total_time").extract({ row: { total_time: 60 } }, zone(1, 2)), (e) => e.code === "parameters_unsupported");
  assert.deepEqual(G("athlete_session.total_time").extract({ row: { total_time: 2400 } }, {}), { value: 2400 }, "seconds, not minutes");
  assert.deepEqual(G("athlete_session.max_v").extract({ row: { max_v: 7.5 } }, {}), { value: 7.5 }, "m/s, not km/h");
  assert.deepEqual(G("athlete_session.total_distance").extract({ row: { total_distance: "3000" } }, null), { value: 3000 });
  for (const [key, field] of [["athlete_session.total_time", "total_time"], ["athlete_session.total_distance", "total_distance"], ["athlete_session.max_v", "max_v"]]) {
    for (const raw of [undefined, null, "", "x", true, NaN, Infinity]) assert.deepEqual(G(key).extract({ row: { [field]: raw } }, {}), { skip: `${field}_missing` }, `${key} ${String(raw)}`);
    assert.deepEqual(G(key).extract({}, {}), { skip: `${field}_missing` });
  }
  assert.deepEqual(G("details.players.tot_burst_events").extract({ playerDetails: null }, {}), { skip: "details_not_fetched" });
  assert.deepEqual(G("details.players.tot_burst_events").extract({ playerDetails: {} }, {}), { skip: "field_missing" });
  assert.deepEqual(G("details.players.tot_brake_events").extract({ playerDetails: { tot_brake_events: { unit: "s", value: 1 } } }, {}), { skip: "unexpected_unit" });
  assert.deepEqual(G("details.players.tot_brake_events").extract({ playerDetails: { tot_brake_events: { unit: "number", value: "x" } } }, {}), { skip: "value_missing" });
  assert.deepEqual(G("details.players.tot_brake_events").extract({ playerDetails: { tot_brake_events: { unit: "number", value: 7 } } }, {}), { value: 7 });
});

// A /more/ answer with the given power and speed zones (each [lower, upper, distance, ready?]).
function more({ power = [], speed = [], events = null } = {}) {
  const z = ([lower, upper, distance, ready = true]) => ({ extremes: [lower, upper], distance, is_ready: ready });
  return { complementary_data: { power: power.map(z), speed: speed.map(z) }, events };
}
const POWER = [[null, 20, 1], [20, 25, 2], [25, 60, 3], [60, 75, 4], [75, null, 5]];
const TEAM = { power_thresholds: [20, 25, 60, 75], speed_thresholds: [5.5, 7] };

test("6. the zone rules of J7: closed zones only for the power key, exactly one null-top zone for .open_top, the open zone for speed; today's checks in today's order", () => {
  const closed = G("more.complementary_data.power.distance");
  const openTop = G("more.complementary_data.power.distance.open_top");
  const speed = G("more.complementary_data.speed.distance");
  const input = { more: more({ power: POWER, speed: [[null, 5.5, 10], [5.5, 7, 11], [7, null, 12]] }), thresholds: TEAM };
  assert.deepEqual(closed.extract(input, zone(25, 60)), { value: 3 });
  assert.deepEqual(closed.extract(input, zone(60, 75)), { value: 4 });
  assert.deepEqual(openTop.extract(input, zone(75, null)), { value: 5 });
  assert.deepEqual(speed.extract(input, zone(7, null, ">=", "m/s")), { value: 12 });
  // .open_top: no null-top zone, two, or one with another lower extreme.
  const noTop = { ...input, more: more({ power: POWER.slice(0, 4) }) };
  assert.deepEqual(openTop.extract(noTop, zone(75, null)), { skip: "zone_boundary_missing" });
  const twoTops = { ...input, more: more({ power: [...POWER, [75, null, 6]] }) };
  assert.deepEqual(openTop.extract(twoTops, zone(75, null)), { skip: "zone_boundary_ambiguous" });
  const otherTops = { ...input, more: more({ power: [...POWER.slice(0, 4), [80, null, 6]] }), thresholds: { power_thresholds: [20, 25, 60, 75, 80] } };
  assert.deepEqual(openTop.extract(otherTops, zone(80, null)), { value: 6 }, "the one open top, with its own lower extreme");
  const twoDifferentTops = { ...input, more: more({ power: [...POWER, [80, null, 6]] }), thresholds: { power_thresholds: [20, 25, 60, 75, 80] } };
  assert.deepEqual(openTop.extract(twoDifferentTops, zone(80, null)), { skip: "zone_boundary_ambiguous" }, "two null-top zones, whatever their lower extremes");
  const wrongLower = { ...input, more: more({ power: [...POWER.slice(0, 4), [70, null, 6]] }), thresholds: { power_thresholds: [20, 25, 60, 75, 80] } };
  assert.deepEqual(openTop.extract(wrongLower, zone(75, null)), { skip: "team_threshold_split" }, "the team checks come first: a team threshold above the open top's lower");
  const wrongLower2 = { ...input, more: more({ power: [...POWER.slice(0, 4), [70, null, 6]] }), thresholds: { power_thresholds: [20, 25, 60, 75] } };
  assert.deepEqual(openTop.extract(wrongLower2, zone(75, null)), { skip: "zone_boundary_missing" }, "its one open top starts at another value");
  // The closed key never reads an open zone, even with the same lower extreme.
  assert.deepEqual(closed.extract({ ...input, more: more({ power: [[25, null, 9]] }), thresholds: { power_thresholds: [25, 60] } }, zone(25, 60)), { skip: "zone_boundary_missing" });
  // Today's codes, in today's order.
  assert.deepEqual(closed.extract({ more: more({ power: POWER }), thresholds: {} }, zone(25, 60)), { skip: "team_threshold_missing" });
  assert.deepEqual(closed.extract({ more: more({ power: POWER }), thresholds: { power_thresholds: [25, 75] } }, zone(25, 60)), { skip: "team_threshold_missing" });
  assert.deepEqual(closed.extract({ more: more({ power: POWER }), thresholds: { power_thresholds: [25, 40, 60] } }, zone(25, 60)), { skip: "team_threshold_split" });
  assert.deepEqual(closed.extract({ more: more({ power: [] }), thresholds: TEAM }, zone(25, 60)), { skip: "zones_missing" });
  assert.deepEqual(closed.extract({ more: {}, thresholds: TEAM }, zone(25, 60)), { skip: "zones_missing" });
  assert.deepEqual(closed.extract({ more: more({ power: [...POWER, [25, 60, 7]] }), thresholds: TEAM }, zone(25, 60)), { skip: "zone_boundary_ambiguous" });
  assert.deepEqual(closed.extract({ more: more({ power: [[25, 60, 3, false]] }), thresholds: TEAM }, zone(25, 60)), { skip: "zones_not_ready" });
  assert.deepEqual(closed.extract({ more: more({ power: [[25, 60, null]] }), thresholds: TEAM }, zone(25, 60)), { skip: "zone_distance_missing" });
  assert.deepEqual(speed.extract({ more: more({ speed: [[7, null, 12]] }), thresholds: { speed_thresholds: [5.5, 6.5] } }, zone(7, null)), { skip: "team_threshold_missing" });
});

test("7. one decimal comparison for every bound and threshold: 25.0 against [25, 60] and the team's [25, 60]; 2.5 = 2.50; 2.5 ≠ 2.4999999; another sign", () => {
  const closed = G("more.complementary_data.power.distance");
  const input = { more: more({ power: POWER }), thresholds: TEAM };
  assert.deepEqual(closed.extract(input, zone("25.0", "60.000")), closed.extract(input, zone(25, 60)));
  assert.deepEqual(closed.extract({ more: more({ power: [[null, 20, 1], [20, "25.0", 2], ["25.0", "60", 3], [60, 75, 4], [75, null, 5]] }), thresholds: { power_thresholds: ["20", "25.00", 60, 75] } }, zone(25, 60)), { value: 3 }, "the answer's numeric texts");
  assert.deepEqual(closed.extract({ more: more({ power: [[25.0000001, 60, 3]] }), thresholds: { power_thresholds: [25.0000001, 60] } }, zone(25, 60)), { skip: "team_threshold_missing" });
  const acc = G("more.events.acceleration_events_count");
  const dec = G("more.events.deceleration_events_count");
  const events = { acceleration_events_threshold_value: 2.5, acceleration_events_duration: 0.3, acceleration_events_count: 20,
    deceleration_events_threshold_value: -2.5, deceleration_events_duration: 0.3, deceleration_events_count: 18 };
  assert.deepEqual(acc.extract({ more: { events } }, threshold("2.50", "0.30", ">=")), { value: 20 });
  assert.deepEqual(acc.extract({ more: { events } }, threshold(2.4999999, 0.3, ">=")), { skip: "threshold_mismatch" });
  assert.deepEqual(acc.extract({ more: { events } }, threshold(-2.5, 0.3, ">=")), { skip: "threshold_mismatch" }, "a threshold of another sign");
  assert.deepEqual(acc.extract({ more: { events } }, threshold(2.5, 0.31, ">")), { skip: "duration_mismatch" });
  assert.deepEqual(dec.extract({ more: { events } }, threshold(-2.5, 0.3, "<")), { value: 18 });
  assert.deepEqual(dec.extract({ more: { events } }, threshold(2.5, 0.3, "<=")), { skip: "threshold_mismatch" });
  assert.deepEqual(acc.extract({ more: {} }, threshold(2.5, 0.3, ">=")), { skip: "events_missing" });
  assert.deepEqual(acc.extract({ more: { events: { ...events, acceleration_events_count: null } } }, threshold(2.5, 0.3, ">=")), { skip: "count_missing" });
  assert.deepEqual(acc.extract({ more: { events: { ...events, acceleration_events_threshold_value: "2.5" } } }, threshold(2.5, 0.3, ">=")), { value: 20 }, "a numeric text in the answer");
  // Beyond a binary double: these decimals differ, while their doubles are equal.
  assert.equal(sameDecimal("0.1", "0.10000000000000000001"), false);
  assert.equal(Number("2.50000000000000000001"), 2.5, "the double cannot tell them apart");
  assert.deepEqual(acc.extract({ more: { events } }, threshold("2.50000000000000000001", "0.3", ">=")), { skip: "threshold_mismatch" });
  assert.deepEqual(acc.extract({ more: { events } }, threshold("2.5", "0.30000000000000000001", ">=")), { skip: "duration_mismatch" });
});

test("8. two teams, two variables (OD1): a version's fixed bounds give values for the team whose GPEXE zones match, and team_threshold_missing for the other, nothing written from a wrong zone", () => {
  const closed = G("more.complementary_data.power.distance");
  const seniors = { more: more({ power: [[null, 25, 1], [25, 60, 30], [60, null, 2]] }), thresholds: { power_thresholds: [25, 60] } };
  const u15 = { more: more({ power: [[null, 22, 1], [22, 55, 40], [55, null, 2]] }), thresholds: { power_thresholds: [22, 55] } };
  const seniorVariable = zone(25, 60);
  const u15Variable = zone(22, 55);
  assert.deepEqual(closed.extract(seniors, seniorVariable), { value: 30 });
  assert.deepEqual(closed.extract(u15, seniorVariable), { skip: "team_threshold_missing" });
  assert.deepEqual(closed.extract(u15, u15Variable), { value: 40 });
  assert.deepEqual(closed.extract(seniors, u15Variable), { skip: "team_threshold_missing" });
});

// Characterisation: every spec of today's mapper with a registry key, its own
// bounds as a version's parameters, and the spec's own conversion undone.
const SPEC_TO_KEY = {
  gpexe_time_min: ["athlete_session.total_time", {}, (raw) => raw / 60],
  gpexe_total_distance: ["athlete_session.total_distance", {}, (raw) => raw],
  gpexe_power_zone_25_60_distance: ["more.complementary_data.power.distance", zone(25, 60), (raw) => raw],
  gpexe_power_zone_60_75_distance: ["more.complementary_data.power.distance", zone(60, 75), (raw) => raw],
  gpexe_power_zone_75_plus_distance: ["more.complementary_data.power.distance.open_top", zone(75, null), (raw) => raw],
  gpexe_acceleration_events: ["more.events.acceleration_events_count", threshold(2.5, 0.3, ">="), (raw) => raw],
  gpexe_deceleration_events: ["more.events.deceleration_events_count", threshold(-2.5, 0.3, "<="), (raw) => raw],
  gpexe_sprint_distance_7mps: ["more.complementary_data.speed.distance", zone(7, null, ">=", "m/s"), (raw) => raw],
  gpexe_burst_events: ["details.players.tot_burst_events", {}, (raw) => raw],
  gpexe_brake_events: ["details.players.tot_brake_events", {}, (raw) => raw],
  gpexe_max_speed: ["athlete_session.max_v", {}, (raw) => raw * 3.6],
};

test("9. characterisation against today's mapper: on every row of the fixtures (whole session and drills), also as the rest_v1 adapter stores them with the real 1473 team thresholds, the registry with each spec's own bounds gives the same raw value and the same skip code", () => {
  assert.deepEqual(Object.keys(SPEC_TO_KEY).sort(), GPEXE_METRIC_SPECS.map((s) => s.key).sort(), "every spec has its key");
  const variants = [
    makeBundle({ athletes: standardAthletes() }),
    makeBundle({ athletes: standardAthletes().slice(0, 1), powerBounds: [[null, 20], [20, 24], [24, 60], [60, 75], [75, null]], accThreshold: 3 }),
    makeBundle({ athletes: standardAthletes().slice(0, 1), thresholds: { ...defaultThresholds(77), speed_thresholds: [5.5, 6.5], power_thresholds: [20, 24, 60, 75] } }),
    makeBundle({ athletes: standardAthletes().slice(0, 1), powerBounds: [[null, 20], [20, 25], [25, 55], [55, 75], [75, null]] }),
    makeBundle({ athletes: standardAthletes().slice(0, 1), powerBounds: [[null, 20], [20, 25], [25, 60], [25, 60], [75, null]] }),
    makeBundle({ athletes: standardAthletes(), detailsDrills: [] }),
  ];
  // The same bundle as the rest_v1 adapter stores it: every "more" through the
  // adapter's own projection, and the stored team thresholds of the real
  // GPEXE answer (fixtures/gpexe-team-thresholds-1473.json) projected to the
  // bundle's fields.
  const stored = JSON.parse(fs.readFileSync(path.resolve(__dirname, "fixtures/gpexe-team-thresholds-1473.json"), "utf8"));
  const projected = makeBundle({ athletes: standardAthletes() });
  projected.more = Object.fromEntries(Object.entries(projected.more).map(([id, more]) => [id, projectMore(more)]));
  projected.teamThresholds = Object.fromEntries(BUNDLE_FIELDS.teamThresholds.filter((k) => k in stored).map((k) => [k, stored[k]]));
  variants.push(projected);
  let compared = 0;
  for (const bundle of variants) {
    for (const row of bundle.athleteSessions) {
      const moreRow = bundle.more[String(row.id)];
      const details = row.drill === null ? bundle.details.full : bundle.details.drills?.[String(row.drill)];
      const input = { row, more: moreRow, thresholds: bundle.teamThresholds, playerDetails: details?.players?.[String(row.athlete)] ?? null };
      for (const spec of GPEXE_METRIC_SPECS) {
        const [key, params, convert] = SPEC_TO_KEY[spec.key];
        const today = spec.extract(input);
        const ours = G(key).extract(input, params);
        if (today.skip) assert.deepEqual(ours, { skip: today.skip }, `${spec.key} row ${row.id}`);
        else assert.equal(convert(ours.value), today.value, `${spec.key} row ${row.id}`);
        compared += 1;
      }
    }
  }
  assert.ok(compared > 150, `compared ${compared}`);
  // The plan built by today's mapper is unchanged by 7f (the importer is M4's).
  assert.equal(buildGpexeImportPlan(variants[0]).participants.length, 2);
});

test("10. extract only ever answers a finite number or a skip code, whatever the bundle holds", () => {
  const junk = [undefined, null, "", "x", NaN, Infinity, -Infinity, true, {}, [], "1e309"];
  const keys = TABLE.map(([k]) => k);
  const paramsFor = { "more.complementary_data.power.distance": zone(25, 60), "more.complementary_data.power.distance.open_top": zone(75, null),
    "more.complementary_data.speed.distance": zone(7, null), "more.events.acceleration_events_count": threshold(2.5, 0.3, ">="),
    "more.events.deceleration_events_count": threshold(-2.5, 0.3, "<=") };
  for (const key of keys) {
    for (const value of junk) {
      const input = {
        row: { total_time: value, total_distance: value, max_v: value },
        more: { complementary_data: { power: [{ extremes: [25, 60], distance: value, is_ready: true }, { extremes: [75, null], distance: value, is_ready: true }], speed: [{ extremes: [7, null], distance: value, is_ready: true }] },
          events: { acceleration_events_threshold_value: 2.5, acceleration_events_duration: 0.3, acceleration_events_count: value, deceleration_events_threshold_value: -2.5, deceleration_events_duration: 0.3, deceleration_events_count: value } },
        thresholds: { power_thresholds: [25, 60, 75], speed_thresholds: [7] },
        playerDetails: { tot_burst_events: { unit: "number", value }, tot_brake_events: { unit: "number", value } },
      };
      const out = G(key).extract(input, paramsFor[key] ?? {});
      if ("value" in out) assert.ok(typeof out.value === "number" && Number.isFinite(out.value), `${key} ${String(value)}`);
      else assert.equal(typeof out.skip, "string", `${key} ${String(value)}`);
    }
  }
});

test("11. extractabilityCode: no entry or another shape or kind is source_metric_unsupported; parameters the entry refuses are parameters_unsupported", () => {
  const base = { sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: "more.complementary_data.power.distance", valueShape: "zone_distance", parameterKind: "zone_bounds" };
  assert.equal(extractabilityCode({ ...base, sourceParameters: zone(25, 60) }), null);
  assert.equal(extractabilityCode({ ...base, sourceParameters: zone(75, null) }), "parameters_unsupported");
  assert.equal(extractabilityCode({ ...base, apiFamily: "api", sourceParameters: zone(25, 60) }), "source_metric_unsupported");
  assert.equal(extractabilityCode({ ...base, valueShape: "number", sourceParameters: zone(25, 60) }), "source_metric_unsupported", "a later revision of another shape");
  assert.equal(extractabilityCode({ ...base, parameterKind: "event_threshold", sourceParameters: zone(25, 60) }), "source_metric_unsupported", "a later revision of another kind");
  assert.equal(extractabilityCode({ sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: "athlete_session.total_time", valueShape: "number", parameterKind: "none", sourceParameters: {} }), null);
  assert.equal(extractabilityCode({ sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: "athlete_session.total_time", valueShape: "unit_value_object", parameterKind: "none", sourceParameters: {} }), "source_metric_unsupported");
});

test("12. the test seam: it serves only a synthetic \"<suite>.test.<id>\" key, never a seeded one, and it is unset again", () => {
  const synthetic = Object.freeze({ key: "s", valueShape: null, parameterKind: null, zone: null, direction: null, checkParameters: () => null, extract: () => ({ skip: "x" }) });
  try {
    setExtractorFallbackForTests(() => synthetic);
    assert.equal(extractorFor({ sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: "m2.test.f1a2b" }), synthetic);
    assert.equal(extractorFor({ sourceSystem: "gpexe", apiFamily: "api", sourceMetricKey: "v48.test.f00" }), synthetic);
    assert.equal(extractorFor({ sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: "athlete_session.total_time" }), G("athlete_session.total_time"), "a seeded key is the registry's");
    for (const k of ["athlete_session.unknown", "test.f1", "m2.testf1", "m2.test.", "M2.test.f1"]) {
      assert.equal(extractorFor({ sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: k }), null, k);
    }
    assert.equal(extractabilityCode({ sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: "m2.test.f1", valueShape: "number", parameterKind: "zone_bounds", sourceParameters: zone(1, 2) }), null);
  } finally {
    setExtractorFallbackForTests(null);
  }
  assert.equal(extractorFor({ sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: "m2.test.f1a2b" }), null);
});

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sourceFiles(path.join(dir, d.name)) : d.name.endsWith(".js") ? [path.join(dir, d.name)] : []));
}

test("13. architecture: no module of backend/src sets the test seam; only the registry, today's mapper (until M4) and the adapter's projection name the /more/ zone and event fields; the M2 services check through the registry", () => {
  const files = sourceFiles(SRC);
  const rel = (f) => path.relative(SRC, f).replace(/\\/g, "/");
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    if (rel(f) !== "sourceMetricExtractors.js") assert.doesNotMatch(text, /setExtractorFallbackForTests/, `${rel(f)} sets the test seam`);
    if (/complementary_data|_events_count|_events_threshold_value/.test(text)) {
      assert.ok(["sourceMetricExtractors.js", "gpexeImportMapper.js", "gpexeRestV1Adapter.js"].includes(rel(f)), `${rel(f)} reads a /more/ zone or event field outside the registry`);
    }
  }
  const service = fs.readFileSync(path.join(SRC, "sourceMetricMappingService.js"), "utf8");
  assert.match(service, /import \{ extractabilityCode, extractorFor \} from "\.\/sourceMetricExtractors\.js";/);
  assert.equal((service.match(/assertExtractable\(/g) || []).length, 3, "the definition, T4 create and A1");
  const fieldsService = fs.readFileSync(path.join(SRC, "sourceFieldVerificationService.js"), "utf8");
  assert.match(fieldsService, /extractorAvailable: extractorFor\(/);
  assert.match(service, /extractorAvailable: extractorFor\(/);
});

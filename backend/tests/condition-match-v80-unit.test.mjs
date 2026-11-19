// v80 step B (docs/ai/v80-condition-match-plan.md): the pure core of matching a column without parameters to a variable
// with a condition - which team setting gives a GPEXE details column its range (conditionRuleFor), that range from a
// session's team threshold set (sourceRangeOf), the exact comparison with a stored condition (conditionMatches), the
// importer's check of a session against an activation's match (sameSourceRange, buildGpexeImportPlan, classifyMappedPlan).
// No database, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultThresholds, makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { activationRowFor, SPEC_REGISTRY } from "./support/gpexe-legacy-specs.mjs";
import {
  conditionMatches, conditionRuleFor, needsEventConfirmation, rangeWords, sameSourceRange, sourceRangeOf, storedRule,
} from "../src/sourceConditionRules.js";
import { ruleFits, settingMismatchText } from "../src/sourceConditionMatch.js";
import { buildGpexeImportPlan, classifyMappedPlan, mappedMetricSpecs } from "../src/gpexeImportMapper.js";

const T = defaultThresholds(980); // power [20, 25, 60, 75] W/kg, speed [5.5, 7] m/s, events +-2.5 m/s2 for 0.3 s, id 1473
const KMH = { scale: "3.6", divisor: "1", offset: "0" };

test("1. conditionRuleFor: a numbered power or speed zone column of details (distance, time or events) and the two event columns have a rule; every other key none", () => {
  assert.deepEqual(conditionRuleFor("details.players.athletesessionpowerzone_distance_3"), { kind: "zone", family: "power", zone: 3 });
  assert.deepEqual(conditionRuleFor("details.players.athletesessionspeedzone_time_12"), { kind: "zone", family: "speed", zone: 12 });
  assert.deepEqual(conditionRuleFor("details.players.athletesessionpowerzone_events_1"), { kind: "zone", family: "power", zone: 1 });
  assert.deepEqual(conditionRuleFor("details.players.acceleration_events"), { kind: "event", event: "acceleration" });
  assert.deepEqual(conditionRuleFor("details.players.deceleration_events"), { kind: "event", event: "deceleration" });
  for (const none of [
    "details.players.athletesessionpowerzone_distance_0", "details.players.athletesessionpowerzone_distance_123",
    "details.players.athletesessionheartzone_distance_2", "details.players.tot_burst_events", "athlete_session.acceleration_events",
    "more.events.acceleration_events_count", "details.players.athletesessionpowerzone_distance_3x", "", null, undefined,
  ]) assert.equal(conditionRuleFor(none), null, String(none));
  assert.deepEqual(Object.keys(storedRule({ kind: "zone", family: "power", zone: 3 })), ["family", "kind", "zone"]);
  assert.deepEqual(Object.keys(storedRule({ kind: "event", event: "acceleration" })), ["event", "kind"]);
  assert.deepEqual([needsEventConfirmation({ kind: "event", event: "acceleration" }), needsEventConfirmation({ kind: "zone" }), needsEventConfirmation(null)], [true, false, false]);
});

test("2. sourceRangeOf: zone 1 from 0, each zone from its limit to the next, the top zone the last limit and above; an event the setting with its duration; null for what the set does not carry", () => {
  const zone = (family, n) => sourceRangeOf({ kind: "zone", family, zone: n }, T);
  assert.deepEqual(zone("power", 1), { range: { max: "20", min: "0", operator: "between", unit: "W/kg" }, setId: "1473" });
  assert.deepEqual(zone("power", 3).range, { max: "60", min: "25", operator: "between", unit: "W/kg" });
  assert.deepEqual(zone("power", 5).range, { operator: ">=", unit: "W/kg", value: "75" });
  assert.equal(zone("power", 6), null, "past the top zone");
  assert.deepEqual(zone("speed", 2).range, { max: "7", min: "5.5", operator: "between", unit: "m/s" });
  assert.deepEqual(zone("speed", 3).range, { operator: ">=", unit: "m/s", value: "7" });
  assert.deepEqual(sourceRangeOf({ kind: "event", event: "acceleration" }, T),
    { range: { duration_seconds: "0.3", operator: ">=", unit: "m/s2", value: "2.5" }, setId: "1473" });
  assert.deepEqual(sourceRangeOf({ kind: "event", event: "deceleration" }, T).range, { duration_seconds: "0.3", operator: "<=", unit: "m/s2", value: "-2.5" });
  // Unsorted limits are read sorted; a zone of no width, a missing list, a missing set, a missing event setting: null.
  assert.deepEqual(sourceRangeOf({ kind: "zone", family: "power", zone: 2 }, { ...T, power_thresholds: [75, 20, 60, 25] }).range, { max: "25", min: "20", operator: "between", unit: "W/kg" });
  assert.equal(sourceRangeOf({ kind: "zone", family: "power", zone: 2 }, { ...T, power_thresholds: [20, 20, 60] }), null);
  assert.equal(sourceRangeOf({ kind: "zone", family: "power", zone: 1 }, { ...T, power_thresholds: [] }), null);
  assert.equal(sourceRangeOf({ kind: "zone", family: "power", zone: 1 }, { ...T, power_thresholds: [20, "25"] }), null);
  assert.equal(sourceRangeOf({ kind: "zone", family: "power", zone: 1 }, null), null);
  assert.equal(sourceRangeOf({ kind: "event", event: "acceleration" }, { ...T, acceleration_events_duration: null }), null);
  assert.equal(sourceRangeOf({ kind: "event", event: "acceleration" }, { ...T, acceleration_events_duration: -1 }), null);
  // No set id: the range, with setId null (the match refuses it as team_setting_missing).
  assert.equal(sourceRangeOf({ kind: "zone", family: "power", zone: 3 }, { ...T, id: undefined }).setId, null);
  // GPEXE's double as its shortest decimal.
  assert.deepEqual(sourceRangeOf({ kind: "event", event: "acceleration" }, { ...T, acceleration_events_threshold: 0.1 + 0.2 }).range.value, "0.30000000000000004");
});

test("3. conditionMatches: exact - every limit, the operator and the duration equal, no tolerance; another unit only through the conversion given", () => {
  const zone3 = sourceRangeOf({ kind: "zone", family: "power", zone: 3 }, T).range;
  assert.equal(conditionMatches({ operator: "between", min: 25, max: 60, unit: "W/kg" }, zone3), true);
  assert.equal(conditionMatches({ operator: "between", min: "25.0", max: "60.00", unit: "W/kg" }, zone3), true, "the same decimal written longer");
  assert.equal(conditionMatches({ operator: "between", min: 25, max: 60.000001, unit: "W/kg" }, zone3), false, "no tolerance");
  assert.equal(conditionMatches({ operator: "between", min: 20, max: 60, unit: "W/kg" }, zone3), false);
  assert.equal(conditionMatches({ operator: ">=", value: 25, unit: "W/kg" }, zone3), false, "another operator");
  assert.equal(conditionMatches({ operator: "between", min: 25, max: 60, unit: "W/kg", extra: 1 }, zone3), false, "another shape");
  // The top zone.
  const top = sourceRangeOf({ kind: "zone", family: "power", zone: 5 }, T).range;
  assert.equal(conditionMatches({ operator: ">=", value: 75, unit: "W/kg" }, top), true);
  assert.equal(conditionMatches({ operator: ">=", value: 74.9, unit: "W/kg" }, top), false);
  // Speed: the variable in km/h, GPEXE's limits in m/s; 7 m/s = 25.2 km/h, 5.5 m/s = 19.8 km/h.
  const speed2 = sourceRangeOf({ kind: "zone", family: "speed", zone: 2 }, T).range;
  assert.equal(conditionMatches({ operator: "between", min: "19.8", max: "25.2", unit: "km/h" }, speed2, KMH), true);
  assert.equal(conditionMatches({ operator: "between", min: "19.8", max: "25.2", unit: "km/h" }, speed2, null), false, "no conversion: never a match");
  assert.equal(conditionMatches({ operator: "between", min: "19.8", max: "25.3", unit: "km/h" }, speed2, KMH), false);
  // Events: the threshold and the duration exactly (the owner's case: 0.3 against 0.5).
  const acc = sourceRangeOf({ kind: "event", event: "acceleration" }, T).range;
  assert.equal(conditionMatches({ operator: ">=", value: "2.5", duration_seconds: "0.3", unit: "m/s2" }, acc), true);
  assert.equal(conditionMatches({ operator: ">=", value: "2.5", duration_seconds: "0.5", unit: "m/s2" }, acc), false, "0.3 s is not 0.5 s");
  assert.equal(conditionMatches({ operator: ">=", value: "3", duration_seconds: "0.3", unit: "m/s2" }, acc), false);
  assert.equal(conditionMatches({ operator: "<=", value: "2.5", duration_seconds: "0.3", unit: "m/s2" }, acc), false);
  assert.equal(conditionMatches({ operator: ">=", value: "2.5", unit: "m/s2" }, acc), false, "an event condition carries its duration");
  const dec = sourceRangeOf({ kind: "event", event: "deceleration" }, T).range;
  assert.equal(conditionMatches({ operator: "<=", value: "-2.5", duration_seconds: "0.3", unit: "m/s2" }, dec), true);
  // Nothing to compare.
  assert.equal(conditionMatches(null, zone3), false);
  assert.equal(conditionMatches({ operator: "between", min: 25, max: 60, unit: "W/kg" }, null), false);
});

test("4. ruleFits mirrors the database's condition_rule_fits: a zone rule a zone condition, an acceleration rule a '>=' event, a deceleration rule a '<=' one", () => {
  const zone = { kind: "zone", family: "power", zone: 3 };
  const acc = { kind: "event", event: "acceleration" };
  const dec = { kind: "event", event: "deceleration" };
  const between = { operator: "between", min: 25, max: 60, unit: "W/kg" };
  const atLeast = { operator: ">=", value: 75, unit: "W/kg" };
  const evUp = { operator: ">=", value: 2.5, duration_seconds: 0.3, unit: "m/s2" };
  const evDown = { operator: "<=", value: -2.5, duration_seconds: 0.3, unit: "m/s2" };
  assert.deepEqual([ruleFits(zone, between), ruleFits(zone, atLeast), ruleFits(zone, evUp)], [true, true, false]);
  assert.deepEqual([ruleFits(acc, evUp), ruleFits(acc, evDown), ruleFits(acc, atLeast)], [true, false, false]);
  assert.deepEqual([ruleFits(dec, evDown), ruleFits(dec, evUp)], [true, false]);
  assert.deepEqual([ruleFits(null, between), ruleFits(zone, null), ruleFits({ kind: "other" }, between)], [false, false, false]);
});

test("5. the plain words name both settings, never an id", () => {
  const zone3 = sourceRangeOf({ kind: "zone", family: "power", zone: 3 }, T).range;
  assert.equal(rangeWords(zone3), "the zone 25–60 W/kg");
  assert.equal(rangeWords(sourceRangeOf({ kind: "zone", family: "power", zone: 5 }, T).range), "the zone 75 W/kg and above");
  assert.equal(rangeWords(sourceRangeOf({ kind: "event", event: "acceleration" }, T).range), "events at or above 2.5 m/s² lasting 0.3 s");
  assert.equal(rangeWords(null), "no setting");
  const text = settingMismatchText("High-intensity accelerations", sourceRangeOf({ kind: "event", event: "acceleration" }, T).range,
    { operator: ">=", value: "2.5", duration_seconds: "0.5", unit: "m/s2" }, "First Team");
  assert.equal(text, "This column counts events at or above 2.5 m/s² lasting 0.3 s (First Team's setting in GPEXE); High-intensity accelerations counts events at or above 2.5 m/s² lasting 0.5 s. Choose a variable with the same setting, or change the team's setting in GPEXE.");
  assert.ok(!/1473|980/.test(text));
});

test("6. sameSourceRange: the same keys and every value equal as exact decimals", () => {
  const a = { duration_seconds: "0.3", operator: ">=", unit: "m/s2", value: "2.5" };
  assert.equal(sameSourceRange(a, { ...a, value: "2.50" }), true);
  assert.equal(sameSourceRange(a, { ...a, duration_seconds: "0.5" }), false);
  assert.equal(sameSourceRange(a, { ...a, operator: "<=" }), false);
  assert.equal(sameSourceRange(a, { ...a, unit: "m/s" }), false);
  assert.equal(sameSourceRange(a, { operator: ">=", unit: "m/s2", value: "2.5" }), false, "another shape");
  assert.equal(sameSourceRange(null, a), false);
  assert.equal(sameSourceRange(a, null), false);
});

// The importer: one activation of a column matched through the team's setting; the session's set equal or not.
const KEYS = Object.keys(SPEC_REGISTRY);
const MATCHED = { max: "60", min: "25", operator: "between", unit: "W/kg" };
function specsWith(override) {
  const rows = KEYS.map((k, i) => activationRowFor(k, {}, i));
  rows[0] = { ...rows[0], conditionRule: { family: "power", kind: "zone", zone: 3 }, matchedSourceRange: MATCHED, ...override };
  const out = mappedMetricSpecs(rows);
  assert.equal(out.block, null, out.blockReason);
  return { specs: out.specs, activationId: rows[0].activationId };
}
const planOf = (specs, thresholds) => buildGpexeImportPlan(makeBundle({ athletes: standardAthletes(), ...(thresholds ? { thresholds } : {}) }), { metricSpecs: specs, teamTimezone: "Europe/Sarajevo" });

test("7. the importer: a session whose team setting is the one the column was matched with imports as before; any other blocks the whole candidate (team_setting_changed) first, naming the activation", () => {
  const { specs, activationId } = specsWith();
  assert.equal(specs[0].conditionRule.zone, 3);
  const same = planOf(specs);
  assert.equal(same.settingChanged, undefined, "nothing on a plan whose settings agree");
  const before = classifyMappedPlan(same, { importableIds: [], activationCount: specs.length });
  assert.notEqual(before.block, "team_setting_changed");
  // The team's zone 3 changed in GPEXE: 25-65 W/kg.
  const changed = planOf(specs, { ...defaultThresholds(77), power_thresholds: [20, 25, 65, 75] });
  assert.deepEqual(changed.settingChanged, [{ activationId, current: { max: "65", min: "25", operator: "between", unit: "W/kg" }, matched: MATCHED }]);
  assert.deepEqual(classifyMappedPlan(changed, { importableIds: [], activationCount: specs.length }), { block: "team_setting_changed", activationId });
  // Fewer limits make zone 3 the top zone (25 W/kg and above): another range, blocked.
  const fewer = planOf(specs, { ...defaultThresholds(77), power_thresholds: [20, 25] });
  assert.deepEqual(fewer.settingChanged[0].current, { operator: ">=", unit: "W/kg", value: "25" });
  assert.equal(classifyMappedPlan(fewer, { importableIds: [], activationCount: specs.length }).block, "team_setting_changed");
  // A set that no longer carries the zone: blocked too (a set with no limits at all is refused earlier, as before v80:
  // thresholds_payload_incomplete).
  for (const thresholds of [{ ...defaultThresholds(77), power_thresholds: [20] }]) {
    const plan = planOf(specs, thresholds);
    assert.equal(plan.settingChanged?.[0]?.current ?? null, null);
    assert.equal(classifyMappedPlan(plan, { importableIds: [], activationCount: specs.length }).block, "team_setting_changed");
  }
  // An activation without a rule never takes part in the check.
  const { specs: plain } = specsWith({ conditionRule: null, matchedSourceRange: null });
  assert.equal(planOf(plain, { ...defaultThresholds(77), power_thresholds: [20, 25, 65, 75] }).settingChanged, undefined);
});

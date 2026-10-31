// Phase 7e - the aggregate preview's pure part (backend/src/sourceMetricPreview.js)
// and the mapper seam it reads through (gpexeLevelValues in
// backend/src/gpexeImportMapper.js). Contract: docs/ai/phase7e-aggregate-preview-contract.md
// (J11), sections 3-5 and 8. Pure: no database, no network. The route, the
// scope and the order of answers are source-metric-preview-7e.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GPEXE_METRIC_SPECS, GpexeMappingError, buildGpexeImportPlan, gpexeLevelValues } from "../src/gpexeImportMapper.js";
import { extractorFor } from "../src/sourceMetricExtractors.js";
import { PREVIEW_MINIMUM_ATHLETES, STORAGE_SCALE, convertAtStorageScale, previewLevel } from "../src/sourceMetricPreview.js";
import { PLANTED, previewAthletes, previewBundle } from "./support/preview-bundles.mjs";

const G = (sourceMetricKey) => extractorFor({ sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey });
// The version's stored source parameters (what M2 derives and v34 stores).
const zone = (lower, upper, operator = upper === null ? ">=" : "between", unit = "W/kg") => ({ lower, operator, unit, upper });
const threshold = (thresholdValue, durationSeconds, operator, unit = "m/s2") => ({ duration_seconds: durationSeconds, operator, threshold_value: thresholdValue, unit });
const IDENTITY = { scale: "1", divisor: "1", offset: "0" };
const S_TO_MIN = { scale: "1", divisor: "60", offset: "0" };
const MS_TO_KMH = { scale: "3.6", divisor: "1", offset: "0" };
const KMH_TO_MS = { scale: "1", divisor: "3.6", offset: "0" };

test("1. the constants: the minimum count is 3 (OD3) and the storage scale 9 (D8)", () => {
  assert.equal(PREVIEW_MINIMUM_ATHLETES, 3);
  assert.equal(STORAGE_SCALE, 9);
});

test("2. the conversion (D8): (source x scale + offset x divisor) / divisor, exact, rounded once to 9 decimals half away from zero; the seeded conversions; a tie at the 10th place; negatives; an offset; a number with an exponent", () => {
  const cases = [
    ["4567.5", S_TO_MIN, "76.125"],
    ["60.00000003", S_TO_MIN, "1.000000001"], // 1.0000000005: a tie, away from zero (half-even would give 1)
    ["30.00000003", S_TO_MIN, "0.500000001"], // 0.5000000005 (binary floating point gives 0.5000000004999999)
    ["0.00000003", S_TO_MIN, "0.000000001"], // 0.0000000005
    ["-30.00000003", S_TO_MIN, "-0.500000001"], // the mirror: away from zero
    ["0.00000002", S_TO_MIN, "0"], // 0.000000000333...
    ["-0.00000001", S_TO_MIN, "0"], // no negative zero
    ["1800", S_TO_MIN, "30"],
    ["1.000000001", MS_TO_KMH, "3.600000004"], // 3.6000000036
    ["7.12345678912", MS_TO_KMH, "25.644444441"], // 25.644444440832
    ["8.1", MS_TO_KMH, "29.16"],
    ["10", KMH_TO_MS, "2.777777778"],
    ["-10", KMH_TO_MS, "-2.777777778"],
    ["1", { scale: "1", divisor: "1", offset: "-273.15" }, "-272.15"],
    ["2", { scale: "1", divisor: "3", offset: "0.5" }, "1.166666667"], // (2 + 1.5) / 3
    [2e-7, S_TO_MIN, "0.000000003"], // 0.00000000333...
    [0, S_TO_MIN, "0"],
    ["123456789.123456789", IDENTITY, "123456789.123456789"],
    ["1.0000000005", IDENTITY, "1.000000001"],
    ["-1.0000000005", IDENTITY, "-1.000000001"],
    ["1.00000000049999", IDENTITY, "1"],
  ];
  for (const [source, factors, expected] of cases) assert.equal(convertAtStorageScale(source, factors), expected, `${source} with ${JSON.stringify(factors)}`);
  assert.throws(() => convertAtStorageScale("x", IDENTITY));
  assert.throws(() => convertAtStorageScale("1", { scale: "1", divisor: "0", offset: "0" }));
});

test("3. one level: an athlete counts once whatever the number of its values; min and max over every value, compared as decimals; below the minimum only the count; the conversion of min and max only", () => {
  // Two athletes with a value (the third has none): the count only.
  assert.deepEqual(previewLevel([[5], [], [7, 9]], IDENTITY), { athletesWithValue: 2, min: null, max: null, minCanonical: null, maxCanonical: null });
  // Three athletes, one with three values (drills): counted once.
  assert.deepEqual(previewLevel([[30.00000003, 1800, 45], [1200], [], [600]], S_TO_MIN),
    { athletesWithValue: 3, min: "30.00000003", max: "1800", minCanonical: "0.500000001", maxCanonical: "30" });
  // Exactly the minimum.
  assert.deepEqual(previewLevel([[1], [2], [3]], IDENTITY), { athletesWithValue: 3, min: "1", max: "3", minCanonical: "1", maxCanonical: "3" });
  // Nobody: 0, an answer.
  assert.deepEqual(previewLevel([[], []], IDENTITY), { athletesWithValue: 0, min: null, max: null, minCanonical: null, maxCanonical: null });
  assert.deepEqual(previewLevel([], IDENTITY), { athletesWithValue: 0, min: null, max: null, minCanonical: null, maxCanonical: null });
  // Negatives and decimal order (never the text order: "10" < "9" as text).
  assert.deepEqual(previewLevel([[9], [10], [-2.5]], IDENTITY), { athletesWithValue: 3, min: "-2.5", max: "10", minCanonical: "-2.5", maxCanonical: "10" });
  // A value that is not a decimal fails closed.
  assert.throws(() => previewLevel([[1], [2], [Number.NaN]], IDENTITY));
});

// Today's specs with their own bounds as a version's stored parameters, and
// the spec's own conversion of the raw value (J12's characterisation).
const SPECS = {
  gpexe_time_min: ["athlete_session.total_time", {}, (raw) => raw / 60],
  gpexe_total_distance: ["athlete_session.total_distance", {}, (raw) => raw],
  gpexe_power_zone_25_60_distance: ["more.complementary_data.power.distance", zone("25", "60"), (raw) => raw],
  gpexe_power_zone_60_75_distance: ["more.complementary_data.power.distance", zone("60", "75"), (raw) => raw],
  gpexe_power_zone_75_plus_distance: ["more.complementary_data.power.distance.open_top", zone("75", null), (raw) => raw],
  gpexe_acceleration_events: ["more.events.acceleration_events_count", threshold("2.5", "0.3", ">="), (raw) => raw],
  gpexe_deceleration_events: ["more.events.deceleration_events_count", threshold("-2.5", "0.3", "<="), (raw) => raw],
  gpexe_sprint_distance_7mps: ["more.complementary_data.speed.distance", zone("7", null, ">=", "m/s"), (raw) => raw],
  gpexe_burst_events: ["details.players.tot_burst_events", {}, (raw) => raw],
  gpexe_brake_events: ["details.players.tot_brake_events", {}, (raw) => raw],
  gpexe_max_speed: ["athlete_session.max_v", {}, (raw) => raw * 3.6],
};

test("4. gpexeLevelValues against today's import: for every spec with its own bounds, the same athletes (the multi-track athlete left out), the same values at each level (the spec's own unit arithmetic undone), the session row once and every drill row; nothing but the values comes back", () => {
  assert.deepEqual(Object.keys(SPECS).sort(), GPEXE_METRIC_SPECS.map((s) => s.key).sort());
  const bundle = previewBundle({ gpexeTeamId: 970001 });
  const today = buildGpexeImportPlan(bundle);
  assert.deepEqual(today.participants.map((p) => p.gpexeAthleteId), ["01", "02", "03"].map((n) => `${PLANTED.athletePrefix}${n}`));
  const todayAt = (participant, level, specKey) => participant.results.filter((x) => x.level === level).flatMap((x) => x.values.filter((v) => v.metricKey === specKey).map((v) => v.value));
  for (const [specKey, [key, params, convert]] of Object.entries(SPECS)) {
    const out = gpexeLevelValues(bundle, (input) => G(key).extract(input, params));
    assert.equal(out.code, null, specKey);
    assert.deepEqual(Object.keys(out).sort(), ["athletes", "code"]);
    assert.equal(out.athletes.length, today.participants.length, specKey);
    out.athletes.forEach((athlete, i) => {
      assert.deepEqual(Object.keys(athlete).sort(), ["drill", "session"], "no id, no row, no skip");
      for (const [level, ours] of [["full", athlete.session], ["drill", athlete.drill]]) {
        assert.deepEqual(ours.map(convert), todayAt(today.participants[i], level, specKey), `${specKey} athlete ${i} ${level}`);
      }
    });
  }
  // Athlete 1 has two drills, 2 and 3 one each: four drill values of three athletes.
  const time = gpexeLevelValues(bundle, (input) => G("athlete_session.total_time").extract(input, {}));
  assert.deepEqual(time.athletes.map((a) => [a.session.length, a.drill.length]), [[1, 2], [1, 1], [1, 1]]);
  assert.deepEqual(previewLevel(time.athletes.map((a) => a.drill), S_TO_MIN).athletesWithValue, 3);
  // The extractor gets the plan's own per-row input and nothing else.
  const seen = [];
  gpexeLevelValues(bundle, (input) => { seen.push(Object.keys(input).sort().join(",")); return { skip: "x" }; });
  assert.deepEqual([...new Set(seen)], ["more,playerDetails,row,thresholds"]);
  assert.equal(seen.length, 7, "three whole-session rows and four drill rows");
});

test("5. a refusal of the whole session returns its stable code and nothing else (no message, no anomaly, no id); an error that is not the mapper's is thrown", () => {
  const cases = [
    [previewBundle({ gpexeTeamId: 970001, category: "MATCH" }), "unsupported_category"],
    [Object.assign(previewBundle({ gpexeTeamId: 970001 }), { teamSession: undefined }), "session_missing"],
    [(() => { const b = previewBundle({ gpexeTeamId: 970001 }); b.teamSession.is_stats_valid = false; return b; })(), "session_stats_invalid"],
    [previewBundle({ gpexeTeamId: 970001, athletes: previewAthletes().slice(3) }), "no_importable_participants"],
    [previewBundle({ gpexeTeamId: 970001, thresholds: { team: 1, id: 5 } }), "thresholds_wrong_team"],
  ];
  for (const [bundle, code] of cases) {
    const out = gpexeLevelValues(bundle, () => ({ value: 1 }));
    assert.deepEqual(out, { code }, code);
    assert.throws(() => buildGpexeImportPlan(bundle), (e) => e instanceof GpexeMappingError && e.code === code && e.message.length > 0, code);
  }
  // Why only the code crosses: the plan's own message names the session.
  assert.throws(() => buildGpexeImportPlan(cases[0][0]), (e) => e.message.includes(String(PLANTED.sessionId)));
  assert.throws(() => gpexeLevelValues(previewBundle({ gpexeTeamId: 970001 }), () => { throw new Error("boom"); }), /boom/);
});

test("6. the whole preview of a session level in memory: athlete 1's values round at the 10th place, in both directions of the seeded conversions", () => {
  const bundle = previewBundle({ gpexeTeamId: 970001 });
  const at = (key, params, level) => gpexeLevelValues(bundle, (input) => G(key).extract(input, params)).athletes.map((a) => a[level]);
  assert.deepEqual(previewLevel(at("athlete_session.total_time", {}, "session"), S_TO_MIN),
    { athletesWithValue: 3, min: "60.00000003", max: "1800", minCanonical: "1.000000001", maxCanonical: "30" });
  assert.deepEqual(previewLevel(at("athlete_session.total_time", {}, "drill"), S_TO_MIN),
    { athletesWithValue: 3, min: "30.00000003", max: "1800", minCanonical: "0.500000001", maxCanonical: "30" });
  assert.deepEqual(previewLevel(at("athlete_session.max_v", {}, "session"), MS_TO_KMH),
    { athletesWithValue: 3, min: "1.000000001", max: "8.1", minCanonical: "3.600000004", maxCanonical: "29.16" });
  // Two athletes the import keeps: the count only.
  const two = previewBundle({ gpexeTeamId: 970001, athletes: [previewAthletes()[0], previewAthletes()[1], previewAthletes()[3]] });
  assert.deepEqual(previewLevel(gpexeLevelValues(two, (input) => G("athlete_session.total_time").extract(input, {})).athletes.map((a) => a.session), S_TO_MIN),
    { athletesWithValue: 2, min: null, max: null, minCanonical: null, maxCanonical: null });
});

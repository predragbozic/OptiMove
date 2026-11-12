// J18, slice 18-2 - the pure part of the board (backend/src/sourceMetricBoard.js):
// the display registry (R5), the pair rule (C117, section 6.1) and the
// placement hash (section 4.2). No database, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISPLAY_REGISTRY_VERSION, PAIR_LIMIT, displayRuleFor, displayValue, distinctPair, placementHash, rankPairs, roundDecimal,
  setDisplayRuleFallbackForTests,
} from "../src/sourceMetricBoard.js";

const rule = (key, sourceUnit) => displayRuleFor({ sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: key, sourceUnit });

test("roundDecimal: exact decimal text, half away from zero, always the asked number of decimals", () => {
  assert.deepEqual(
    [["1.25", 1], ["1.24", 1], ["-1.25", 1], ["0.04", 1], ["-0.04", 1], ["59.5", 0], ["59.49", 0], ["7", 2], ["0.995", 2], ["12345678901234567890.05", 1]].map(([t, p]) => roundDecimal(t, p)),
    ["1.3", "1.2", "-1.3", "0.0", "0.0", "60", "59", "7.00", "1.00", "12345678901234567890.1"]);
  assert.throws(() => roundDecimal("abc", 1));
});

test("the display registry: three columns, each only in its proven unit; what the GPEXE screen shows", () => {
  assert.equal(DISPLAY_REGISTRY_VERSION, 1);
  const time = rule("athlete_session.total_time", "s");
  const dist = rule("athlete_session.total_distance", "m");
  const speed = rule("athlete_session.max_v", "m/s");
  assert.deepEqual([time.rule, time.units, dist.rule, dist.units, speed.rule, speed.units], ["duration_mmss", ["mm:ss"], "distance_m", ["m"], "speed_kmh", ["km/h"]]);
  assert.deepEqual([displayValue(time, "mm:ss", "5790"), displayValue(time, "mm:ss", "5789.5"), displayValue(time, "mm:ss", "59.4"), displayValue(time, "mm:ss", "0")], ["96:30", "96:30", "0:59", "0:00"]);
  assert.equal(displayValue(time, "mm:ss", "-5"), null, "a negative duration is not shown");
  assert.deepEqual([displayValue(dist, "m", "3100"), displayValue(dist, "m", "3100.04"), displayValue(dist, "m", "3100.05")], ["3100.0", "3100.0", "3100.1"]);
  assert.deepEqual([displayValue(speed, "km/h", "8.6111"), displayValue(speed, "km/h", "6.2"), displayValue(speed, "km/h", "1.000000001")], ["31.0", "22.3", "3.6"]);
  // Another unit of the rule, another proven unit, an unknown column, another family: nothing.
  assert.equal(displayValue(time, "s", "5790"), null);
  assert.equal(displayValue(null, "mm:ss", "5790"), null);
  assert.equal(rule("athlete_session.total_time", "min"), null);
  assert.equal(rule("athlete_session.total_time", null), null);
  assert.equal(rule("athlete_session.average_v", "m/s"), null);
  assert.equal(rule("__proto__", "s"), null);
  assert.equal(displayRuleFor({ sourceSystem: "gpexe", apiFamily: "api", sourceMetricKey: "athlete_session.total_time", sourceUnit: "s" }), null);
});

test("the test seam serves only a synthetic key, only a rule of the registry and only in that rule's unit", () => {
  setDisplayRuleFallbackForTests(() => "duration_mmss");
  try {
    assert.equal(rule("suite.test.time.f1", "s").rule, "duration_mmss");
    assert.equal(rule("suite.test.time.f1", "m"), null, "the rule's own unit still decides");
    assert.equal(rule("athlete_session.average_v", "s"), null, "a real key never reaches the seam");
    setDisplayRuleFallbackForTests(() => "no_such_rule");
    assert.equal(rule("suite.test.time.f1", "s"), null);
  } finally {
    setDisplayRuleFallbackForTests(null);
  }
  assert.equal(rule("suite.test.time.f1", "s"), null, "off again");
});

test("distinctPair: both values there, non-zero and different, compared as decimals", () => {
  assert.deepEqual([distinctPair("1", "2"), distinctPair("1.0", "1"), distinctPair("0", "2"), distinctPair("2", "0.000"), distinctPair(null, "2"), distinctPair("2", null), distinctPair("60.00000003", "60.00000004")],
    [true, false, false, false, false, false, true]);
});

test("rankPairs: named athletes only, the pair that proves most columns first, ties by the internal key, pairs that prove nothing left out, deterministic and bounded", () => {
  const athlete = (key, named, values) => ({ key, named, values: new Map(Object.entries(values)) });
  const athletes = [
    athlete("10", true, { t: "100", d: "5" }),
    athlete("9", true, { t: "100", d: "6" }),
    athlete("11", true, { t: "200", d: "7" }),
    athlete("2", false, { t: "999", d: "999" }),
    athlete("12", true, { t: "0", d: null }),
  ];
  const keys = (pairs) => pairs.map((p) => [p.a.key, p.b.key, p.score]);
  const ranked = rankPairs(athletes, ["t", "d"]);
  assert.deepEqual(keys(ranked), [["9", "11", 2], ["10", "11", 2], ["9", "10", 1]], "numeric-looking keys order by length then text; the unnamed and the valueless take no part");
  assert.deepEqual(keys(rankPairs([...athletes].reverse(), ["t", "d"])), keys(ranked), "the input order does not matter");
  assert.deepEqual(rankPairs(athletes, []), [], "no placeable column: no pair");
  assert.deepEqual(rankPairs(athletes.slice(0, 1), ["t"]), []);
  const many = Array.from({ length: 30 }, (_, i) => athlete(String(100 + i), true, { t: String(i + 1) }));
  assert.equal(rankPairs(many, ["t"]).length, PAIR_LIMIT, "435 possible pairs, 200 offered");
});

test("placementHash: stable, and different for every part the admin saw", () => {
  const base = { bundleHash: "b", pairIndex: 0, revisionId: "r", targetVersionId: "t", mappingVersionId: null, conversion: "1/60+0", displayRule: "duration_mmss", displayUnit: "mm:ss", rawA: "1200", storedA: "20", rawB: "1800", storedB: "30" };
  const h = placementHash(base);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(placementHash({ ...base }), h);
  const changed = { bundleHash: "c", pairIndex: 1, revisionId: "s", targetVersionId: "u", mappingVersionId: "m", conversion: "same", displayRule: "distance_m", displayUnit: "m", rawA: "1201", storedA: "20.01", rawB: "1801", storedB: "30.01" };
  const seen = new Set([h]);
  for (const [name, value] of Object.entries(changed)) {
    const other = placementHash({ ...base, [name]: value });
    assert.equal(seen.has(other), false, `${name} is part of the hash`);
    seen.add(other);
  }
  // Two parts never run together: ("ab","c") is not ("a","bc").
  assert.notEqual(placementHash({ ...base, rawA: "12", storedA: "3" }), placementHash({ ...base, rawA: "1", storedA: "23" }));
});

// The range of a numbered GPEXE zone from the team's limits (frontend/zone-ranges.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { columnSettingText, conditionSentence, eventKindOf, eventSettingText, zoneRangeText } from "../zone-ranges.js";

const power = (values) => ({ power: values, speed: null });

test("a numbered power zone reads from 0, limit to limit, and the top zone 'and above'; speed is shown in km/h", () => {
  const t = power([20, 25, 60, 75]);
  assert.equal(zoneRangeText("athletesessionpowerzone_distance_1", t), "0–20 W/kg");
  assert.equal(zoneRangeText("athletesessionpowerzone_distance_4", t), "60–75 W/kg");
  assert.equal(zoneRangeText("details.players.athletesessionpowerzone_time_5", t), "75 W/kg and above");
  assert.equal(zoneRangeText("athletesessionpowerzone_distance_6", t), null, "past the last zone");
  assert.equal(zoneRangeText("athletesessionspeedzone_distance_2", { power: null, speed: [5.5, 7] }), "19.8–25.2 km/h");
  assert.equal(zoneRangeText("athletesessionpowerzone_distance_2", { power: { differ: true }, speed: null }), null, "limits that differ between teams");
});

test("a zone of no width has no range: two equal limits, or a first limit of 0 (the review of PR #602)", () => {
  const t = power([20, 25, 25, 75]);
  assert.equal(zoneRangeText("athletesessionpowerzone_distance_3", t), null, "25–25 is not a range");
  assert.equal(zoneRangeText("athletesessionpowerzone_distance_2", t), "20–25 W/kg");
  assert.equal(zoneRangeText("athletesessionpowerzone_distance_4", t), "25–75 W/kg");
  assert.equal(zoneRangeText("athletesessionpowerzone_distance_1", power([0, 25])), null, "0–0 is not a range");
  assert.equal(zoneRangeText("athletesessionpowerzone_distance_3", power([0, 25])), "25 W/kg and above");
});

test("v80 step A: an event column shows the team's event setting like a zone's range; a setting that differs or is missing shows nothing", () => {
  const t = { power: [20, 25, 60, 75], speed: null, acceleration: { value: 2.5, duration: 0.3 }, deceleration: { value: -2.5, duration: 0.5 } };
  assert.equal(eventKindOf("details.players.acceleration_events"), "acceleration");
  assert.equal(eventKindOf("deceleration_events"), "deceleration");
  assert.equal(eventKindOf("more.events.acceleration_events_count"), null, "only GPEXE's events value, not the seeded /more/ count");
  assert.equal(eventSettingText("details.players.acceleration_events", t), "Events at or above 2.5 m/s² lasting 0.3 s");
  assert.equal(eventSettingText("details.players.deceleration_events", t), "Events at or below -2.5 m/s² lasting 0.5 s");
  assert.equal(eventSettingText("details.players.acceleration_events", { ...t, acceleration: { differ: true } }), null);
  assert.equal(eventSettingText("details.players.acceleration_events", { power: [1] }), null);
  assert.equal(eventSettingText("details.players.acceleration_events", null), null);
  assert.equal(columnSettingText("details.players.athletesessionpowerzone_distance_3", t), "Zone 25–60 W/kg");
  assert.equal(columnSettingText("details.players.acceleration_events", t), "Events at or above 2.5 m/s² lasting 0.3 s");
  assert.equal(columnSettingText("details.players.total_distance", t), null);
});

test("v80 step A: a variable's condition in plain words, each stored shape; any other shape a general sentence", () => {
  assert.equal(conditionSentence({ kind: "event_threshold", operator: ">=", value: "2.5", durationSeconds: "0.3", unit: "m/s2" }),
    "Counts only events at or above 2.5 m/s² lasting at least 0.3 s.");
  assert.equal(conditionSentence({ kind: "event_threshold", operator: "<=", value: "-2.5", durationSeconds: "0.3", unit: "m/s2" }),
    "Counts only events at or below -2.5 m/s² lasting at least 0.3 s.");
  assert.equal(conditionSentence({ kind: "zone", operator: "between", lower: "25", upper: "60", unit: "W/kg" }), "Counts only the zone 25–60 W/kg.");
  assert.equal(conditionSentence({ kind: "zone", operator: ">=", value: "75", unit: "W/kg" }), "Counts only the zone at or above 75 W/kg.");
  assert.equal(conditionSentence({ kind: "unsupported" }), "Counts only values under a condition.");
  assert.equal(conditionSentence(null), "Counts only values under a condition.");
});

test("v80 step A: a Source fields row of an event value names the team's setting beside it (platform limits only)", async () => {
  const { readableName } = await import("../source-fields-data.js");
  const t = { power: null, speed: null, acceleration: { value: 2.5, duration: 0.3 }, deceleration: { differ: true } };
  assert.equal(readableName({ name: "acceleration_events" }, t), "Acceleration events · at or above 2.5 m/s² lasting 0.3 s");
  assert.equal(readableName({ name: "deceleration_events" }, t), "Deceleration events", "settings that differ between teams: none shown");
  assert.equal(readableName({ name: "acceleration_events" }, null), "Acceleration events", "no limits (not a platform admin): none shown");
});

test("v80 step A (the code review's LOW): a column's team setting and a variable with the same condition use the same words", () => {
  for (const [kind, operator, value] of [["acceleration", ">=", 2.5], ["deceleration", "<=", -2.5]]) {
    const words = eventSettingText(`${kind}_events`, { [kind]: { value, duration: 0.3 } }).replace(/^Events /, "");
    assert.ok(conditionSentence({ kind: "event_threshold", operator, value: String(value), durationSeconds: "0.3", unit: "m/s2" }).includes(`events ${words.split(" lasting")[0]} lasting`), words);
  }
});

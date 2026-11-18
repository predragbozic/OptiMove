// The range of a numbered GPEXE zone from the team's limits (frontend/zone-ranges.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { zoneRangeText } from "../zone-ranges.js";

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

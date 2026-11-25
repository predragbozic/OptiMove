import { test } from "node:test";
import assert from "node:assert/strict";
import { teamAverageReference, radarReferenceAxis, referenceBand } from "../src/dashboardReferences/calculations.js";
const row = (athleteId, value, overrides = {}) => ({ athleteId, value, unit: "m", status: "ok", ...overrides });
const mean = (athleteValues, extra = {}) => teamAverageReference({ rosterAthleteIds: ["a", "b", "c", "d"], athleteValues, unit: "m", ...extra });
test("team average equally weights authorized athlete period values, counts zero, omits absent athletes", () => {
  assert.deepEqual(mean([row("a", 0), row("b", 10), row("c", 20), row("foreign", 1000)]), {
    status: "ok", value: 10, unit: "m", includedAthletes: 3, leftOutAthletes: 1,
  });
});
test("missing, conflicting and incompatible values cannot reach the three-athlete minimum", () => {
  const value = mean([row("a", 0), row("b", null), row("c", 9, { status: "conflict" }), row("d", 2, { unit: "min" })]);
  assert.equal(value.reason, "tooFewAthletes");
  assert.equal(value.includedAthletes, 1);
  assert.equal(value.leftOutAthletes, 3);
});
test("duplicate period rows are refused rather than occasion weighted", () => {
  assert.equal(mean([row("a", 1), row("a", 2), row("b", 3), row("c", 4)]).reason, "duplicateAthlete");
});
test("calculated metrics cannot become a measured team reference", () => {
  assert.equal(mean([row("a", 1), row("b", 2), row("c", 3)], { calculated: true }).reason, "calculatedMetric");
});
test("team average keeps v87 three-decimal precision", () => {
  assert.equal(mean([row("a", 1), row("b", 1), row("c", 2)]).value, 1.333);
});
test("Radar does not clamp values above the chosen positive anchor", () => {
  assert.equal(radarReferenceAxis({ actual: 30, anchor: 10 }).normalized, 300);
});
test("Radar missing or invalid values stay unavailable, zero actual remains zero", () => {
  for (const anchor of [null, 0, -1, Infinity, "10"]) assert.equal(radarReferenceAxis({ actual: 1, anchor }).status, "unavailable");
  for (const actual of [null, -1, NaN, "1"]) assert.equal(radarReferenceAxis({ actual, anchor: 1 }).status, "unavailable");
  assert.equal(radarReferenceAxis({ actual: 0, anchor: 1 }).normalized, 0);
});
test("missing named references do not remove valid references or invent points", () => {
  const result = radarReferenceAxis({ actual: 5, anchor: 10, references: [{ key: "minimum", value: 2 }, { key: "target", value: null }] });
  assert.equal(result.references[0].normalized, 20);
  assert.equal(result.references[1].value, null);
  assert.equal(result.references[1].status, "unavailable");
});
test("a band requires two ordered finite values; zero is a valid endpoint", () => {
  assert.deepEqual(referenceBand(0, 4), { status: "ok", lower: 0, upper: 4 });
  assert.equal(referenceBand(null, 4).status, "unavailable");
  assert.equal(referenceBand(5, 4).reason, "invalidBand");
});

test('reference receipt purge is bounded and optional before the migration',async()=>{
 const {purgeDashboardReferenceRequests}=await import('../src/dashboardReferences/retention.js');
 let calls=[];await purgeDashboardReferenceRequests({query:async sql=>{calls.push(sql);return{rows:[{installed:false}]};}});assert.equal(calls.length,1);
 calls=[];await purgeDashboardReferenceRequests({query:async sql=>{calls.push(sql);return{rows:[sql.includes('to_regprocedure')?{installed:true}:{deleted:100}]};}});assert.equal(calls.length,6);assert.ok(calls.slice(1).every(sql=>sql.includes('cleanup_dashboard_reference_requests(100)')));
 calls=[];await purgeDashboardReferenceRequests({query:async sql=>{calls.push(sql);return{rows:[sql.includes('to_regprocedure')?{installed:true}:{deleted:0}]};}});assert.equal(calls.length,2);
});

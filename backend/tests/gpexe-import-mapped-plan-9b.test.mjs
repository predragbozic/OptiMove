// Phase 9, 9-B (contract J17 sections 3 and 8.2): the pure core of the mapped
// import - the specs of the locked activations (mappedMetricSpecs), the plan
// at the levels each version covers, the exact conversion and the canonical
// range, the classification of the whole candidate (classifyMappedPlan), the
// reasons of the values left out (C110) and the Link athletes helper values
// (R12). No database, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { activationRowFor, LEGACY_SPECS, SPEC_REGISTRY } from "./support/gpexe-legacy-specs.mjs";
import {
  buildGpexeImportPlan, classifyMappedPlan, gpexeLevelValues, leftOutReason, mappedMetricSpecs, wholeRowHelperValues,
} from "../src/gpexeImportMapper.js";
import { canonicalDecimal, EXTRACTORS, SKIP_CATEGORY } from "../src/sourceMetricExtractors.js";
import { convertAtStorageScale } from "../src/sourceMetricPreview.js";

const KEYS = Object.keys(SPEC_REGISTRY);
const allRows = (overrides = {}) => KEYS.map((k, i) => activationRowFor(k, overrides[k] ?? {}, i));
const specsOf = (rows) => {
  const out = mappedMetricSpecs(rows);
  assert.equal(out.block, null, `specs refused: ${out.block} ${out.blockReason}`);
  return out.specs;
};
const bundle = () => makeBundle({ athletes: standardAthletes() });
const valuesOf = (plan) => plan.participants.flatMap((p) => p.results.flatMap((r) => r.values.map((v) => ({ ...v, athlete: p.gpexeAthleteId, level: r.level, drill: r.drillIndex }))));

test("1. mappedMetricSpecs: one frozen spec per row in row order, with the version's factors and the pinned version's range as exact text", () => {
  const rows = allRows({ gpexe_max_speed: { maxValue: "40.000", minValue: "0" } });
  const specs = specsOf(rows);
  assert.equal(specs.length, rows.length);
  assert.deepEqual(specs.map((s) => s.activationId), rows.map((r) => r.activationId));
  const speed = specs.find((s) => s.variableKey === "max_speed");
  assert.deepEqual(speed.factors, { scale: "3.6", divisor: "1", offset: "0" });
  assert.deepEqual(speed.range, { min: "0", max: "40" });
  assert.ok(Object.isFrozen(speed));
  assert.equal(speed.sourceUnit, "m/s");
  assert.equal(speed.unit, "km/h");
});

test("2. mappedMetricSpecs refuses mapping_not_usable for every cause, and source_unit_mismatch for a version unit that is not the revision's", () => {
  const causes = [
    ["requirement", { requirement: "maybe" }],
    ["version_not_active", { versionStatus: "disabled" }],
    ["revision_not_usable", { revisionEvidence: "observed" }],
    ["revision_not_usable", { revisionState: "retired" }],
    ["revision_not_usable", { fieldState: "retired" }],
    ["definition_not_usable", { definitionState: "archived" }],
    ["definition_not_usable", { valueType: "text" }],
    ["definition_version_changed", { definitionCurrentVersionId: "00000000-0000-4000-8000-ffffffffffff" }],
    ["no_level", { appliesToSession: false, appliesToDrill: false }],
    ["no_extractor", { apiFamily: "api" }],
    ["not_extractable", { revisionValueShape: "event_count" }],
    ["not_extractable", { sourceParameters: { lower: "25" } }],
    ["factors", { scale: "x" }],
    ["range", { maxValue: "40x" }],
  ];
  for (const [reason, override] of causes) {
    const key = override.sourceParameters ? "gpexe_power_zone_25_60_distance" : "gpexe_time_min";
    const rows = allRows({ [key]: override });
    assert.deepEqual(mappedMetricSpecs(rows), { block: "mapping_not_usable", blockReason: reason }, reason);
  }
  // Two activations of one canonical variable at one level (D11.7 defence).
  const twice = allRows();
  twice[1] = { ...twice[1], metricDefinitionId: twice[0].metricDefinitionId };
  assert.deepEqual(mappedMetricSpecs(twice), { block: "mapping_not_usable", blockReason: "target_twice" });
  // A session-only and a drill-only activation of one variable are fine.
  const split = allRows();
  split[1] = { ...split[1], metricDefinitionId: split[0].metricDefinitionId, appliesToSession: false };
  split[0] = { ...split[0], appliesToDrill: false };
  assert.equal(mappedMetricSpecs(split).block, null);
  assert.deepEqual(mappedMetricSpecs(allRows({ gpexe_total_distance: { sourceUnit: "km" } })), { block: "source_unit_mismatch", blockReason: "source_unit" });
});

test("3. the plan through the eleven specs equals the frozen pre-9-B oracle: same set, converted exactly, within 1e-9 of the legacy double", () => {
  const specs = specsOf(allRows());
  const b = bundle();
  const plan = buildGpexeImportPlan(b, { metricSpecs: specs });
  const oraclePlan = buildGpexeImportPlan(b, { metricSpecs: LEGACY_SPECS.map((s) => ({ raw: true, key: s.key, levels: { full: true, drill: true }, extract: s.extract })) });
  const oracle = new Map(valuesOf(oraclePlan).map((v) => [`${v.athlete}|${v.level}|${v.drill}|${v.key}`, v.value]));
  const keyOfDefinition = new Map(allRows().map((r, i) => [r.metricDefinitionId, KEYS[i]]));
  const ours = valuesOf(plan);
  assert.equal(ours.length, oracle.size);
  assert.equal(ours.length, 53);
  for (const v of ours) {
    const legacy = oracle.get(`${v.athlete}|${v.level}|${v.drill}|${keyOfDefinition.get(v.metricDefinitionId)}`);
    assert.notEqual(legacy, undefined);
    assert.equal(typeof v.value, "string");
    assert.equal(v.value, canonicalDecimal(v.value), "canonical decimal text");
    const spec = specs.find((s) => s.activationId === v.activationId);
    assert.equal(v.value, convertAtStorageScale(v.sourceValue, spec.factors));
    assert.ok(Math.abs(Number(v.value) - legacy) <= 1e-9, `${v.value} vs ${legacy}`);
  }
  assert.deepEqual(plan.leftOut.map((r) => r.code).sort(), oraclePlan.leftOut.map((r) => r.code).sort(), "the same values left out (burst and brake of drill 1)");
  assert.ok(plan.leftOut.every((r) => r.category === "missing" && r.code === "details_not_fetched"));
  assert.deepEqual(plan.activationSet, allRows().map((r) => [r.activationId, r.mappingVersionId]).sort(([a], [b]) => (a < b ? -1 : 1)));
  assert.equal(plan.metrics, undefined);
  assert.equal(plan.derivedNotImported, undefined);
});

test("4. D2: a level no activation covers produces no result, no identity and no segment; a covered level whose values are all left out keeps its result", () => {
  const sessionOnly = specsOf(allRows(Object.fromEntries(KEYS.map((k) => [k, { appliesToDrill: false }]))));
  const plan = buildGpexeImportPlan(bundle(), { metricSpecs: sessionOnly });
  assert.ok(plan.participants.every((p) => p.results.every((r) => r.level === "full")));
  assert.equal(plan.segments.length, 0);
  const drillOnly = specsOf(allRows(Object.fromEntries(KEYS.map((k) => [k, { appliesToSession: false }]))));
  const dplan = buildGpexeImportPlan(bundle(), { metricSpecs: drillOnly });
  assert.ok(dplan.participants.every((p) => p.results.every((r) => r.level === "drill")));
  assert.equal(dplan.segments.length, 2);
  // Gates only: the participants, no result.
  const gates = buildGpexeImportPlan(bundle(), { metricSpecs: [] });
  assert.deepEqual(gates.participants.map((p) => p.results.length), [0, 0]);
  assert.throws(() => buildGpexeImportPlan(bundle()), TypeError, "no default spec list");
});

test("5. SKIP_CATEGORY classifies exactly the 18 codes the registry can answer: 6 threshold contract, 1 shape, 11 missing; an unknown code is an internal error", () => {
  assert.equal(Object.keys(SKIP_CATEGORY).length, 18);
  const counts = {};
  for (const c of Object.values(SKIP_CATEGORY)) counts[c] = (counts[c] || 0) + 1;
  assert.deepEqual(counts, { threshold_contract: 6, shape: 1, missing: 11 });
  assert.equal(Object.keys(EXTRACTORS).length, 10);
  const weird = [{ ...specsOf(allRows())[0], extract: () => ({ skip: "not_a_code" }) }];
  assert.throws(() => buildGpexeImportPlan(bundle(), { metricSpecs: weird }), /unknown skip code/);
});

test("6. C110 form B: a missing value under required reads required_value_missing, under optional the extractor's own code; the source reason stays for the two admins", () => {
  const record = { category: "missing", code: "details_not_fetched" };
  assert.deepEqual(leftOutReason({ requirement: "required" }, record), { reason: "required_value_missing", sourceReason: "details_not_fetched" });
  assert.deepEqual(leftOutReason({ requirement: "optional" }, record), { reason: "details_not_fetched", sourceReason: "details_not_fetched" });
  assert.deepEqual(leftOutReason({ requirement: "required" }, { category: "range", code: "canonical_value_out_of_range" }).reason, "canonical_value_out_of_range");
});

test("7. R9: a drill an athlete has no row for is not a missing value; details not fetched for a drill row is", () => {
  const specs = specsOf(allRows());
  const plan = buildGpexeImportPlan(bundle(), { metricSpecs: specs });
  // Athlete 102 has a row only for drill 0 (of drills_count 2): no record for drill 1.
  assert.ok(!plan.leftOut.some((r) => r.gpexeAthleteId === "102" && r.drillIndex === 1));
  assert.ok(plan.leftOut.some((r) => r.gpexeAthleteId === "101" && r.drillIndex === 1 && r.code === "details_not_fetched"));
});

test("8. R7: the details' literal unit 'number' passes; another literal is a shape skip, and the candidate is source_shape_mismatch", () => {
  const b = bundle();
  for (const players of [b.details.full.players]) for (const p of Object.values(players)) p.tot_burst_events.unit = "count";
  const plan = buildGpexeImportPlan(b, { metricSpecs: specsOf(allRows()) });
  assert.ok(plan.leftOut.some((r) => r.category === "shape" && r.code === "unexpected_unit"));
  assert.deepEqual(classifyMappedPlan(plan, { importableIds: ["101", "102"], activationCount: 11 }), { block: "source_shape_mismatch" });
});

test("9. R8: the range is inclusive; one step of 1e-9 outside is left out canonical_value_out_of_range and the value appears in no record", () => {
  const b = bundle();
  const speeds = buildGpexeImportPlan(b, { metricSpecs: specsOf(allRows()) }).participants
    .flatMap((p) => p.results.flatMap((r) => r.values)).filter((v) => v.variableKey === "max_speed").map((v) => v.value);
  const top = speeds.reduce((a, x) => (Number(x) > Number(a) ? x : a));
  const atMax = buildGpexeImportPlan(b, { metricSpecs: specsOf(allRows({ gpexe_max_speed: { maxValue: top } })) });
  assert.ok(!atMax.leftOut.some((r) => r.category === "range"), "the maximum itself is in range");
  // One step of the storage scale (1e-9) below the largest value, exactly.
  const [intPart, frac = ""] = top.split(".");
  const scaled = (BigInt(intPart + frac.padEnd(9, "0")) - 1n).toString().padStart(10, "0");
  const tight = canonicalDecimal(`${scaled.slice(0, -9)}.${scaled.slice(-9)}`);
  const over = buildGpexeImportPlan(b, { metricSpecs: specsOf(allRows({ gpexe_max_speed: { maxValue: tight } })) });
  const out = over.leftOut.filter((r) => r.category === "range");
  assert.ok(out.length >= 1);
  for (const r of out) {
    assert.equal(r.code, "canonical_value_out_of_range");
    assert.deepEqual(Object.keys(r).sort(), ["activationId", "athleteSessionId", "category", "code", "drillIndex", "gpexeAthleteId", "level"]);
  }
  assert.ok(!JSON.stringify(over.leftOut).includes(top));
});

test("10. never a zero: a value missing at the source is left out, a real 0 stays 0", () => {
  const b = bundle();
  b.athleteSessions[0].total_distance = null;
  const plan = buildGpexeImportPlan(b, { metricSpecs: specsOf(allRows()) });
  assert.ok(plan.leftOut.some((r) => r.code === "total_distance_missing"));
  const zeroSprints = valuesOf(plan).filter((v) => v.variableKey === "sprint_distance_7mps" && v.value === "0");
  assert.ok(zeroSprints.length > 0, "the fixture's real zero sprints stay 0");
});

test("11. gpexeLevelValues gives the raw extractor values per athlete and level (7e), the same as the oracle's raw values", () => {
  const entry = EXTRACTORS["gpexe/rest_v1/athlete_session.total_time"];
  const out = gpexeLevelValues(bundle(), (input) => entry.extract(input, {}));
  assert.equal(out.code, null);
  assert.deepEqual(out.athletes.map((a) => a.session.length), [1, 1]);
  const legacy = LEGACY_SPECS.find((s) => s.key === "gpexe_time_min");
  const b = bundle();
  const row = b.athleteSessions.find((r) => String(r.athlete) === "101" && r.drill === null);
  assert.equal(out.athletes[0].session[0] / 60, legacy.extract({ row }).value);
});

test("12. R12: wholeRowHelperValues reads the three athlete_session fields in the source units, null where the row has none", () => {
  const b = bundle();
  const row = b.athleteSessions.find((r) => String(r.athlete) === "101" && r.drill === null);
  assert.deepEqual(wholeRowHelperValues(row), { totalTime: row.total_time, totalDistance: row.total_distance, maxV: row.max_v });
  assert.deepEqual(wholeRowHelperValues({}), { totalTime: null, totalDistance: null, maxV: null });
  assert.deepEqual(wholeRowHelperValues({ total_time: "x", total_distance: true, max_v: 7 }), { totalTime: null, totalDistance: null, maxV: 7 });
});

test("13. classifyMappedPlan (D3): no activation; threshold before shape before no value; only admitted athletes count; nobody linked keeps the link answer", () => {
  const b = bundle();
  const specs = specsOf(allRows());
  const plan = buildGpexeImportPlan(b, { metricSpecs: specs });
  assert.deepEqual(classifyMappedPlan(plan, { importableIds: ["101"], activationCount: 0 }), { block: "no_mapped_values" });
  assert.deepEqual(classifyMappedPlan(plan, { importableIds: ["101", "102"], activationCount: 11 }), { block: null });
  assert.deepEqual(classifyMappedPlan(plan, { importableIds: [], activationCount: 11 }), { block: null }, "nobody linked, values exist: today's no_changes");
  const threshold = { ...plan, leftOut: [...plan.leftOut, { gpexeAthleteId: "102", category: "threshold_contract", code: "threshold_mismatch" }, { gpexeAthleteId: "102", category: "shape", code: "unexpected_unit" }] };
  assert.deepEqual(classifyMappedPlan(threshold, { importableIds: ["102"], activationCount: 11 }), { block: "source_threshold_contract_mismatch" });
  assert.deepEqual(classifyMappedPlan(threshold, { importableIds: ["101"], activationCount: 11 }), { block: null }, "a record of an athlete not admitted never blocks");
  const empty = { ...plan, participants: plan.participants.map((p) => ({ ...p, results: p.results.map((r) => ({ ...r, values: [] })) })) };
  assert.deepEqual(classifyMappedPlan(empty, { importableIds: ["101"], activationCount: 11 }), { block: "no_mapped_values" });
  assert.deepEqual(classifyMappedPlan(empty, { importableIds: [], activationCount: 11 }), { block: "no_mapped_values" });
});

test("14. two mappings of one field (the two closed power zones) are two values keyed by their activations, never merged by the source key", () => {
  const plan = buildGpexeImportPlan(bundle(), { metricSpecs: specsOf(allRows()) });
  const zones = valuesOf(plan).filter((v) => v.sourceMetricKey === "more.complementary_data.power.distance" && v.athlete === "101" && v.level === "full");
  assert.equal(zones.length, 2);
  assert.notEqual(zones[0].activationId, zones[1].activationId);
  assert.notEqual(zones[0].metricDefinitionId, zones[1].metricDefinitionId);
});

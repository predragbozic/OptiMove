import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDashboardDisplayConfig } from "../training-load-analysis-display-config.js";
import { buildDashboardWidgetDisplayModel } from "../training-load-analysis-display-model.js";

function widget(overrides = {}) {
  return { id: "widget-1", widget_type: "kpi", title: "Load", group_by: "cohort", display_config: { schemaVersion: 1 }, series: [{ id: "series-1", metric_definition_id: "metric-1", resolution_status: "resolved", source_policy: "all_with_conflicts", source_connection_id: null }], ...overrides };
}

function row(value = 0, overrides = {}) {
  return { athleteId: null, bucketKey: "all", unit: "AU", value, rawCount: 1, ...overrides };
}

function result(current = [row()], comparison = null, overrides = {}) {
  return { widgetId: "widget-1", series: [{ seriesId: "series-1", status: "ok", data: { current, comparison, ...overrides } }] };
}

function freeze(value) {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const entry of Object.values(value)) freeze(entry);
  }
  return value;
}

test("V1 and legacy missing/null configs keep the original settings and use the existing one-decimal formatting", () => {
  for (const config of [undefined, null, { schemaVersion: 1 }, { schemaVersion: 1, numberFormat: { maximumFractionDigits: 5 }, futureLegacyKey: { keep: true } }]) {
    const original = freeze(widget({ display_config: config }));
    const before = structuredClone(original);
    const normalized = normalizeDashboardDisplayConfig(original);
    assert.equal(normalized.status, "ready");
    assert.equal(normalized.sourceVersion, 1);
    assert.deepEqual(normalized.effective, { schemaVersion: 2, numberFormat: { maximumFractionDigits: 1 }, legend: { visible: true }, valueLabels: { visible: false } });
    assert.deepEqual(original, before);
    normalized.effective.numberFormat.maximumFractionDigits = 6;
    assert.equal(normalizeDashboardDisplayConfig(original).effective.numberFormat.maximumFractionDigits, 1);
  }
});

test("V2 validates a small declarative contract and fills only omitted presentation defaults", () => {
  const normalized = normalizeDashboardDisplayConfig(widget({ display_config: { schemaVersion: 2, numberFormat: { maximumFractionDigits: 0 }, legend: { visible: false } } }));
  assert.equal(normalized.status, "ready");
  assert.equal(normalized.sourceVersion, 2);
  assert.deepEqual(normalized.effective, { schemaVersion: 2, numberFormat: { maximumFractionDigits: 0 }, legend: { visible: false }, valueLabels: { visible: false } });
});

test("future config versions are explicitly unsupported, never silently downgraded", () => {
  for (const version of [3, 99]) {
    const normalized = normalizeDashboardDisplayConfig(widget({ display_config: { schemaVersion: version } }));
    assert.equal(normalized.status, "unsupported");
    assert.equal(normalized.sourceVersion, version);
    assert.ok(normalized.issues.some(issue => issue.code === "unsupportedDisplayConfigVersion"));
    assert.equal(buildDashboardWidgetDisplayModel(widget({ display_config: { schemaVersion: version } }), result()).status, "unsupported");
  }
});

test("malformed configs and unknown V2 fields are rejected without changing the input", () => {
  for (const config of [[], "bad", {}, { schemaVersion: 0 }, { schemaVersion: "2" }, { schemaVersion: 1.5 }, { schemaVersion: 2, html: "<script>" }, { schemaVersion: 2, legend: null }, { schemaVersion: 2, legend: { visible: "false" } }, { schemaVersion: 2, legend: { extra: true } }, { schemaVersion: 2, numberFormat: { maximumFractionDigits: -1 } }, { schemaVersion: 2, numberFormat: { maximumFractionDigits: 7 } }, { schemaVersion: 2, numberFormat: { maximumFractionDigits: 1.5 } }]) {
    const original = freeze(widget({ display_config: config }));
    const before = structuredClone(original);
    assert.equal(normalizeDashboardDisplayConfig(original).status, "invalid");
    assert.deepEqual(original, before);
  }
});

for (const [name, value, fields, expectedStatus] of [
  ["zero", 0, {}, "value"], ["negative number", -12, {}, "value"], ["null", null, {}, "missing"],
  ["false", false, {}, "value"], ["text", "2026-10-01", {}, "value"], ["empty text", "", {}, "value"],
  ["conflict", 10, { conflict: true }, "conflict"], ["unit conflict", 10, { unitConflict: true }, "conflict"],
  ["type conflict", null, { typeConflict: true }, "conflict"], ["semantic conflict", null, { semanticConflict: true }, "conflict"],
  ["row error", null, { error: "internal detail" }, "error"], ["NaN", NaN, {}, "error"], ["infinity", Infinity, {}, "error"],
  ["object", { value: 2 }, {}, "error"], ["invalid identity", 10, { unit: 42 }, "error"],
  ["invalid flag", 10, { conflict: "true" }, "error"],
]) {
  test(`normalization keeps ${name} distinct and never coerces it`, () => {
    const input = result([row(value, fields)]);
    const normalized = buildDashboardWidgetDisplayModel(widget(), input);
    const point = normalized.series[0].current[0];
    assert.equal(point.status, expectedStatus);
    assert.deepEqual(point.rawValue, value);
    assert.deepEqual(point.value, expectedStatus === "value" ? value : null);
    assert.equal(normalized.kpi.status, expectedStatus);
  });
}

test("conflict diagnostics retain all reasons and original candidate provenance, detached from the response", () => {
  const candidates = [{ sourceConnectionId: "source-1", value: 12 }, { sourceConnectionId: "source-2", value: 20 }];
  const input = freeze(result([row(null, { conflict: true, unitConflict: true, conflictCandidates: candidates })]));
  const normalized = buildDashboardWidgetDisplayModel(widget(), input);
  const point = normalized.series[0].current[0];
  assert.deepEqual(point.reasons, ["conflict", "unitConflict"]);
  assert.deepEqual(point.raw.conflictCandidates, candidates);
  point.raw.conflictCandidates[0].value = 999;
  assert.equal(input.series[0].data.current[0].conflictCandidates[0].value, 12);
});

test("rows retain series, athlete, unit, grouping and every available source; nothing is summed or selected", () => {
  const inputRows = [row(10, { athleteId: "athlete-1", sourceConnectionId: "source-1" }), row(20, { athleteId: "athlete-2", sourceConnectionId: "source-1" }), row(30, { athleteId: "athlete-1", sourceConnectionId: "source-2" }), row(40, { athleteId: "athlete-1", unit: "m", sourceConnectionId: "source-1" })];
  const normalized = buildDashboardWidgetDisplayModel(widget({ widget_type: "line_chart", group_by: "day" }), result(inputRows));
  assert.equal(normalized.series[0].chartGroups.length, 4);
  assert.deepEqual(normalized.series[0].current.map(point => point.value), [10, 20, 30, 40]);
  for (const [index, point] of normalized.series[0].current.entries()) {
    assert.equal(point.identity.seriesId, "series-1");
    assert.equal(point.identity.metricDefinitionId, "metric-1");
    assert.equal(point.identity.groupBy, "day");
    assert.equal(point.identity.athleteId, inputRows[index].athleteId);
    assert.equal(point.identity.unit, inputRows[index].unit);
    assert.equal(point.identity.source.reported.sourceConnectionId, inputRows[index].sourceConnectionId);
  }
});

test("nested source provenance is retained and kept in distinct chart groups", () => {
  const normalized = buildDashboardWidgetDisplayModel(widget(), result([row(10, { provenance: { sourceId: "one" } }), row(20, { provenance: { sourceId: "two" } })]));
  assert.equal(normalized.series[0].chartGroups.length, 2);
  assert.equal(normalized.kpi.status, "multipleGroups");
  assert.equal(normalized.kpi.row, null);
});

test("source identity ignores reordered nested object keys without merging distinct sources", () => {
  const current = row(10, { provenance: { sourceId: "one", details: { entryMethod: "manual", connectionId: "source-1" } } });
  const previous = row(20, { provenance: { details: { connectionId: "source-1", entryMethod: "manual" }, sourceId: "one" } });
  const normalized = buildDashboardWidgetDisplayModel(widget(), result([current, previous]));
  assert.equal(normalized.series[0].chartGroups.length, 1);
  assert.ok(normalized.series[0].current.every(point => point.chartStatus === "error" && point.reasons.includes("duplicateBucket")));
  assert.equal(buildDashboardWidgetDisplayModel(widget(), result([current], [previous])).kpi.comparison.status, "value");
  const different = { ...previous, provenance: { ...previous.provenance, sourceId: "two" } };
  assert.equal(buildDashboardWidgetDisplayModel(widget(), result([current, different])).series[0].chartGroups.length, 2);
  assert.equal(buildDashboardWidgetDisplayModel(widget(), result([current], [different])).kpi.comparison.status, "incompatible");
});

test("duplicate buckets are retained for the table but cannot become an arbitrary chart point", () => {
  const normalized = buildDashboardWidgetDisplayModel(widget(), result([row(10), row(20)]));
  assert.deepEqual(normalized.series[0].current.map(point => point.value), [10, 20]);
  assert.ok(normalized.series[0].current.every(point => point.chartStatus === "error" && point.reasons.includes("duplicateBucket")));
  assert.equal(normalized.kpi.status, "multipleGroups");
});

test("KPI never selects a valid row while hiding another group or conflict", () => {
  for (const current of [[row(10), row(20, { bucketKey: "other" })], [row(10), row(null, { conflict: true })], [row(10), row(20, { unit: "m" })], [row(10), row(20, { athleteId: "another" })]]) {
    const normalized = buildDashboardWidgetDisplayModel(widget(), result(current));
    assert.equal(normalized.kpi.status, "multipleGroups");
    assert.equal(normalized.kpi.groupCount, 2);
    assert.equal(normalized.kpi.row, null);
    assert.equal(normalized.kpi.comparison.status, "none");
  }
});

test("raw arrays remain arrays in the table model and are unsupported for numeric charts and a scalar KPI", () => {
  for (const values of [[0, 1, 2], ["a", "b"], [true, false], []]) {
    const normalized = buildDashboardWidgetDisplayModel(widget(), result([row(values)]));
    const point = normalized.series[0].current[0];
    assert.deepEqual(point.value, values);
    assert.equal(point.status, "value");
    assert.equal(point.chartStatus, "unsupported");
    assert.equal(normalized.kpi.status, "unsupported");
  }
  const malformed = buildDashboardWidgetDisplayModel(widget(), result([row([{ not: "a scalar" }])]));
  assert.equal(malformed.kpi.status, "error");
});

test("no rows, an explicit missing row, loading and errors are separate outcomes", () => {
  assert.equal(buildDashboardWidgetDisplayModel(widget(), result([])).kpi.status, "empty");
  assert.equal(buildDashboardWidgetDisplayModel(widget(), result([row(null)])).kpi.status, "missing");
  assert.equal(buildDashboardWidgetDisplayModel(widget(), null, { loading: true }).status, "loading");
  assert.equal(buildDashboardWidgetDisplayModel(widget(), null, { error: "request failed" }).status, "error");
  const failed = result();
  failed.series[0] = { seriesId: "series-1", status: "error", error: "seriesQueryFailed" };
  assert.equal(buildDashboardWidgetDisplayModel(widget(), failed).kpi.status, "error");
});

test("unresolved and ambiguous legacy widgets do not require an executable query result", () => {
  for (const status of ["unresolved", "ambiguous"]) {
    const original = widget();
    original.series[0].resolution_status = status;
    assert.equal(buildDashboardWidgetDisplayModel(original, null).kpi.status, status);
    assert.equal(buildDashboardWidgetDisplayModel(original, { series: "malformed" }).kpi.status, status);
  }
});

test("malformed widget/series/result shapes fail safely rather than choosing the first matching object", () => {
  for (const response of [null, [], {}, { widgetId: "other-widget", series: [] }, { series: "bad" }, { series: [null] }, { series: [{ seriesId: "foreign" }] }, { series: [{ seriesId: "series-1", status: "ok", data: { current: {} } }] }, { series: [result().series[0], result().series[0]] }]) {
    const normalized = buildDashboardWidgetDisplayModel(widget(), response);
    assert.ok(normalized.status === "error" || normalized.kpi.status === "error");
  }
  for (const current of [[null], [12], [{}], [row(0, { value: undefined })]]) {
    assert.equal(buildDashboardWidgetDisplayModel(widget(), result(current)).kpi.status, "error");
  }
  assert.equal(buildDashboardWidgetDisplayModel(widget({ series: null }), result()).status, "error");
  assert.equal(buildDashboardWidgetDisplayModel(widget({ group_by: "unknown" }), result()).status, "error");
  const duplicate = widget();
  duplicate.series.push({ ...duplicate.series[0] });
  assert.equal(buildDashboardWidgetDisplayModel(duplicate, result()).status, "error");
});

test("KPI comparison displays only compatible unambiguous values, with no frontend delta or percentage", () => {
  const normalized = buildDashboardWidgetDisplayModel(widget(), result([row(0)], [row(25)]));
  assert.equal(normalized.kpi.comparison.status, "value");
  assert.equal(normalized.kpi.comparison.row.value, 25);
  assert.equal(Object.hasOwn(normalized.kpi, "delta"), false);
  assert.equal(Object.hasOwn(normalized.kpi, "percentage"), false);
  for (const comparison of [[row(25, { unit: "m" })], [row(25, { athleteId: "other" })], [row(25, { sourceConnectionId: "other-source" })], [row(25, { bucketKey: "other" })], [row(25), row(30)], [row(null)], [row(25, { conflict: true })], [row([25])], [row("25")]]) {
    const model = buildDashboardWidgetDisplayModel(widget(), result([row(0)], comparison));
    assert.equal(model.kpi.comparison.status, "incompatible");
    assert.equal(model.kpi.comparison.row, null);
    assert.equal(model.kpi.row.value, 0);
  }
});

test("calendar comparisons require aligned positions in server ranges, never just two date-shaped buckets", () => {
  const period = { dateFrom: "2026-10-01", dateTo: "2026-10-07" };
  const range = { dateFrom: "2026-09-24", dateTo: "2026-09-30" };
  const selected = widget({ group_by: "day" });
  const normalized = buildDashboardWidgetDisplayModel(selected, result([row(10, { bucketKey: "2026-10-03" })], [row(20, { bucketKey: "2026-09-26" })], { comparisonRange: range }), { period });
  assert.equal(normalized.kpi.comparison.status, "value");
  assert.deepEqual(normalized.kpi.comparison.range, range);
  for (const bucketKey of ["2026-09-27", "2026-09-23", "2026-02-30"]) {
    assert.equal(buildDashboardWidgetDisplayModel(selected, result([row(10, { bucketKey: "2026-10-03" })], [row(20, { bucketKey })], { comparisonRange: range }), { period }).kpi.comparison.status, "incompatible");
  }
  assert.equal(buildDashboardWidgetDisplayModel(selected, result([row(10, { bucketKey: "2026-10-03" })], [row(20, { bucketKey: "2026-09-26" })])).kpi.comparison.status, "incompatible");
  assert.equal(buildDashboardWidgetDisplayModel(selected, result([row(10, { bucketKey: "2026-10-03" })], [row(20, { bucketKey: "2026-10-03" })], { comparisonRange: range }), { period }).kpi.comparison.status, "incompatible");
});

test("missing identity, malformed comparison and source differences never produce a trusted KPI comparison", () => {
  const unknown = row(20);
  delete unknown.athleteId;
  assert.equal(buildDashboardWidgetDisplayModel(widget(), result([row(10)], [unknown])).kpi.comparison.status, "incompatible");
  assert.equal(buildDashboardWidgetDisplayModel(widget(), result([row(10)], { invalid: true })).kpi.comparison.status, "error");
  const current = row(10, { provenance: { sourceId: "one" } });
  const previous = row(20, { provenance: { sourceId: "two" } });
  assert.equal(buildDashboardWidgetDisplayModel(widget(), result([current], [previous])).kpi.comparison.status, "incompatible");
});

test("normalization of every widget type has no aliases into frozen API results, period, definitions or saved configs", () => {
  for (const type of ["kpi", "table", "line_chart", "bar_chart"]) {
    const selected = freeze(widget({ widget_type: type }));
    const response = freeze(result([row([0, 2], { sourceProvenance: { sourceId: "source-1" } })]));
    const options = freeze({ period: { dateFrom: "2026-10-01", dateTo: "2026-10-07" } });
    const before = structuredClone({ selected, response, options });
    const normalized = buildDashboardWidgetDisplayModel(selected, response, options);
    normalized.series[0].definition.source_policy = "manual";
    normalized.series[0].current[0].value.push(9);
    normalized.series[0].current[0].identity.source.reported.sourceProvenance.sourceId = "changed";
    normalized.period.dateFrom = "changed";
    assert.deepEqual({ selected, response, options }, before);
  }
});

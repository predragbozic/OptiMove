import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardPivotTable } from "../training-load-dashboard-table.js";
import { renderTrainingLoadAnalysisHtml } from "../training-load-analysis-view.js";
import { emptyTrainingLoadState, state } from "../state.js";

const athletes = [{ id: "a", name: "A & Z" }, { id: "b", name: "B" }];
const describe = ({ id }) => id === "distance"
  ? { label: "Total distance", icon: '<span aria-hidden="true">D</span>', unit: "m" }
  : { label: "Load", icon: '<span aria-hidden="true">L</span>', unit: "AU" };
const row = (athleteId, bucketKey, unit, value, extra = {}) => ({
  status: "value", reasons: [], identity: { athleteId, bucketKey, unit }, value, ...extra,
});
const series = (id, current, analytical_aggregation = "sum") => ({
  definition: { id, analytical_aggregation }, current, status: "ready",
});
const model = (groupBy, series) => ({
  groupBy, series, config: { effective: { numberFormat: { maximumFractionDigits: 3 } } },
});

test("day pivot puts metrics in series order with their icons and units and joins sparse rows by athlete and date", () => {
  const html = renderDashboardPivotTable(model("day", [
    series("load", [row("b", "2026-11-08", "AU", 19), row("a", "2026-11-07", "AU", 0)]),
    series("distance", [row("A", "2026-11-07", "m", 42.567), row("a", "2026-11-08", "m", 55)]),
  ]), athletes, describe);
  assert.match(html, /<th scope="col">Athlete<\/th><th scope="col">Date<\/th><th scope="col"><span aria-hidden="true">L<\/span>Load \(AU\)<\/th><th scope="col"><span aria-hidden="true">D<\/span>Total distance \(m\)<\/th>/);
  assert.match(html, /<tr><td>A &amp; Z<\/td><td>07\.11\.2026<\/td><td>0<\/td><td>42\.57<\/td><\/tr><tr><td>A &amp; Z<\/td><td>08\.11\.2026<\/td><td>—<\/td><td>55<\/td><\/tr><tr><td>B<\/td><td>08\.11\.2026<\/td><td>19<\/td><td>—<\/td><\/tr>/);
});

test("athlete pivot keeps explicit conflicts, omits IDs and reports a series with mixed units", () => {
  const unknown = "123e4567-e89b-12d3-a456-426614174000";
  const html = renderDashboardPivotTable(model("athlete", [
    series("distance", [row("a", "a", "m", 14), row("b", "b", "km", 2)]),
    series("load", [row(null, unknown, "AU", 1000, { status: "conflict", reasons: ["conflict", "unitConflict"] })]),
  ]), athletes, describe);
  assert.match(html, /Athlete name unavailable/);
  assert.match(html, /Conflict \/ Unit conflict/);
  assert.match(html, /Values use different or unknown units/);
  assert.doesNotMatch(html, /123e4567|1000|>Date</);
});

test("raw, duplicate or unsupported buckets fall back rather than collapsing distinct results", () => {
  const day = row("a", "2026-11-07", "m", 3);
  const second = series("load", []);
  for (const candidate of [
    model("day", [series("distance", [day], "none"), second]),
    model("day", [series("distance", [day, day]), second]),
    model("day", [series("distance", [{ ...day, value: [3] }]), second]),
    model("session", [series("distance", [day]), second]),
  ]) {
    assert.equal(renderDashboardPivotTable(candidate, athletes, describe), null);
  }
});

test("saved dashboard table uses the pivot and returns to the raw renderer for a measurement-level series", () => {
  state.trainingLoad = emptyTrainingLoadState();
  const a = state.trainingLoad.analysis;
  state.trainingLoad.orgPickerData = { athletes };
  a.dashboard = { id: "d", name: "Dashboard", status: "active" };
  a.metricPicker.definitions = [{ id: "distance", label: "Total distance", unit: "m", iconUrl: "icon:activity" }];
  const widget = {
    id: "widget", widget_type: "table", title: "Metrics", width: 6, height: 4,
    x: 0, y: 0, mobile_order: 1, group_by: "athlete", display_config: { schemaVersion: 1 },
    series: [
      { id: "load", built_in_series_key: "srpe", resolution_status: "resolved", analytical_aggregation: "sum" },
      { id: "distance", metric_definition_id: "distance", resolution_status: "resolved", analytical_aggregation: "sum" },
    ],
  };
  a.widgets = [widget];
  a.queryResult = { widgets: [{ widgetId: "widget", series: [
    { seriesId: "distance", status: "ok", data: { current: [{ athleteId: "a", bucketKey: "a", unit: "m", value: 9 }] } },
    { seriesId: "load", status: "ok", data: { current: [{ athleteId: "a", bucketKey: "a", unit: "AU", value: 3 }] } },
  ] }] };
  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /<th scope="col">Athlete<\/th>.*sRPE \(AU\).*Total distance \(m\)/);
  assert.match(html, /<td>A &amp; Z<\/td><td>3<\/td><td>9<\/td>/);
  widget.series[1].analytical_aggregation = "none";
  const raw = renderTrainingLoadAnalysisHtml();
  assert.match(raw, /<th scope="col">Series<\/th><th scope="col">Bucket<\/th>/);
  assert.doesNotMatch(raw, /<td>A &amp; Z<\/td><td>3<\/td><td>9<\/td>/);
});

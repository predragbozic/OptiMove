import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSimpleEditorHtml } from "../training-load-simple-view.js";

const metricId = "10000000-0000-4000-8000-000000000001";
function model(overrides = {}) {
  return {
    open: true, step: 1, loading: false, search: "", metrics: [],
    capabilities: { capabilities: { preview: true, atomicSave: true }, builtins: [], widgetTypes: ["table", "line_chart", "bar_chart", "kpi"] },
    draft: { title: "My widget", athleteSelection: { mode: "inherit" }, periodIntent: { mode: "inherit" }, view: {} },
    context: { period: { dateFrom: "2026-10-01", dateTo: "2026-10-31", timeZone: "Europe/Belgrade" } },
    athletes: [], saveState: "idle", canSave: false, ...overrides,
  };
}
function control(html, name) {
  const tag = html.match(new RegExp(`<[^>]+data-action="training-load-simple-${name}"[^>]*>`));
  assert.ok(tag, `Expected ${name} control`);
  return tag[0];
}
function selected(html, name) {
  const select = html.match(new RegExp(`<select data-action="training-load-simple-${name}"[^>]*>([\\s\\S]*?)</select>`));
  assert.ok(select, `Expected ${name} select`);
  return select[1].match(/<option[^>]*selected[^>]*>[\s\S]*?<\/option>/)?.[0];
}

test("closed editor renders nothing and rendering never changes the model", () => {
  assert.equal(renderSimpleEditorHtml(null), "");
  assert.equal(renderSimpleEditorHtml(), "");
  assert.equal(renderSimpleEditorHtml({ open: false }), "");
  const input = model();
  const original = structuredClone(input);
  renderSimpleEditorHtml(input);
  assert.deepEqual(input, original);
});

test("metric cards escape labels, units, IDs and searches without selecting a default", () => {
  const malicious = '<img src=x onerror="alert(1)">`';
  const input = model({ search: malicious, metrics: [{ id: malicious, label: malicious, unit: null, description: malicious }] });
  input.capabilities.builtins = [{ key: 'a" onclick="oops', label: "Built-in label", unit: malicious }];
  const html = renderSimpleEditorHtml(input);
  assert.doesNotMatch(html, /<img|\s(?:onclick|onerror)="/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(control(html, "search"), /&#096;/);
  assert.match(html, /data-kind="builtin" data-id="a&quot; onclick=&quot;oops"/);
  assert.match(html, /data-kind="metric"/);
  assert.match(html, />Built-in<|>Metric</);
  assert.match(html, /no unit specified/);
  assert.doesNotMatch(html, /aria-pressed="true"/);
  assert.match(control(html, "next"), /disabled/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="tl-simple-heading"/);
});

test("UUID and builtin selections stay distinct and metric selection enables Next", () => {
  const input = model({ metrics: [{ id: metricId, label: "Custom", unit: "m" }] });
  input.capabilities.builtins = [{ key: "distance", label: "Distance", unit: "m" }];
  input.draft.metricRef = { kind: "metric", metricDefinitionId: metricId };
  const html = renderSimpleEditorHtml(input);
  assert.match(html, new RegExp(`data-kind="metric" data-id="${metricId}" aria-pressed="true"`));
  assert.match(html, /data-kind="builtin" data-id="distance" aria-pressed="false"/);
  assert.doesNotMatch(control(html, "next"), /disabled/);
});

test("loading, empty, search-empty, errors and paginated results are distinct", () => {
  assert.match(renderSimpleEditorHtml(model({ loading: true })), /Loading metrics/);
  assert.doesNotMatch(renderSimpleEditorHtml(model({ loading: true })), /No metrics available/);
  assert.match(renderSimpleEditorHtml(model()), /No metrics available/);
  assert.match(renderSimpleEditorHtml(model({ search: "unknown" })), /No metrics match your search/);
  const error = renderSimpleEditorHtml(model({ error: "Catalog unavailable" }));
  assert.match(error, /role="alert"[^>]*>Catalog unavailable/);
  assert.ok(control(error, "reload"));
  assert.doesNotMatch(error, /No metrics available/);
  const page = model({ nextCursor: metricId, metrics: [{ id: metricId, label: "Visible metric", unit: null }] });
  assert.match(renderSimpleEditorHtml(page), /More metrics are available/);
  assert.doesNotMatch(control(renderSimpleEditorHtml(page), "more"), /disabled/);
  page.loading = true;
  const loading = renderSimpleEditorHtml(page);
  assert.match(loading, /Loading more metrics/);
  assert.match(loading, /Visible metric/);
  assert.match(control(loading, "more"), /disabled/);
});

test("athlete names and dates use standard values, retained period draft and explicit save scope", () => {
  const input = model({ step: 2, athletes: [{ id: metricId, name: "<script>Athlete</script>" }] });
  input.draft.athleteSelection = { mode: "selected", athleteIds: [metricId] };
  let html = renderSimpleEditorHtml(input);
  assert.match(control(html, "athlete"), new RegExp(`data-id="${metricId}" value="${metricId}" checked`));
  assert.match(html, /&lt;script&gt;Athlete&lt;\/script&gt;/);
  assert.match(control(html, "date-from"), /value="2026-10-01"[^>]*disabled/);
  assert.match(html, /value="allAuthorized"/);
  input.draft.periodIntent = { mode: "replacePageRuntime" };
  input.periodDraft = { dateFrom: "2026-09-01", dateTo: "2026-09-30", timeZone: "UTC" };
  html = renderSimpleEditorHtml(input);
  assert.match(control(html, "date-from"), /value="2026-09-01"/);
  assert.doesNotMatch(control(html, "date-from"), /disabled/);
  assert.match(control(html, "date-to"), /value="2026-09-30"/);
  assert.match(html, /whole dashboard only after a successful save/);
  assert.match(html, /Time zone: UTC/);
});

test("custom aggregation is explicit, independent of daily metadata, with scope and grouping choices", () => {
  const input = model({ step: 3, selectedMetric: { allowed_aggregations: ["last", "none"], daily_aggregation_method: "last", scope_capabilities: ["day", "session"] } });
  input.draft.metricRef = { kind: "metric", metricDefinitionId: metricId };
  const html = renderSimpleEditorHtml(input);
  assert.match(control(html, "view"), /value="table" checked/);
  assert.match(html, /How to combine measurements<select/);
  assert.match(html, /Use measurements from<select/);
  assert.match(html, /The preview lists all returned data\. Saved charts use the current dashboard display\./);
  assert.doesNotMatch(html, /Chart composition and unsupported settings/);
  assert.match(selected(html, "group"), /value="day"/);
  assert.match(selected(html, "aggregation"), /value="" selected disabled>Choose how to combine measurements/);
  assert.doesNotMatch(selected(html, "aggregation"), /value="last"/);
  assert.match(selected(html, "scope"), /value="" selected disabled/);
  for (const group of ["day", "week", "athlete", "session", "component", "cohort"]) assert.match(html, new RegExp(`value="${group}"`));
  input.draft.view = { type: "bar_chart", groupBy: "athlete", analyticalAggregation: "none", dataScopeLevel: "session" };
  const chosen = renderSimpleEditorHtml(input);
  assert.match(selected(chosen, "aggregation"), /value="none" selected/);
  assert.match(selected(chosen, "scope"), /value="session" selected/);
  assert.match(chosen, /value="bar_chart" checked/);
  input.draft.view.analyticalAggregation = "sum";
  assert.match(selected(renderSimpleEditorHtml(input), "aggregation"), /Unavailable choice/);
});

test("builtin fixed metadata does not expose custom analytical controls; backend gates views", () => {
  const input = model({ step: 3 });
  input.draft.metricRef = { kind: "builtin", key: "srpe" };
  input.capabilities.widgetTypes = [{ key: "table", is_active: true }, { key: "line_chart", is_active: false }];
  const html = renderSimpleEditorHtml(input);
  assert.doesNotMatch(html, /training-load-simple-aggregation|training-load-simple-scope/);
  assert.match(html, /value="line_chart" disabled/);
  assert.match(html, /Line chart \(unavailable\)/);
});

test("preview is lossless for every current and comparison row, including problems, arrays, zero and negatives", () => {
  const rows = Array.from({ length: 150 }, (_, index) => ({ athleteId: `athlete-${index}`, value: index === 0 ? 0 : -index, unit: null, conflict: index === 1, note: index === 149 ? '<svg onload="bad">' : "" }));
  rows.push({ value: [0, -5, null], unit: "m", unitConflict: true, coverage: { status: "partial", detail: "Do not hide" } });
  const preview = { status: "invalid", issues: [{ code: "conflict", path: "<bad>" }], warnings: ["Incomplete coverage"], resolvedPeriod: { dateFrom: "2026-10-01" }, widgetResult: { status: "problem", series: [{ seriesId: "series-1", status: "error", data: { current: rows, comparison: [{ value: -0.123456789123, unit: "m", missing: true }] } }] } };
  const html = renderSimpleEditorHtml(model({ step: 3, preview }), true);
  assert.equal((html.match(/<tbody>/g) ?? []).length, 2);
  assert.equal((html.match(/<tr>/g) ?? []).length, rows.length + 1 + 2);
  assert.match(html, /<td class="tl-simple-number">0<\/td>/);
  assert.match(html, /<td class="tl-simple-number">-149<\/td>/);
  assert.match(html, /<td class="tl-simple-number">-0\.123456789123<\/td>/);
  assert.match(html, /<td>\[0,-5,null\]<\/td>/);
  assert.match(html, /no unit specified/);
  assert.match(html, /<th scope="col">Conflicting observations<\/th>/);
  assert.match(html, /unitConflict|partial|Do not hide/);
  assert.match(html, /Series 1: Could not load/);
  assert.match(html, /Result status: Needs attention/);
  assert.match(html, /Conflicting observations were returned/);
  assert.match(html, /Incomplete coverage/);
  assert.match(html, /&lt;svg onload=&quot;bad&quot;&gt;/);
  assert.doesNotMatch(html, /<svg|<canvas/);
  assert.match(html, /<caption>Series 1 \/ Current period<\/caption>/);
  assert.match(html, /Complete preview result and problem details/);
});

test("preview loading, empty results and request errors remain visible", () => {
  assert.match(renderSimpleEditorHtml(model({ step: 3, previewLoading: true })), /aria-busy="true"/);
  const html = renderSimpleEditorHtml(model({ step: 3, error: "Preview request failed", preview: { status: "valid", widgetResult: { series: [{ status: "ok", data: { current: [], comparison: [] } }] } } }));
  assert.match(html, /Preview request failed/);
  assert.match(html, /Current period: no returned rows/);
});

test("unknown save locks editable controls and preserves same-request retry and status", () => {
  for (const step of [1, 2, 3]) {
    const html = renderSimpleEditorHtml(model({ step, saveState: "unknown", canSave: true, saveError: "notRecorded: no receipt yet" }));
    assert.match(html, /class="tl-simple-editable" disabled/);
    assert.match(control(html, "close"), /disabled/);
    assert.match(control(html, "advanced"), /disabled/);
    assert.doesNotMatch(control(html, "retry"), /disabled/);
    assert.doesNotMatch(control(html, "status"), /disabled/);
    assert.match(html, /Retry same request|Retry sends the same request/);
    assert.match(html, /notRecorded: no receipt yet/);
    assert.doesNotMatch(html, /rolled back|rollback confirmed/i);
    if (step === 3) {
      assert.match(control(html, "title"), /value="My widget" disabled/);
      assert.match(control(html, "save"), /disabled/);
      assert.match(control(html, "preview"), /disabled/);
    }
  }
});

test("save requires capability and canSave, with accurate advanced discard confirmation help", () => {
  const input = model({ step: 3, canSave: true });
  assert.doesNotMatch(control(renderSimpleEditorHtml(input), "save"), /disabled/);
  input.capabilities.capabilities = { preview: false, atomicSave: false };
  const unavailable = renderSimpleEditorHtml(input);
  assert.match(control(unavailable, "save"), /disabled/);
  assert.match(control(unavailable, "preview"), /disabled/);
  assert.match(unavailable, /Live preview is temporarily unavailable\./);
  assert.match(unavailable, /Saving is temporarily unavailable\./);
  assert.doesNotMatch(unavailable, /on this backend/);
  input.advancedRequired = true;
  input.draft = null;
  const advanced = renderSimpleEditorHtml(input);
  assert.doesNotMatch(control(advanced, "advanced"), /disabled/);
  assert.match(advanced, /Opening advanced will ask before discarding these unsaved changes\./);
  assert.doesNotMatch(advanced, /Keep your draft|must preserve your choices|Your draft is retained/);
  assert.match(control(advanced, "save"), /disabled/);
});

test("metric cards name Numeric, Text and Boolean value types and safely display unknown types", () => {
  const html = renderSimpleEditorHtml(model({ metrics: [
    { id: "numeric", label: "Numeric metric", unit: null, value_type: "numeric" },
    { id: "text", label: "Text metric", unit: null, value_type: "text" },
    { id: "boolean", label: "Boolean metric", unit: null, value_type: "boolean" },
    { id: "unknown", label: "Unknown metric", unit: null, value_type: "<script>" },
  ] }));
  for (const label of ["Numeric", "Text", "Boolean"]) assert.match(html, new RegExp(`Value type: ${label}`));
  assert.match(html, /Value type: &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("title is limited to 200 characters and empty scope capabilities offer explicit choices", () => {
  const input = model({ step: 3, selectedMetric: { scope_capabilities: [], allowed_aggregations: ["none"] } });
  input.draft.metricRef = { kind: "metric", metricDefinitionId: metricId };
  const html = renderSimpleEditorHtml(input);
  assert.match(control(html, "title"), /maxlength="200"/);
  assert.match(selected(html, "scope"), /value="" selected disabled>Choose which measurements to use/);
  const scopeOptions = html.match(/<select data-action="training-load-simple-scope"[^>]*>([\s\S]*?)<\/select>/)[1];
  for (const scope of ["day", "session", "component"]) assert.match(scopeOptions, new RegExp(`value="${scope}"`));
  input.selectedMetric.scope_capabilities = ["session"];
  assert.doesNotMatch(renderSimpleEditorHtml(input), /training-load-simple-scope/);
});

test("inherited athletes summarize actual dashboard filters by count and names", () => {
  const input = model({ step: 2, athletes: [{ id: metricId, name: "Alex <Runner>" }, { id: "athlete-b", name: "Bo" }] });
  input.context.runtimeFilter = { athleteIds: [metricId] };
  const filtered = renderSimpleEditorHtml(input);
  assert.match(filtered, /Dashboard athletes: 1 athlete — Alex &lt;Runner&gt;/);
  assert.doesNotMatch(filtered, new RegExp(metricId));
  assert.doesNotMatch(filtered, /— Alex &lt;Runner&gt;, Bo/);
  input.context.runtimeFilter.athleteIds = null;
  assert.match(renderSimpleEditorHtml(input), /Dashboard athletes: all, subject to dashboard access\. Loaded roster: 2 athletes — Alex &lt;Runner&gt;, Bo/);
  input.context.runtimeFilter.athleteIds = [];
  assert.match(renderSimpleEditorHtml(input), /Dashboard athletes: 0 athletes\./);
});

test("roster loading and errors are distinct from empty athletes and preserve selected values", () => {
  const input = model({ step: 2, rosterLoading: true });
  input.draft.athleteSelection = { mode: "selected", athleteIds: [metricId] };
  let html = renderSimpleEditorHtml(input);
  assert.match(html, /Loading athletes/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /No authorized athletes|Selected athlete unavailable/);
  input.rosterLoading = false;
  input.rosterError = "<bad> unavailable";
  html = renderSimpleEditorHtml(input);
  assert.match(html, /role="alert"[^>]*>Athletes could not be loaded\./);
  assert.doesNotMatch(html, /No authorized athletes|Selected athlete unavailable/);
  input.athletes = [{ id: metricId, name: "Alex" }];
  assert.match(control(renderSimpleEditorHtml(input), "athlete"), /checked disabled/);
  input.rosterError = "";
  input.athletes = [];
  assert.match(renderSimpleEditorHtml(input), /No authorized athletes available/);
  input.draft.athleteSelection = { mode: "inherit" };
  input.rosterLoading = true;
  html = renderSimpleEditorHtml(input);
  assert.match(html, /Loading dashboard athletes/);
  assert.doesNotMatch(html, /Dashboard athletes: 0/);
  input.rosterLoading = false;
  input.rosterError = "Network error";
  assert.match(renderSimpleEditorHtml(input), /Dashboard athletes could not be loaded/);
});

test("preview headings and athlete names are friendly while every original field remains in details", () => {
  const preview = {
    status: "invalid", issues: [{ code: "requiresChoice", path: "$.view.analyticalAggregation", reason: "retained detail" }],
    warnings: [{ code: "futureWarning", message: "<Warning>", detail: "Keep this field" }],
    widgetResult: { status: "error", series: [{ seriesId: "raw-series-id", status: "error", data: { current: [{ athleteId: metricId, bucketKey: "2026-10-01", value: -2, missingKind: "noObservation", unknownField: { nested: 0 } }] } }] },
  };
  const html = renderSimpleEditorHtml(model({ step: 3, preview, athletes: [{ id: metricId, name: "Alex <Runner>" }] }));
  const table = html.match(/<table>[\s\S]*?<\/table>/)[0];
  assert.match(table, /<th scope="col">Athlete<\/th>/);
  assert.match(table, /<th scope="col">Period \/ group<\/th>/);
  assert.match(table, /<td>Alex &lt;Runner&gt;<\/td>/);
  assert.match(table, /<td>No observation<\/td>/);
  assert.doesNotMatch(table, new RegExp(metricId));
  assert.match(html, /Choose how to combine measurements\./);
  assert.doesNotMatch(html, /&lt;Warning&gt;|raw-series-id|unknownField|<pre>/);
  const adminHtml = renderSimpleEditorHtml(model({ step: 3, preview }), true);
  assert.match(adminHtml, /&lt;Warning&gt;/);
  const details = adminHtml.match(/<pre>([\s\S]*?)<\/pre>/)[1].replaceAll("&quot;", '"').replaceAll("&#039;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  assert.deepEqual(JSON.parse(details), preview);
});

test("inherited summary uses effective dashboard defaults and the latest model roster", () => {
  const input = model({ step: 2, athletes: [{ id: metricId, name: "Updated Alex" }, { id: "athlete-b", name: "Bo" }] });
  input.context.athletes = [];
  input.context.runtimeFilter = {};
  input.context.effectiveInheritedAthleteIds = [metricId];
  let html = renderSimpleEditorHtml(input);
  assert.match(html, /Dashboard athletes: 1 athlete — Updated Alex/);
  assert.doesNotMatch(html, new RegExp(metricId));
  input.context.runtimeFilter.athleteIds = ["athlete-b"];
  html = renderSimpleEditorHtml(input);
  assert.match(html, /Dashboard athletes: 1 athlete — Updated Alex/);
  assert.doesNotMatch(html, /— Bo/);
  input.context.effectiveInheritedAthleteIds = null;
  html = renderSimpleEditorHtml(input);
  assert.match(html, /Loaded roster: 2 athletes — Updated Alex, Bo/);
  assert.doesNotMatch(html, /2 athletes \(all authorized\)/);
});

test("inherited all-athlete count distinguishes unknown, loading, failed and confirmed empty rosters", () => {
  const input = model({ step: 2 });
  input.context.effectiveInheritedAthleteIds = null;
  let html = renderSimpleEditorHtml(input);
  assert.match(html, /Athlete roster has not loaded/);
  assert.doesNotMatch(html, /0 athletes/);
  input.rosterLoading = true;
  html = renderSimpleEditorHtml(input);
  assert.match(html, /Loading dashboard athletes/);
  assert.doesNotMatch(html, /0 athletes/);
  input.rosterLoading = false;
  input.rosterError = "Unavailable";
  html = renderSimpleEditorHtml(input);
  assert.match(html, /Dashboard athletes could not be loaded/);
  assert.doesNotMatch(html, /0 athletes/);
  input.rosterError = "";
  html = renderSimpleEditorHtml(input);
  assert.match(html, /Loaded roster: 0 athletes\./);
  assert.doesNotMatch(html, /Dashboard athletes: 0|0 athletes \(all authorized\)/);
  delete input.context.effectiveInheritedAthleteIds;
  html = renderSimpleEditorHtml(input);
  assert.match(html, /selection will be resolved from dashboard defaults/);
  assert.doesNotMatch(html, /Dashboard athletes: all/);
});

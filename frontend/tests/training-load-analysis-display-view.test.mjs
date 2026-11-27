import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderTrainingLoadAnalysisHtml } from "../training-load-analysis-view.js";
import { emptyTrainingLoadState, state } from "../state.js";

function setup(type, current, { config = { schemaVersion: 1 }, comparison = [], resultStatus = "ok" } = {}) {
  state.trainingLoad = emptyTrainingLoadState();
  const analysis = state.trainingLoad.analysis;
  analysis.dashboardCanManage = true;
  analysis.canCreateDashboard = true;
  analysis.dashboard = { id: "dashboard-1", name: "Legacy dashboard", status: "active", is_template: false };
  analysis.widgets = [{ id: "widget-1", widget_type: type, title: "Legacy widget", width: 4, height: 3, x: 0, y: 0, mobile_order: 1, group_by: "cohort", display_config: config, series: [{ id: "series-1", built_in_series_key: "srpe", resolution_status: "resolved", source_policy: "not_applicable", display_label: "sRPE" }] }];
  analysis.period = { dateFrom: "2026-10-01", dateTo: "2026-10-14" };
  analysis.queryResult = { widgets: [{ widgetId: "widget-1", series: [{ seriesId: "series-1", status: resultStatus, data: { current, comparison } }] }] };
  return analysis;
}

function row(value, fields = {}) {
  return { athleteId: null, bucketKey: "all", unit: "AU", value, ...fields };
}

function rendered() {
  return new JSDOM(renderTrainingLoadAnalysisHtml()).window.document;
}

for (const type of ["kpi", "table", "line_chart", "bar_chart"]) {
  test(`${type}: an existing V1 widget renders without migration, API calls or a configuration write`, () => {
    let requests = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = () => { requests += 1; throw new Error("Rendering must not fetch"); };
    try {
      const analysis = setup(type, [row(12.25)]);
      const before = structuredClone(analysis);
      const document = rendered();
      const body = document.querySelector(".tl-analysis-widget");
      assert.match(body.textContent, /12\.3/);
      assert.match(body.textContent, /AU/);
      assert.deepEqual(analysis, before);
      assert.equal(requests, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test(`${type}: zero is visible, null is missing, conflicts and errors never become a zero or trusted number`, () => {
    setup(type, [row(0)]);
    const zero = rendered().querySelector(".tl-analysis-widget");
    assert.match(zero.textContent, /\b0\b/);
    if (type.includes("chart")) assert.equal(zero.querySelector(".tl-analysis-table tbody tr").children[2].textContent, "0");
    setup(type, [row(null)]);
    const missing = rendered().querySelector(".tl-analysis-widget");
    assert.match(missing.textContent, /No data/);
    assert.equal(missing.querySelector(".tl-analysis-chart-track"), null);
    setup(type, [row(98765, { conflict: true, unitConflict: true })]);
    const conflict = rendered().querySelector(".tl-analysis-widget");
    assert.match(conflict.textContent, /Conflict \/ Unit conflict/);
    assert.doesNotMatch(conflict.textContent, /98765/);
    assert.equal(conflict.querySelector(".tl-analysis-chart-track"), null);
    setup(type, [], { resultStatus: "error" });
    assert.match(rendered().querySelector(".tl-analysis-widget").textContent, /This series could not be loaded/);
  });

  test(`${type}: unsupported and invalid configurations are explicit and never silently rendered with defaults`, () => {
    setup(type, [row(98765)], { config: { schemaVersion: 99 } });
    let body = rendered().querySelector(".tl-analysis-widget");
    assert.match(body.textContent, /Unsupported display configuration version/);
    assert.doesNotMatch(body.textContent, /98765/);
    setup(type, [row(98765)], { config: { schemaVersion: 2, numberFormat: { maximumFractionDigits: -1 } } });
    body = rendered().querySelector(".tl-analysis-widget");
    assert.match(body.textContent, /Invalid display configuration/);
    assert.doesNotMatch(body.textContent, /98765/);
  });
}

test("KPI refuses multiple groups, raw arrays and conflicting comparison instead of taking the first row", () => {
  setup("kpi", [row(98765), row(12345, { athleteId: "athlete-2" })]);
  let body = rendered().querySelector(".tl-analysis-widget");
  assert.match(body.textContent, /Multiple groups/);
  assert.equal(body.querySelector(".tl-analysis-kpi-value"), null);
  assert.doesNotMatch(body.textContent, /98765|12345/);
  setup("kpi", [row([1, 2])]);
  assert.match(rendered().querySelector(".tl-analysis-widget").textContent, /Use a table/);
  setup("kpi", [row(10)], { comparison: [row(20, { unit: "m" })] });
  body = rendered().querySelector(".tl-analysis-widget");
  assert.equal(body.querySelector(".tl-analysis-kpi-compare"), null);
  assert.match(body.textContent, /Comparison unavailable/);
  setup("kpi", [row(10)], { comparison: [row(20)] });
  assert.equal(rendered().querySelector(".tl-analysis-kpi-compare").textContent, "Compare 20");
});

test("table retains raw arrays, separate athletes, sources, units and every server result", () => {
  setup("table", [row([0, 2]), row(9, { athleteId: "athlete-1", sourceConnectionId: "source-1" }), row(17, { athleteId: "athlete-2", sourceConnectionId: "source-2", unit: "m" })]);
  const rows = [...rendered().querySelectorAll(".tl-analysis-table tbody tr")];
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /Unavailable/);
  assert.match(rows[1].textContent, /Athlete name unavailable/);
  assert.match(rows[2].textContent, /Athlete name unavailable/);
  assert.equal(rows[2].children[3].textContent, "m");
});

for (const type of ["line_chart", "bar_chart"]) {
  test(`${type}: raw arrays, numeric strings and duplicate buckets are not coerced to a single point`, () => {
    for (const value of [[8], "8", false]) {
      setup(type, [row(value)]);
      const body = rendered().querySelector(".tl-analysis-widget");
      assert.equal(body.querySelector(".tl-analysis-chart-track"), null);
      assert.match(body.textContent, /Use a table/);
    }
    setup(type, [row(10), row(20)]);
    const body = rendered().querySelector(".tl-analysis-widget");
    assert.equal(body.querySelector(".tl-analysis-chart-track"), null);
    assert.match(body.textContent, /Multiple values for this group/);
  });

  test(`${type}: separate athlete/source points retain readable identity and escape source labels`, () => {
    setup(type, [row(10, { athleteId: "athlete-1", sourceConnectionId: "source-1" }), row(20, { athleteId: "athlete-2", sourceConnectionId: '<img src=x onerror="bad">' })]);
    const body = rendered().querySelector(".tl-analysis-widget");
    assert.equal(body.querySelectorAll(".tl-analysis-table tbody tr").length, 2);
    assert.match(body.textContent, /sRPE.*Athlete name unavailable/);
    assert.doesNotMatch(body.querySelector("table").outerHTML, /athlete-2|source-1/);
    assert.equal(body.querySelector("img"), null);
  });
}

test("loading is not an empty result and malformed results do not crash any widget renderer", () => {
  for (const type of ["kpi", "table", "line_chart", "bar_chart"]) {
    const analysis = setup(type, []);
    analysis.queryLoading = true;
    assert.match(rendered().querySelector(".tl-analysis-widget").textContent, /Loading/);
    analysis.queryLoading = false;
    assert.match(rendered().querySelector(".tl-analysis-widget").textContent, /No data/);
    analysis.queryResult.widgets[0].series[0].data.current = "malformed";
    assert.match(rendered().querySelector(".tl-analysis-widget").textContent, /Invalid or unavailable result/);
  }
});

test("KPI shows actual identity context and tables expose keyboard-accessible readable equivalents", () => {
  setup("kpi", [row(12, { athleteId: "athlete-1", sourceConnectionId: "source-1" })]);
  state.trainingLoad.orgPickerData = { athletes: [{ id: "athlete-1", name: "Alex" }] };
  assert.equal(rendered().querySelector(".tl-analysis-kpi-context").textContent, "Alex");
  for (const type of ["table", "line_chart", "bar_chart"]) {
    setup(type, [row(-12), row(0, { bucketKey: "2026-10-02" })]);
    const document = rendered();
    assert.equal(document.querySelector(".tl-analysis-table-wrap").getAttribute("tabindex"), "0");
    assert.equal(document.querySelector("caption").textContent, "Current period values");
    assert.deepEqual([...document.querySelectorAll("tbody tr")].map(entry => entry.children[2].textContent), ["-12", "0"]);
    if (type.includes("chart")) assert.equal(document.querySelector("details").open, true);
  }
});

test("table and chart captions keep source identifiers out of visible values", () => {
  for (const type of ["line_chart", "bar_chart", "table"]) {
    setup(type, [row(12, { sourceIdentityId: "identity-one", sourceSystem: "system-one", entryMethod: "api_import" })]);
    const body = rendered().querySelector(".tl-analysis-widget");
    assert.doesNotMatch(body.textContent, /identity-one|system-one|api_import/);
  }
});

test("V2 number formatting changes presentation only; legacy scalar text and boolean KPI values remain supported", () => {
  const analysis = setup("kpi", [row(12.345)], { config: { schemaVersion: 2, numberFormat: { maximumFractionDigits: 2 } } });
  assert.equal(rendered().querySelector(".tl-analysis-kpi-value").textContent, "12.35");
  assert.equal(analysis.queryResult.widgets[0].series[0].data.current[0].value, 12.345);
  for (const value of [false, "2026-10-01"]) {
    setup("kpi", [row(value)]);
    assert.equal(rendered().querySelector(".tl-analysis-kpi-value").textContent, String(value));
  }
});

test("tables display nested and mixed arrays losslessly while KPI and charts refuse scalar conversion", () => {
  for (const value of [[[10, 20], 30], [null, [0, false, "text", []], 30]]) {
    setup("table", [row(value)]);
    assert.equal(rendered().querySelector(".tl-analysis-table tbody tr").children[2].textContent, "Unavailable");
    for (const type of ["kpi", "line_chart", "bar_chart"]) {
      setup(type, [row(value)]);
      const body = rendered().querySelector(".tl-analysis-widget");
      assert.match(body.textContent, /Use a table/);
      assert.equal(body.querySelector(".tl-analysis-kpi-value, .tl-analysis-chart-track"), null);
    }
  }
});

for (const dashboardKind of ["template", "archived"]) {
  test(`${dashboardKind}: intentionally unqueried widgets retain empty and Choose a metric states`, () => {
    for (const type of ["kpi", "table", "line_chart", "bar_chart"]) {
      const analysis = setup(type, []);
      analysis.dashboard.is_template = dashboardKind === "template";
      analysis.dashboard.status = dashboardKind === "archived" ? "archived" : "active";
      analysis.queryResult = null;
      analysis.queryLoading = false;
      let body = rendered().querySelector(".tl-analysis-widget");
      assert.match(body.textContent, /No data/);
      assert.doesNotMatch(body.textContent, /Loading|Invalid or unavailable/);
      analysis.widgets[0].series[0].resolution_status = "unresolved";
      body = rendered().querySelector(".tl-analysis-widget");
      assert.match(body.textContent, /Choose a metric/);
      assert.doesNotMatch(body.textContent, /Loading/);
    }
  });
}

test("only an active request displays Loading when the result is null", () => {
  const analysis = setup("kpi", []);
  analysis.queryResult = null;
  analysis.queryLoading = true;
  assert.match(rendered().querySelector(".tl-analysis-widget").textContent, /Loading/);
  analysis.queryLoading = false;
  assert.doesNotMatch(rendered().querySelector(".tl-analysis-widget").textContent, /Loading/);
});

test("table omits raw provenance while preserving distinct result rows", () => {
  setup("table", [row(30, { provenance: [{ sourceConnectionId: "actual-one" }] })]);
  assert.doesNotMatch(rendered().querySelector("table").outerHTML, /actual-one|Source provenance/);
});

test("saved and preview single-metric tables render the same safe names, date, unit and values", async () => {
  const { renderSimpleEditorHtml } = await import("../training-load-simple-view.js");
  const alpha = "11911111-1111-4111-8111-111111111111";
  const zeta = "22922222-2222-4222-8222-222222222222";
  const unknown = "33933333-3333-4333-8333-333333333333";
  const analysis = setup("table", [
    row(1819.7196044920001, { athleteId: zeta, bucketKey: "2026-10-23", unit: "m", rawCount: 9 }),
    row(0, { athleteId: alpha, bucketKey: "2026-10-23", unit: "m" }),
    row(null, { athleteId: unknown, bucketKey: "2026-10-23", unit: "m" }),
  ], { config: { schemaVersion: 2, numberFormat: { maximumFractionDigits: 2 } } });
  const widget = analysis.widgets[0];
  widget.group_by = "day";
  const athletes = [{ id: zeta, name: "Zeta" }, { id: alpha, name: "Alpha" }];
  state.trainingLoad.orgPickerData = { athletes };
  const result = analysis.queryResult.widgets[0];
  const savedTable = rendered().querySelector(".tl-analysis-table");
  const preview = renderSimpleEditorHtml({ open: true, step: 3, athletes, selectedMetric: { label: "sRPE" },
    preview: { status: "valid", normalizedWidget: widget, widgetResult: result } });
  const previewTable = new JSDOM(preview).window.document.querySelector(".tl-analysis-table");
  assert.equal(savedTable.outerHTML, previewTable.outerHTML);
  assert.deepEqual([...savedTable.querySelectorAll("th")].map(cell => cell.textContent), ["Athlete", "Date", "sRPE (m)"]);
  assert.deepEqual([...savedTable.querySelectorAll("tbody tr")].map(tr => [...tr.cells].map(cell => cell.textContent)),
    [["Alpha", "23.10.2026", "0"], ["Athlete name unavailable", "23.10.2026", "—"], ["Zeta", "23.10.2026", "1819.72"]]);
  assert.doesNotMatch(savedTable.outerHTML, /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i);
  assert.doesNotMatch(preview, /rawCount|tl-simple-raw/);
});

test("shared athlete/date tables show conflicting units without merging readings", () => {
  const analysis = setup("table", [
    row(12, { athleteId: "athlete-a", bucketKey: "2026-10-23", unit: "m" }),
    row(24, { athleteId: "athlete-a", bucketKey: "2026-10-23", unit: "km" }),
  ]);
  analysis.widgets[0].group_by = "day";
  const table = rendered().querySelector(".tl-analysis-table-wrap");
  assert.match(table.textContent, /Values use different or unknown units/);
  assert.equal(table.querySelectorAll("tbody tr").length, 1);
  assert.match(table.querySelector("tbody").textContent, /Unit conflict/);
  assert.doesNotMatch(table.querySelector("tbody").textContent, /\b12\b|\b24\b/);
});

for (const grouping of ["week", "month", "cohort"]) test(grouping + " and multiple series never print UUIDs or JSON", () => {
  const id = "11911111-1111-4111-8111-111111111111";
  const a = setup("table", [row({ secret: id }, { athleteId: id, bucketKey: id, sourceConnectionId: id })]);
  a.widgets[0].group_by = grouping;
  a.widgets[0].series.push({ ...a.widgets[0].series[0], id: "second" });
  a.queryResult.widgets[0].series.push({ ...a.queryResult.widgets[0].series[0], seriesId: "second" });
  state.trainingLoad.orgPickerData = { athletes: [{ id, name: "Alex" }] };
  const table = rendered().querySelector("table");
  if (grouping === "month") {
    assert.match(rendered().querySelector(".tl-analysis-widget").textContent, /Invalid or unavailable/);
    assert.equal(table, null);
    return;
  }
  assert.match(table.textContent, /Alex/);
  assert.doesNotMatch(table.outerHTML, /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|secret|\{&quot;/i);
});

test("workspace explanation does not hide each widget error", () => {
  const a = setup("table", []);
  a.simpleWorkspaceRequired = true;
  a.queryError = "Failed";
  assert.match(rendered().querySelector(".tl-analysis-widget").textContent, /could not be loaded|Invalid or unavailable/);
});

for (const type of ["kpi", "table", "line_chart", "bar_chart"]) test(type + " hides identity and provenance", () => {
  const id = "11911111-1111-4111-8111-111111111111";
  setup(type, [row(12, { athleteId: id, bucketKey: id.toUpperCase(), sourceConnectionId: id, sourceSystem: "private-system" })]);
  state.trainingLoad.orgPickerData = { athletes: [{ id, name: "Alex" }] };
  const body = rendered().querySelector(".tl-analysis-widget");
  assert.match(body.textContent, /Alex/);
  if (type !== "kpi") assert.equal(body.querySelector("tbody tr").children[1].textContent, "Alex");
  assert.doesNotMatch(body.outerHTML, /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|Source|private-system|sourceConnectionId|sourceSystem/i);
});
for (const group of ["session", "component", "cohort"]) test(group + " buckets are distinct and stable", () => {
  const first = "11911111-1111-4111-8111-111111111111", second = "22922222-2222-4222-8222-222222222222";
  const a = setup("table", [row(1, { bucketKey: first }), row(2, { bucketKey: second }), row(3, { bucketKey: first, athleteId: "other" })]);
  a.widgets[0].group_by = group;
  const cells = [...rendered().querySelectorAll("tbody tr")].map(tr => tr.children[1].textContent);
  const kind = group === "session" ? "Session" : group === "component" ? "Component" : "Group";
  assert.equal(cells[0], kind + " 1"); assert.equal(cells[1], kind + " 2"); assert.ok(cells[2].startsWith(kind + " 1"));
});

for (const groupBy of ["session", "component", "cohort"]) test(groupBy + " labels match across every plot and table despite reversed series order and gaps", () => {
  const first = "11911111-1111-4111-8111-111111111111", second = "22922222-2222-4222-8222-222222222222";
  const a = setup("bar_chart", [row(null, { bucketKey: first }), row(2, { bucketKey: second })]);
  a.widgets[0].group_by = groupBy;
  a.widgets[0].series.push({ ...a.widgets[0].series[0], id: "series-2" });
  a.queryResult.widgets[0].series.push({ seriesId: "series-2", status: "ok", data: { current: [row(3, { bucketKey: second }), row(4, { bucketKey: first })] } });
  const before = structuredClone(a);
  const body = rendered().querySelector(".tl-analysis-widget");
  const plots = [...body.querySelectorAll("optimove-dashboard-chart")].map(node => JSON.parse(node.getAttribute("data-chart")));
  const kind = groupBy === "session" ? "Session" : groupBy === "component" ? "Component" : "Group";
  assert.deepEqual(plots.map(plot => plot.option.xAxis.data), [[kind + " 1", kind + " 2"], [kind + " 2", kind + " 1"]]);
  assert.deepEqual([...body.querySelectorAll("tbody tr")].map(tr => tr.children[1].textContent), [kind + " 1", kind + " 2", kind + " 2", kind + " 1"]);
  assert.deepEqual(a, before);
  assert.doesNotMatch(body.outerHTML, /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i);
});
test("group numbering includes an earlier row omitted from its chart", () => {
  const first = "11911111-1111-4111-8111-111111111111", second = "22922222-2222-4222-8222-222222222222";
  const a = setup("line_chart", [row(null, { athleteId: "missing", bucketKey: first }), row(2, { athleteId: "visible", bucketKey: second })]);
  a.widgets[0].group_by = "session";
  const body = rendered().querySelector(".tl-analysis-widget");
  const plots = [...body.querySelectorAll("optimove-dashboard-chart")].map(node => JSON.parse(node.getAttribute("data-chart")));
  assert.equal(plots.length, 1);
  assert.deepEqual(plots[0].option.xAxis.data, ["Session 2"]);
  assert.ok(body.querySelector("tbody tr:nth-child(2)").children[1].textContent.startsWith("Session 2"));
});

test("J21: a widget of a calculated variable says from when it has values; one of an ordinary variable says nothing new", () => {
  for (const type of ["kpi", "table", "line_chart", "bar_chart"]) {
    for (const calculated of [true, false]) {
      const analysis = setup(type, [row(null)]);
      analysis.widgets[0].series = [{ id: "series-1", metric_definition_id: "def-hmld", resolution_status: "resolved", source_policy: "all_with_conflicts" }];
      analysis.metricPicker.definitions = [{ id: "def-hmld", label: "HMLD", calculated }];
      const body = rendered().querySelector(".tl-analysis-widget");
      const note = /HMLD: Calculated for sessions imported after this variable was made\. A session imported earlier gets it only if it is corrected or imported again with changed data\./;
      if (calculated) assert.match(body.textContent, note, `${type}: the note`);
      else assert.doesNotMatch(body.textContent, /Calculated for sessions imported/, `${type}: no note`);
    }
  }
});

test("J21: the note follows the server's flag through the real read of the definitions (code review: the picker kept no flag)", async () => {
  const { loadAnalysisMetricDefinitions } = await import("../training-load-analysis-data.js");
  const previousFetch = globalThis.fetch;
  const json = (body) => ({ ok: true, status: 200, statusText: "OK", json: async () => body });
  globalThis.fetch = async (url) => String(url).includes("/metrics/definitions")
    ? json({ rows: [{ id: "def-hmld", label: "HMLD", unit: "m", calculated: true }, { id: "def-z3", label: "Zone 3", unit: "m", calculated: false }], nextCursor: null })
    : json({ rows: [] });
  try {
    for (const [def, label, expected] of [["def-hmld", "HMLD", true], ["def-z3", "Zone 3", false]]) {
      const analysis = setup("table", [row(null)]);
      state.currentUser = { id: "u1", activeWorkspace: { type: "team", scopeId: "team-1", label: "First team", role: "coach" } };
      await loadAnalysisMetricDefinitions();
      analysis.widgets[0].series = [{ id: "series-1", metric_definition_id: def, resolution_status: "resolved", source_policy: "all_with_conflicts" }];
      const body = rendered().querySelector(".tl-analysis-widget");
      if (expected) assert.match(body.textContent, new RegExp(`${label}: Calculated for sessions imported after this variable was made`));
      else assert.doesNotMatch(body.textContent, /Calculated for sessions imported/);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('ratio shows independent coverage, friendly errors and no provenance', () => {
  const a=setup('table',[row(5,{bucketKey:'2026-10-01'})]);a.widgets[0].group_by='day';
  const s=a.queryResult.widgets[0].series[0];s.calculation={kind:'ratio',scale:1,unit:'m/min'};s.coverage={includedOccasions:3,leftOutOccasions:5};
  assert.match(rendered().querySelector('.tl-analysis-widget').textContent,/5 sessions without a value/);
  s.data.current=[];s.coverage.includedOccasions=0;assert.match(rendered().querySelector('.tl-analysis-widget').textContent,/No sessions with a value/);
  s.status='error';s.error='calculation_changed_in_period';assert.match(rendered().querySelector('.tl-analysis-widget').textContent,/The calculation changed during this period. Choose a shorter period/);
});

test('Each measurement keeps ratio occasion rows separate in the shared table',()=>{
  const a=setup('table',[row(10,{athleteId:'athlete-a',bucketKey:'2026-10-01'}),row(5,{athleteId:'athlete-a',bucketKey:'2026-10-01'})]);
  a.widgets[0].group_by='day';a.widgets[0].series[0].analytical_aggregation='none';
  const rows=[...rendered().querySelectorAll('tbody tr')];assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.lastElementChild.textContent),['10','5']);
});

test('Ratio on an ordinary metric uses its own refusal sentence',()=>{
  const a=setup('table',[]);a.widgets[0].series[0].metric_definition_id='ordinary';a.widgets[0].series[0].analytical_aggregation='ratio';
  a.metricPicker.definitions=[{id:'ordinary',label:'Distance',calculation:null}];
  Object.assign(a.queryResult.widgets[0].series[0],{status:'error',error:'aggregation_not_allowed'});
  assert.match(rendered().querySelector('.tl-analysis-widget').textContent,/Ratio is only for a calculated ratio. Choose another way to combine values/);
});

test('conflicted ratio with zero included occasions stays visible in saved and preview tables',async()=>{
  const a=setup('table',[row(null,{conflict:true,bucketKey:'2026-10-01',unit:'m/min'})]);a.widgets[0].group_by='day';
  const series=a.queryResult.widgets[0].series[0];series.calculation={kind:'ratio',scale:1,unit:'m/min'};series.coverage={includedOccasions:0,leftOutOccasions:0};
  const saved=rendered().querySelector('.tl-analysis-widget');assert.match(saved.textContent,/Conflict/);assert.doesNotMatch(saved.textContent,/No sessions with a value/);
  const {renderSimpleEditorHtml}=await import('../training-load-simple-view.js');
  const preview=renderSimpleEditorHtml({open:true,step:3,athletes:[],selectedMetric:{label:'Intensity'},preview:{status:'valid',normalizedWidget:a.widgets[0],widgetResult:a.queryResult.widgets[0]}});
  assert.match(preview,/Conflict/);assert.doesNotMatch(preview,/No sessions with a value/);
});

test("server Dashboard capabilities hide writes and keep reading, export and active preference", () => {
  const analysis = setup("table", [row(12)]);
  analysis.dashboardCanManage = false;
  analysis.canCreateDashboard = false;
  analysis.menu = "dashboard";
  const document = rendered();
  for (const action of ["add-widget", "rename-dashboard", "toggle-edit", "archive", "delete-dashboard"]) {
    assert.equal(document.querySelector(`[data-action="training-load-analysis-${action}"]`), null, action);
  }
  assert.match(document.querySelector(".tl-analysis-widget").textContent, /12/);
  assert.ok(document.querySelector('[data-action="training-load-analysis-print"]'));
  assert.ok(document.querySelector('[data-action="training-load-analysis-set-active"]'));
  analysis.dashboard.is_template = true;
  assert.equal(rendered().querySelector('[data-action="training-load-analysis-clone-template"]'), null);
  analysis.canCreateDashboard = true;
  assert.ok(rendered().querySelector('[data-action="training-load-analysis-clone-template"]'));
});

test("fresh Page capability alone can remove widget and layout controls while preserving dashboard reads and preferences", () => {
  const analysis = setup("table", [row(12)]);
  analysis.pagesAvailable = true;
  analysis.selectedPageId = "page-1";
  analysis.menu = "dashboard";
  const actions = doc => ["add-widget", "toggle-edit"].map(action =>
    doc.querySelector(`[data-action="training-load-analysis-${action}"]`));
  for (const capability of [true, false, undefined]) {
    analysis.pageCanManage = capability;
    const document = rendered();
    assert.equal(actions(document).every(Boolean), capability === true);
    assert.equal(Boolean(document.querySelector(".tl-widget-menu-trigger")), capability === true);
    assert.ok(document.querySelector('[data-action="training-load-analysis-rename-dashboard"]'));
    assert.ok(document.querySelector('[data-action="training-load-analysis-print"]'));
    assert.ok(document.querySelector('[data-action="training-load-analysis-set-active"]'));
    assert.match(document.querySelector(".tl-analysis-widget").textContent, /12/);
  }
  analysis.pagesAvailable = false;
  assert.ok(actions(rendered()).every(Boolean));
});
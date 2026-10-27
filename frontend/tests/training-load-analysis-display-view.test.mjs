import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderTrainingLoadAnalysisHtml } from "../training-load-analysis-view.js";
import { emptyTrainingLoadState, state } from "../state.js";

function setup(type, current, { config = { schemaVersion: 1 }, comparison = [], resultStatus = "ok" } = {}) {
  state.trainingLoad = emptyTrainingLoadState();
  const analysis = state.trainingLoad.analysis;
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
  assert.match(rows[0].textContent, /\[0,2\]/);
  assert.match(rows[1].textContent, /athlete-1.*source-1/);
  assert.match(rows[2].textContent, /athlete-2.*source-2/);
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
    assert.match(body.textContent, /sRPE.*athlete-1.*source-1/);
    assert.match(body.textContent, /athlete-2/);
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
  assert.match(rendered().querySelector(".tl-analysis-kpi-context").textContent, /Athlete athlete-1.*Source source-1/);
  for (const type of ["table", "line_chart", "bar_chart"]) {
    setup(type, [row(-12), row(0, { bucketKey: "2026-10-02" })]);
    const document = rendered();
    assert.equal(document.querySelector(".tl-analysis-table-wrap").getAttribute("tabindex"), "0");
    assert.equal(document.querySelector("caption").textContent, "Current period values");
    assert.deepEqual([...document.querySelectorAll("tbody tr")].map(entry => entry.children[2].textContent), ["-12", "0"]);
    if (type.includes("chart")) assert.equal(document.querySelector("details").open, true);
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
    assert.equal(rendered().querySelector(".tl-analysis-table tbody tr").children[2].textContent, JSON.stringify(value));
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

test("source labels use reported provenance rather than configured connections and preserve multiple sources", () => {
  for (const type of ["table", "line_chart", "bar_chart"]) {
    const analysis = setup(type, [row(30)]);
    analysis.widgets[0].series[0].source_connection_id = "configured-only";
    let body = rendered().querySelector(".tl-analysis-widget");
    assert.doesNotMatch(body.textContent, /configured-only|Source /);
    const reported = analysis.queryResult.widgets[0].series[0].data.current[0];
    reported.sourceConnectionId = "actual-one";
    reported.provenance = [{ sourceConnectionId: "actual-one" }, { sourceConnectionId: "actual-two" }];
    body = rendered().querySelector(".tl-analysis-widget");
    assert.match(body.textContent, /Source provenance/);
    assert.match(body.textContent, /actual-one/);
    assert.match(body.textContent, /actual-two/);
    assert.doesNotMatch(body.textContent, /configured-only|Source actual-one/);
  }
});

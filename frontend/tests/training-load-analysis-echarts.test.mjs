import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { buildDashboardWidgetDisplayModel } from "../training-load-analysis-display-model.js";
import { dashboardChartPlots, renderDashboardChartPlots } from "../training-load-analysis-echarts-options.js";
import { registerDashboardChartElement } from "../training-load-analysis-echarts.js";

function model(rows, { type = "line_chart", config = null } = {}) {
  return buildDashboardWidgetDisplayModel({ id: "widget", widget_type: type, group_by: "day", display_config: config, series: [{ id: "series", built_in_series_key: "srpe" }] }, {
    widgetId: "widget", series: [{ seriesId: "series", status: "ok", data: { current: rows } }],
  });
}

const row = (value, bucketKey = "2026-10-01", extra = {}) => ({ value, bucketKey, athleteId: "athlete", unit: "AU", ...extra });
const plots = display => dashboardChartPlots(display, () => "sRPE", point => point.identity.athleteId);

test("line options preserve zero/negative values and turn missing/conflicted/non-numeric rows into gaps without mutation", () => {
  const display = model([row(-12.25), row(0, "2026-10-02"), row(null, "2026-10-03"), row(999, "2026-10-04", { conflict: true }), row("12", "2026-10-05")]);
  const before = structuredClone(display);
  const [plot] = plots(display);
  assert.deepEqual(plot.option.series[0].data.map(point => point?.value ?? null), [-12.25, 0, null, null, null]);
  assert.equal(plot.option.series[0].connectNulls, false);
  assert.equal(plot.option.tooltip.renderMode, "richText");
  assert.deepEqual(display, before);
  plot.option.series[0].data[0].value = 55;
  assert.equal(display.series[0].current[0].value, -12.25);
});

test("each athlete, actual source and unit retains its own plot and scale; duplicate buckets are never selected", () => {
  const display = model([row(1), row(2, "2026-10-02"), row(3, "2026-10-01", { athleteId: "other" }), row(4, "2026-10-01", { sourceConnectionId: "source" }), row(5, "2026-10-01", { unit: "m" })]);
  assert.equal(plots(display).length, 4);
  assert.deepEqual(plots(display).map(plot => plot.option.series[0].data.map(point => point?.value)), [[1, 2], [3], [4], [5]]);
  assert.equal(plots(model([row(1), row(2)])).length, 0);
  assert.equal(plots(model([row(null), row(false, "2026-10-02")])).length, 0);
});

test("bar widgets use an honest numeric axis for negatives and zero, with no stacking or aggregation", () => {
  const display = model([row(-15), row(0, "2026-10-02"), row(7, "2026-10-03"), row(800, "2026-10-04", { unitConflict: true })], { type: "bar_chart" });
  const [plot] = plots(display);
  assert.equal(plot.option.series[0].type, "bar");
  assert.equal(plot.option.yAxis.type, "value");
  assert.equal(plot.option.series[0].stack, undefined);
  assert.deepEqual(plot.option.series[0].data.map(point => point?.value ?? null), [-15, 0, 7, null]);
});

test("V1/absent defaults and V2 presentation settings preserve server values; unsupported versions do not draw", () => {
  for (const config of [null, { schemaVersion: 1 }, { schemaVersion: 2, legend: { visible: false }, valueLabels: { visible: true }, numberFormat: { maximumFractionDigits: 2 } }]) {
    const [plot] = plots(model([row(1.2345)], { config }));
    assert.equal(plot.option.series[0].data[0].value, 1.2345);
    assert.equal(plot.option.series[0].label.show, config?.schemaVersion === 2);
    assert.equal(plot.option.legend.show, config?.schemaVersion !== 2);
    assert.equal(plot.option.series[0].data[0].label.formatter, config?.schemaVersion === 2 ? "1.23" : "1.2");
  }
  assert.equal(plots(model([row(1)], { config: { schemaVersion: 99 } })).length, 0);
});

test("hostile captions, bucket and series text stay data, never executable HTML", () => {
  const hostile = '<img src=x onerror="bad">';
  const html = renderDashboardChartPlots(model([row(1, hostile)]), () => hostile, () => hostile);
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector("img"), null);
  assert.match(document.querySelector("figcaption").textContent, /<img/);
  const payload = JSON.parse(document.querySelector("optimove-dashboard-chart").getAttribute("data-chart"));
  assert.deepEqual(payload.option.xAxis.data, [hostile]);
  assert.equal(payload.option.tooltip.formatter, undefined);
});

function harness(loader) {
  const window = new JSDOM("<main></main>").window;
  let resize;
  let disconnects = 0;
  window.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() { disconnects += 1; }
  };
  registerDashboardChartElement(window, loader);
  const host = window.document.createElement("optimove-dashboard-chart");
  host.setAttribute("data-chart", JSON.stringify(plots(model([row(1)]))[0]));
  host.innerHTML = '<div class="tl-analysis-echarts"></div><p class="tl-analysis-chart-failure" hidden></p>';
  Object.defineProperties(host.firstElementChild, { clientWidth: { value: 300 }, clientHeight: { value: 220 } });
  return { window, host, resize: () => resize?.(), disconnects: () => disconnects, mount: () => window.document.querySelector("main").append(host) };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test("mount, resize and DOM replacement dispose exactly one chart and disconnect its observer", async () => {
  const counts = { init: 0, resize: 0, dispose: 0 };
  const fixture = harness(async () => ({ init: () => {
    counts.init += 1;
    return { setOption(option) { assert.equal(option.tooltip.valueFormatter(1.23), "1.2"); }, resize() { counts.resize += 1; }, dispose() { counts.dispose += 1; } };
  } }));
  fixture.mount();
  await settle();
  fixture.resize();
  fixture.host.remove();
  fixture.resize();
  assert.deepEqual(counts, { init: 1, resize: 1, dispose: 1 });
  assert.equal(fixture.disconnects(), 1);
  fixture.window.close();
});

test("a delayed library cannot mount removed DOM or a stale connection after reattachment", async () => {
  const resolvers = [];
  let inits = 0;
  const fixture = harness(() => new Promise(resolve => resolvers.push(resolve)));
  const library = { init: () => { inits += 1; return { setOption() {}, resize() {}, dispose() {} }; } };
  fixture.mount();
  fixture.host.remove();
  fixture.mount();
  resolvers[0](library);
  await settle();
  assert.equal(inits, 0);
  resolvers[1](library);
  await settle();
  assert.equal(inits, 1);
  fixture.window.close();
});

test("library and rendering failures leave an explicit fallback and release partial instances", async () => {
  let disposed = 0;
  for (const loader of [async () => { throw Error("load failed"); }, async () => ({ init: () => ({ setOption() { throw Error("draw failed"); }, dispose() { disposed += 1; } }) })]) {
    const fixture = harness(loader);
    fixture.mount();
    await settle();
    assert.equal(fixture.host.querySelector(".tl-analysis-chart-failure").hidden, false);
    assert.equal(fixture.host.querySelector(".tl-analysis-echarts").hidden, true);
    fixture.window.close();
  }
  assert.equal(disposed, 1);
});

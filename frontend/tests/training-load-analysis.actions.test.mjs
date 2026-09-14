import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let queried = {};
let queriedAll = {};
let browserListeners = {};
function addBrowserListener(type, handler) {
  browserListeners[type] = browserListeners[type] || new Set();
  browserListeners[type].add(handler);
}
function removeBrowserListener(type, handler) {
  browserListeners[type]?.delete(handler);
}
function dispatchBrowserEvent(type, event) {
  for (const handler of browserListeners[type] || []) handler(event);
}
globalThis.document = {
  querySelector: (sel) => queried[sel] || null,
  querySelectorAll: (sel) => queriedAll[sel] || [],
  addEventListener: addBrowserListener,
  removeEventListener: removeBrowserListener,
  body: { classList: { contains: () => false } },
};
globalThis.window = {
  confirm: () => true,
  prompt: (_message, fallback) => fallback,
  matchMedia: () => ({ matches: false }),
  addEventListener: addBrowserListener,
  removeEventListener: removeBrowserListener,
};

let fetchCalls;
let pointerCaptureLog = [];
function installFetchMock(responder) {
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    fetchCalls.push(call);
    const result = await responder(call);
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
}

const { bindTrainingLoadAnalysisLayoutInteractions, handleTrainingLoadAction, handleTrainingLoadAnalysisPointerDown, handleTrainingLoadAnalysisPointerEnd, handleTrainingLoadAnalysisPointerMove } = await import("../training-load-actions.js");
const { loadTrainingLoadAnalysis, loadAnalysisMetricDefinitions, queryAnalysisDashboard } = await import("../training-load-analysis-data.js");
const { renderTrainingLoadAnalysisHtml } = await import("../training-load-analysis-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");

const dashboardId = "11111111-1111-4111-8111-111111111111";
const templateId = "22222222-2222-4222-8222-222222222222";
const widgetId = "33333333-3333-4333-8333-333333333333";
const secondWidgetId = "44444444-4444-4444-8444-444444444444";
const seriesId = "55555555-5555-4555-8555-555555555555";
const metricId = "66666666-6666-4666-8666-666666666666";
const activityId = "77777777-7777-4777-8777-777777777777";
const componentId = "88888888-8888-4888-8888-888888888888";

function resetState() {
  clearAllViewCache();
  pointerCaptureLog = [];
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "private_coach", scopeId: "coach-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  state.athletes = [];
  queried = {};
  queriedAll = {};
  browserListeners = {};
}

function fakeAction(dataset, value = "") {
  return { dataset, value };
}

function dashboard(overrides = {}) {
  return {
    id: dashboardId,
    name: "Load board",
    description: "Team readiness",
    status: "active",
    is_template: false,
    revision: 3,
    default_filter: null,
    ...overrides,
  };
}

function widget(overrides = {}) {
  return {
    id: widgetId,
    widget_type: "kpi",
    title: "Average RPE",
    widget_order: 1,
    x: 0,
    y: 0,
    width: 3,
    height: 3,
    mobile_order: 1,
    group_by: "day",
    state: "ready",
    display_config: { schemaVersion: 1 },
    local_filter_override: null,
    revision: 4,
    series: [{
      id: seriesId,
      series_order: 1,
      built_in_series_key: "rpe",
      metric_definition_id: null,
      display_label: "RPE",
      axis: "primary",
      data_scope_level: "session",
      analytical_aggregation: "avg",
      source_policy: "all_with_conflicts",
      aggregation_role_policy: "standalone_only",
      coverage_policy: "complete_only",
      comparison_period: null,
      resolution_status: "resolved",
    }],
    ...overrides,
  };
}

function detail(overrides = {}) {
  return { dashboard: dashboard(overrides.dashboard), widgets: overrides.widgets || [widget()] };
}

function renderTrainingLoad() {}

function analysisWidgetDataset(widgetId) {
  return { analysisWidgetId: widgetId };
}

function pointerEvent(widgetId, mode, pointerId, clientX, clientY) {
  const handle = {
    matches: (selector) => mode === "resize" && selector.includes("resize"),
    closest: (selector) => selector.includes("data-analysis-widget-id") ? { dataset: analysisWidgetDataset(widgetId) } : null,
    setPointerCapture: (id) => pointerCaptureLog.push(["capture", id]),
    releasePointerCapture: (id) => pointerCaptureLog.push(["release", id]),
  };
  const child = { closest: (selector) => handle };
  return {
    pointerId, clientX, clientY,
    target: child,
    preventDefault() {},
  };
}

function mouseEvent(widgetId, mode, clientX, clientY) {
  const event = pointerEvent(widgetId, mode, undefined, clientX, clientY);
  delete event.pointerId;
  return event;
}

function widgetBodyMouseEvent(widgetId, clientX, clientY) {
  const dragHandle = {
    matches: () => false,
    closest: (selector) => selector.includes("data-analysis-widget-id") ? { dataset: analysisWidgetDataset(widgetId) } : null,
    setPointerCapture: (id) => pointerCaptureLog.push(["capture", id]),
    releasePointerCapture: (id) => pointerCaptureLog.push(["release", id]),
  };
  const widgetEl = {
    dataset: analysisWidgetDataset(widgetId),
    querySelector: (selector) => selector.includes("data-analysis-drag-handle") ? dragHandle : null,
  };
  return {
    clientX,
    clientY,
    target: {
      closest: (selector) => {
        if (selector.includes("data-analysis-widget-id")) return widgetEl;
        if (selector.includes("button") || selector.includes("data-action")) return null;
        return null;
      },
    },
    preventDefault() {},
  };
}

function eventTargetStub({ interactive = false } = {}) {
  return {
    closest: (selector) => {
      if (interactive && (selector.includes("button") || selector.includes("data-action"))) return {};
      return null;
    },
  };
}

function analysisElementStub(widgetId) {
  const listeners = new Map();
  const dragHandle = {
    matches: (selector) => !selector.includes("resize"),
    closest: (selector) => {
      if (selector.includes("data-analysis-drag-handle")) return dragHandle;
      if (selector.includes("data-analysis-widget-id")) return widgetEl;
      return null;
    },
    setPointerCapture: (id) => pointerCaptureLog.push(["capture", id]),
    releasePointerCapture: (id) => pointerCaptureLog.push(["release", id]),
    addEventListener: (type, handler) => listeners.set(`drag:${type}`, handler),
  };
  const resizeHandle = {
    matches: (selector) => selector.includes("resize"),
    closest: (selector) => {
      if (selector.includes("data-analysis-resize-handle")) return resizeHandle;
      if (selector.includes("data-analysis-widget-id")) return widgetEl;
      return null;
    },
    setPointerCapture: (id) => pointerCaptureLog.push(["capture", id]),
    releasePointerCapture: (id) => pointerCaptureLog.push(["release", id]),
    addEventListener: (type, handler) => listeners.set(`resize:${type}`, handler),
  };
  const widgetEl = {
    dataset: analysisWidgetDataset(widgetId),
    querySelector: (selector) => selector.includes("resize") ? resizeHandle : dragHandle,
    addEventListener: (type, handler) => listeners.set(`widget:${type}`, handler),
  };
  return { dragHandle, resizeHandle, widgetEl, listeners };
}

function analysisDomTreeStub(widgetId) {
  const listeners = new Map();
  const styleValues = new Map();
  const widgetEl = {
    tagName: "ARTICLE",
    dataset: analysisWidgetDataset(widgetId),
    style: { setProperty: (name, value) => styleValues.set(name, value) },
    querySelector: (selector) => {
      if (selector.includes("data-analysis-resize-handle")) return resizeHandle;
      if (selector.includes("data-analysis-drag-handle")) return dragHandle;
      return null;
    },
    addEventListener: (type, handler) => {
      listeners.set(`widget:${type}`, handler);
    },
    dispatchEvent: (event) => {
      event.target = event.target || widgetEl;
      listeners.get(`widget:${event.type}`)?.(event);
      return true;
    },
  };
  const dragHandle = {
    tagName: "BUTTON",
    dataset: {},
    matches: (selector) => selector.includes("data-analysis-drag-handle") && !selector.includes("resize"),
    closest: (selector) => {
      if (selector.includes("data-analysis-drag-handle")) return dragHandle;
      if (selector.includes("data-analysis-widget-id")) return widgetEl;
      return null;
    },
    setPointerCapture: (id) => pointerCaptureLog.push(["capture", id]),
    releasePointerCapture: (id) => pointerCaptureLog.push(["release", id]),
    addEventListener: (type, handler) => {
      listeners.set(`drag:${type}`, handler);
    },
    removeAttribute() {},
    dispatchEvent: (event) => {
      event.target = dragHandle;
      listeners.get(`drag:${event.type}`)?.(event);
      return true;
    },
  };
  const resizeHandle = {
    tagName: "BUTTON",
    dataset: {},
    matches: (selector) => selector.includes("data-analysis-resize-handle"),
    closest: (selector) => {
      if (selector.includes("data-analysis-resize-handle")) return resizeHandle;
      if (selector.includes("data-analysis-widget-id")) return widgetEl;
      return null;
    },
    setPointerCapture: (id) => pointerCaptureLog.push(["capture", id]),
    releasePointerCapture: (id) => pointerCaptureLog.push(["release", id]),
    addEventListener: (type, handler) => {
      listeners.set(`resize:${type}`, handler);
    },
    dispatchEvent: (event) => {
      event.target = resizeHandle;
      listeners.get(`resize:${event.type}`)?.(event);
      return true;
    },
  };
  return { widgetEl, dragHandle, resizeHandle, styleValues };
}

function dispatchedPointerEvent(type, pointerId, clientX, clientY) {
  return {
    type,
    pointerId,
    clientX,
    clientY,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  };
}

test("Analysis load selects active dashboard and queries it through the single batch endpoint", async () => {
  resetState();
  installFetchMock(async (call) => {
    if (call.url === "/api/training-load/dashboards") {
      return { status: 200, body: { dashboards: [dashboard(), dashboard({ id: templateId, name: "Template", is_template: true })] } };
    }
    if (call.url === "/api/training-load/dashboards/active") {
      return { status: 200, body: { activeDashboard: { dashboard_id: dashboardId } } };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}`) {
      assert.equal(call.method, "GET");
      return { status: 200, body: detail() };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}/query`) {
      return {
        status: 200,
        body: {
          dashboardRevision: 3,
          widgets: [{
            widgetId,
            series: [{ seriesId, status: "ok", data: { current: [{ bucketKey: "2026-09-01", value: 6.5, unit: "RPE" }], comparison: [] } }],
          }],
        },
      };
    }
    return { status: 404, body: { error: "unexpected" } };
  });

  await loadTrainingLoadAnalysis(renderTrainingLoad);

  assert.equal(state.trainingLoad.analysis.selectedDashboardId, dashboardId);
  assert.equal(state.trainingLoad.analysis.dashboard.name, "Load board");
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/query")).length, 1);
  assert.equal(fetchCalls.some((c) => c.url.includes("/widgets/") && c.url.endsWith("/query")), false);
  assert.deepEqual(fetchCalls.find((c) => c.url.endsWith("/query")).body.athleteIds, undefined);
});

test("Analysis renders real KPI and table results from the batch response", () => {
  resetState();
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.widgets = [
    widget(),
    widget({
      id: secondWidgetId,
      widget_type: "table",
      title: "Session load",
      mobile_order: 2,
      series: [{ ...widget().series[0], id: "99999999-9999-4999-8999-999999999999", display_label: "sRPE", built_in_series_key: "srpe" }],
    }),
  ];
  state.trainingLoad.analysis.queryResult = {
    dashboardRevision: 3,
    widgets: [{
      widgetId,
      series: [{ seriesId, status: "ok", data: { current: [{ bucketKey: "2026-09-01", value: 7.5, unit: "RPE" }], comparison: [] } }],
    }, {
      widgetId: secondWidgetId,
      series: [{
        seriesId: "99999999-9999-4999-8999-999999999999",
        status: "ok",
        data: { current: [{ bucketKey: "2026-09-01", value: 420, unit: "AU", conflict: true, unitConflict: true }], comparison: [] },
      }],
    }],
  };

  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, />7\.5</);
  assert.match(html, /Session load/);
  assert.match(html, /420/);
  assert.match(html, /Conflict \/ Unit conflict/);
});

test("Analysis edit layout markup exposes direct delete and CSS applies saved grid rows", () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.editMode = true;
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [widget({ y: 2, height: 3 })];

  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /data-action="training-load-analysis-delete-widget"/);
  assert.match(html, /class="tl-analysis-widget-delete"/);
  assert.match(html, /class="tl-analysis-widget-move"/);
  assert.match(html, /data-analysis-drag-handle="true"/);
  assert.doesNotMatch(html, /draggable="true"/);
  assert.match(html, /data-analysis-resize-handle/);

  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.tl-analysis-widget\s*\{[\s\S]*grid-row:\s*calc\(var\(--tl-y\) \+ 1\) \/ span var\(--tl-h\);/);
  assert.match(css, /\.tl-analysis-grid\s*\{[\s\S]*grid-auto-rows:\s*46px;/);
  assert.match(css, /\.tl-analysis-resize-handle\s*\{[\s\S]*width:\s*42px;[\s\S]*height:\s*42px;/);
  assert.match(css, /\.tl-analysis-widget-delete\s*\{/);
  assert.match(css, /\.tl-analysis-widget-move\s*\{/);
});

test("Analysis actions save active dashboard, runtime filters, widgets, series and atomic layout", async () => {
  resetState();
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [widget(), widget({ id: secondWidgetId, title: "Duration", mobile_order: 2, x: 3 })];
  installFetchMock(async (call) => {
    if (call.url === "/api/training-load/dashboards/active") {
      assert.equal(call.method, "POST");
      assert.deepEqual(call.body, { dashboardId });
      return { status: 200, body: { activeDashboard: { dashboard_id: dashboardId } } };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}/query`) {
      return { status: 200, body: { dashboardRevision: 3, widgets: [] } };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}/layout`) {
      assert.equal(call.method, "PUT");
      assert.equal(call.body.expectedRevision, 3);
      assert.equal(call.body.layout.length, 2);
      return { status: 200, body: detail({ dashboard: { revision: 4 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets`) {
      assert.equal(call.method, "POST");
      assert.equal(call.body.widgetType, "bar_chart");
      return { status: 201, body: detail({ dashboard: { revision: 4 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series`) {
      assert.equal(call.method, "POST");
      assert.equal(call.body.expectedWidgetRevision, 4);
      assert.equal(call.body.builtInSeriesKey, "srpe");
      return { status: 201, body: detail({ dashboard: { revision: 4 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series/${seriesId}/resolve`) {
      assert.equal(call.method, "POST");
      assert.equal(call.body.metricDefinitionId, metricId);
      return { status: 200, body: detail({ dashboard: { revision: 4 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}`) {
      assert.equal(call.method, "PATCH");
      assert.equal(call.body.localFilterOverride.activityId, activityId);
      return { status: 200, body: detail({ dashboard: { revision: 4 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}`) {
      return { status: 200, body: detail({ dashboard: { revision: 4 } }) };
    }
    return { status: 404, body: { error: "unexpected" } };
  });

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-set-active" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.activeDashboardId, dashboardId);

  // 3B3 UX slice: the runtime activity/component filter is now set via the
  // Calendar hand-off (training-load-analysis-open-in-analysis - see
  // training-load-calendar.actions.test.mjs), never typed here - exercise
  // the same underlying state fields + query call directly to keep proving
  // the batch-query payload contract this test is actually about.
  state.trainingLoad.analysis.runtimeFilter.activityId = activityId;
  await queryAnalysisDashboard(renderTrainingLoad, { force: true });
  state.trainingLoad.analysis.runtimeFilter.componentId = componentId;
  await queryAnalysisDashboard(renderTrainingLoad, { force: true });
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/query")).length, 2);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-widget-activity-filter", widgetId }, activityId), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-create-widget", widgetType: "bar_chart" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-add-series", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-series-bind-metric", widgetId, seriesId, metricId }), { renderTrainingLoad });

  state.trainingLoad.analysis.widgets = [widget(), widget({ id: secondWidgetId, title: "Duration", mobile_order: 2, x: 3 })];
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-widget-right", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-widget-mobile-down", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-save-layout" }), { renderTrainingLoad });

  assert.equal(fetchCalls.some((c) => c.url === `/api/training-load/dashboards/${dashboardId}/layout`), true);
  assert.equal(fetchCalls.some((c) => c.url.endsWith("/query") && c.body.activityId === activityId && c.body.componentId === componentId), true);
});

test("Analysis dashboard selection and runtime filters use the selected dashboard query", async () => {
  resetState();
  state.trainingLoad.analysis.dashboards = [dashboard(), dashboard({ id: secondWidgetId, name: "Second board" })];
  installFetchMock(async (call) => {
    if (call.url === `/api/training-load/dashboards/${secondWidgetId}`) {
      return { status: 200, body: detail({ dashboard: { id: secondWidgetId, name: "Second board" } }) };
    }
    if (call.url === `/api/training-load/dashboards/${secondWidgetId}/query`) {
      assert.equal(call.body.dateFrom, state.trainingLoad.analysis.period.dateFrom);
      assert.equal(call.body.dateTo, state.trainingLoad.analysis.period.dateTo);
      assert.equal(call.body.activityId, activityId);
      assert.equal(call.body.componentId, componentId);
      return { status: 200, body: { dashboardRevision: 3, widgets: [] } };
    }
    return { status: 404, body: { error: "unexpected" } };
  });

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-select-dashboard" }, secondWidgetId), { renderTrainingLoad });
  state.trainingLoad.analysis.runtimeFilter.activityId = activityId;
  state.trainingLoad.analysis.runtimeFilter.componentId = componentId;
  await queryAnalysisDashboard(renderTrainingLoad, { force: true });

  assert.equal(state.trainingLoad.analysis.selectedDashboardId, secondWidgetId);
  assert.equal(state.trainingLoad.analysis.runtimeFilter.activityId, activityId);
  assert.equal(state.trainingLoad.analysis.runtimeFilter.componentId, componentId);
});

test("Analysis drag and resize stay local until one atomic layout save; cancel is local", async () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.editMode = true;
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [widget()];
  queried[".tl-analysis-grid"] = { getBoundingClientRect: () => ({ width: 1200 }) };
  const styleUpdates = [];
  queriedAll["[data-analysis-widget-id]"] = [{
    dataset: analysisWidgetDataset(widgetId),
    style: { setProperty: (name, value) => styleUpdates.push([name, value]) },
  }];
  installFetchMock(async (call) => {
    if (call.url === `/api/training-load/dashboards/${dashboardId}/layout`) {
      assert.equal(call.method, "PUT");
      assert.deepEqual(call.body, {
        expectedRevision: 3,
        layout: [{ widgetId, x: 1, y: 1, width: 4, height: 3, mobileOrder: 1 }],
      });
      return { status: 200, body: detail({ dashboard: { revision: 4 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}`) return { status: 200, body: detail({ dashboard: { revision: 4 } }) };
    if (call.url === `/api/training-load/dashboards/${dashboardId}/query`) return { status: 200, body: { dashboardRevision: 4, widgets: [] } };
    if (call.url === "/api/training-load/dashboards") return { status: 200, body: { dashboards: [dashboard()] } };
    return { status: 404, body: { error: "unexpected" } };
  });

  let renderCount = 0;
  const renderDuringPointer = () => { renderCount += 1; };

  assert.equal(handleTrainingLoadAnalysisPointerDown(pointerEvent(widgetId, "drag", 1, 0, 0), renderDuringPointer), true);
  assert.deepEqual(pointerCaptureLog, [["capture", 1]]);
  handleTrainingLoadAnalysisPointerMove(pointerEvent(widgetId, "drag", 1, 100, 56));
  handleTrainingLoadAnalysisPointerMove(pointerEvent(widgetId, "drag", 1, 110, 60));
  assert.deepEqual(state.trainingLoad.analysis.layoutDraft[0], { widgetId, x: 1, y: 1, width: 3, height: 3, mobileOrder: 1 });
  assert.deepEqual(styleUpdates.slice(-5), [
    ["--tl-x", "1"],
    ["--tl-y", "1"],
    ["--tl-w", "3"],
    ["--tl-h", "3"],
    ["--tl-mobile", "1"],
  ]);
  assert.equal(renderCount, 0);
  handleTrainingLoadAnalysisPointerEnd({ pointerId: 1 });
  assert.equal(renderCount, 1);
  assert.deepEqual(pointerCaptureLog, [["capture", 1], ["release", 1]]);
  assert.equal(fetchCalls.length, 0);

  assert.equal(handleTrainingLoadAnalysisPointerDown(pointerEvent(widgetId, "resize", 2, 0, 0), renderTrainingLoad), true);
  handleTrainingLoadAnalysisPointerMove(pointerEvent(widgetId, "resize", 2, 100, 56));
  assert.deepEqual(state.trainingLoad.analysis.layoutDraft[0], { widgetId, x: 1, y: 1, width: 4, height: 3, mobileOrder: 1 });
  handleTrainingLoadAnalysisPointerEnd({ pointerId: 2 });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-save-layout" }), { renderTrainingLoad });
  assert.equal(fetchCalls.filter((call) => call.url.endsWith("/layout")).length, 1);

  state.trainingLoad.analysis.layoutDraft = [{ widgetId, x: 9, y: 9, width: 1, height: 1, mobileOrder: 1 }];
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-cancel-layout" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.layoutDraft, null);
  assert.equal(fetchCalls.filter((call) => call.url.endsWith("/layout")).length, 1);
});

test("Analysis pointer drag/resize is disabled once the viewport matches the Analysis mobile breakpoint - Move up/down is the real mobile reorder path", () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.editMode = true;
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [widget()];
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ matches: query.includes("max-width: 720px") });
  try {
    assert.equal(handleTrainingLoadAnalysisPointerDown(pointerEvent(widgetId, "drag", 1, 0, 0), renderTrainingLoad), false, "pointer drag must not start once the viewport matches the Analysis mobile breakpoint");
    assert.equal(handleTrainingLoadAnalysisPointerDown(pointerEvent(widgetId, "resize", 2, 0, 0), renderTrainingLoad), false, "pointer resize must not start either");
    assert.equal(state.trainingLoad.analysis.layoutDraft, null, "no draft should exist from a gesture that never started");
  } finally {
    window.matchMedia = originalMatchMedia;
  }
});

test("Analysis pointer layout clamps widget type limits and the 12-column grid", () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.editMode = true;
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [
    widget({ x: 10, width: 3, height: 3 }),
    widget({ id: secondWidgetId, widget_type: "table", x: 0, y: 20, width: 12, height: 12, mobile_order: 2 }),
  ];
  queried[".tl-analysis-grid"] = { getBoundingClientRect: () => ({ width: 1200 }) };

  assert.equal(handleTrainingLoadAnalysisPointerDown(pointerEvent(widgetId, "drag", 3, 0, 0), renderTrainingLoad), true);
  handleTrainingLoadAnalysisPointerMove(pointerEvent(widgetId, "drag", 3, 9999, 0));
  handleTrainingLoadAnalysisPointerEnd({ pointerId: 3 });
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].x, 9);

  assert.equal(handleTrainingLoadAnalysisPointerDown(pointerEvent(widgetId, "resize", 4, 0, 0), renderTrainingLoad), true);
  handleTrainingLoadAnalysisPointerMove(pointerEvent(widgetId, "resize", 4, 9999, 9999));
  handleTrainingLoadAnalysisPointerEnd({ pointerId: 4 });
  assert.deepEqual(state.trainingLoad.analysis.layoutDraft[0], {
    widgetId, x: 8, y: 0, width: 4, height: 3, mobileOrder: 1,
  });

  assert.equal(handleTrainingLoadAnalysisPointerDown(pointerEvent(secondWidgetId, "resize", 5, 0, 0), renderTrainingLoad), true);
  handleTrainingLoadAnalysisPointerMove(pointerEvent(secondWidgetId, "resize", 5, -9999, -9999));
  handleTrainingLoadAnalysisPointerEnd({ pointerId: 5 });
  assert.equal(state.trainingLoad.analysis.layoutDraft[1].width, 3);
  assert.equal(state.trainingLoad.analysis.layoutDraft[1].height, 3);
  assert.equal(state.trainingLoad.analysis.layoutDraft[1].x, 0);
  assert.equal(state.trainingLoad.analysis.layoutDraft[1].y, 20);
});

test("Analysis layout nudges overlapping widgets to the next free row", () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.editMode = true;
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [
    widget({ x: 0, y: 0, width: 4, height: 3 }),
    widget({ id: secondWidgetId, widget_type: "table", x: 0, y: 3, width: 6, height: 4, mobile_order: 2 }),
  ];
  queried[".tl-analysis-grid"] = { getBoundingClientRect: () => ({ width: 1200 }) };

  assert.equal(handleTrainingLoadAnalysisPointerDown(pointerEvent(widgetId, "drag", 6, 0, 0), renderTrainingLoad), true);
  handleTrainingLoadAnalysisPointerMove(pointerEvent(widgetId, "drag", 6, 0, 168));
  handleTrainingLoadAnalysisPointerEnd({ pointerId: 6 });
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].y, 7);
  assert.equal(state.trainingLoad.analysis.layoutDraft[1].y, 3);
});

test("Analysis drag and resize also accept mouse fallback events without pointerId", () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.editMode = true;
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [widget()];
  queried[".tl-analysis-grid"] = { getBoundingClientRect: () => ({ width: 1200 }) };

  assert.equal(handleTrainingLoadAnalysisPointerDown(mouseEvent(widgetId, "drag", 0, 0), renderTrainingLoad), true);
  handleTrainingLoadAnalysisPointerMove(mouseEvent(widgetId, "drag", 110, 60));
  handleTrainingLoadAnalysisPointerEnd({});
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].x, 1);
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].y, 1);

  assert.equal(handleTrainingLoadAnalysisPointerDown(mouseEvent(widgetId, "resize", 0, 0), renderTrainingLoad), true);
  handleTrainingLoadAnalysisPointerMove(mouseEvent(widgetId, "resize", 110, 60));
  handleTrainingLoadAnalysisPointerEnd({});
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].width, 4);
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].height, 3);
});

test("Analysis drag can start from non-interactive widget body in edit mode", () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.editMode = true;
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [widget()];
  queried[".tl-analysis-grid"] = { getBoundingClientRect: () => ({ width: 1200 }) };

  assert.equal(handleTrainingLoadAnalysisPointerDown(widgetBodyMouseEvent(widgetId, 0, 0), renderTrainingLoad), true);
  handleTrainingLoadAnalysisPointerMove(widgetBodyMouseEvent(widgetId, 110, 60));
  handleTrainingLoadAnalysisPointerEnd({});
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].x, 1);
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].y, 1);
});

test("Analysis direct widget bindings start drag from the rendered card but ignore buttons", () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.editMode = true;
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [widget()];
  queried[".tl-analysis-grid"] = { getBoundingClientRect: () => ({ width: 1200 }) };
  const { widgetEl, listeners } = analysisElementStub(widgetId);
  const root = { querySelectorAll: () => [widgetEl] };

  bindTrainingLoadAnalysisLayoutInteractions(root, renderTrainingLoad);
  listeners.get("widget:mousedown")({
    type: "mousedown",
    clientX: 0,
    clientY: 0,
    target: eventTargetStub({ interactive: true }),
    preventDefault() {},
  });
  assert.equal(state.trainingLoad.analysis.layoutDraft, null);

  listeners.get("widget:mousedown")({
    type: "mousedown",
    clientX: 0,
    clientY: 0,
    target: eventTargetStub(),
    preventDefault() {},
  });
  handleTrainingLoadAnalysisPointerMove(mouseEvent(widgetId, "drag", 110, 60));
  handleTrainingLoadAnalysisPointerEnd({});
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].x, 1);
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].y, 1);
});

test("Analysis delegated DOM pointer flow changes local drag and resize draft without PUT", () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.editMode = true;
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [widget({ id: "widget-1", widget_type: "table", x: 0, y: 0, width: 3, height: 3 })];
  queried[".tl-analysis-grid"] = { getBoundingClientRect: () => ({ width: 1200 }) };
  const { widgetEl, dragHandle, resizeHandle, styleValues } = analysisDomTreeStub("widget-1");
  queriedAll["[data-analysis-widget-id]"] = [widgetEl];
  installFetchMock(async () => {
    throw new Error("Drag/resize must not send requests");
  });

  bindTrainingLoadAnalysisLayoutInteractions({ querySelectorAll: () => [widgetEl] }, renderTrainingLoad);
  dragHandle.dispatchEvent(dispatchedPointerEvent("pointerdown", 41, 0, 0));
  dispatchBrowserEvent("pointermove", dispatchedPointerEvent("pointermove", 41, 110, 60));
  dispatchBrowserEvent("pointerup", dispatchedPointerEvent("pointerup", 41, 110, 60));
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].x, 1);
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].y, 1);
  assert.equal(styleValues.get("--tl-x"), "1");
  assert.equal(styleValues.get("--tl-y"), "1");

  resizeHandle.dispatchEvent(dispatchedPointerEvent("pointerdown", 42, 0, 0));
  dispatchBrowserEvent("pointermove", dispatchedPointerEvent("pointermove", 42, 220, 120));
  dispatchBrowserEvent("pointerup", dispatchedPointerEvent("pointerup", 42, 220, 120));
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].width, 5);
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].height, 5);
  assert.equal(styleValues.get("--tl-w"), "5");
  assert.equal(styleValues.get("--tl-h"), "5");
  assert.equal(fetchCalls.length, 0);
});

test("Analysis mouse fallback continues a pointer gesture without resetting it", () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.editMode = true;
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [widget()];
  queried[".tl-analysis-grid"] = { getBoundingClientRect: () => ({ width: 1200 }) };

  assert.equal(handleTrainingLoadAnalysisPointerDown(pointerEvent(widgetId, "drag", 19, 0, 0), renderTrainingLoad), true);
  assert.equal(handleTrainingLoadAnalysisPointerDown(mouseEvent(widgetId, "drag", 0, 0), renderTrainingLoad), true);
  handleTrainingLoadAnalysisPointerMove(mouseEvent(widgetId, "drag", 110, 60));
  handleTrainingLoadAnalysisPointerEnd({});
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].x, 1);
  assert.equal(state.trainingLoad.analysis.layoutDraft[0].y, 1);
});

test("Analysis mobile ordering uses the local draft and stale layout revisions reload", async () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.editMode = true;
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [widget(), widget({ id: secondWidgetId, mobile_order: 2 })];
  installFetchMock(async (call) => {
    if (call.url === `/api/training-load/dashboards/${dashboardId}/layout`) return { status: 409, body: { error: "staleRevision" } };
    if (call.url === `/api/training-load/dashboards/${dashboardId}`) return { status: 200, body: detail({ dashboard: { revision: 10 } }) };
    if (call.url === `/api/training-load/dashboards/${dashboardId}/query`) return { status: 200, body: { dashboardRevision: 10, widgets: [] } };
    return { status: 404, body: { error: "unexpected" } };
  });

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-widget-mobile-down", widgetId }), { renderTrainingLoad });
  assert.deepEqual(state.trainingLoad.analysis.layoutDraft.map((entry) => entry.widgetId), [secondWidgetId, widgetId]);
  assert.deepEqual(state.trainingLoad.analysis.layoutDraft.map((entry) => entry.mobileOrder), [1, 2]);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-save-layout" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.notice, "Dashboard changed on the server. Reloaded the latest version.");
  assert.equal(state.trainingLoad.analysis.dashboard.revision, 10);
});

test("Analysis widget and series configuration uses revision-guarded endpoints", async () => {
  resetState();
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [widget(), widget({ id: secondWidgetId, mobile_order: 2 })];
  installFetchMock(async (call) => {
    if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets`) {
      assert.equal(call.method, "POST");
      assert.equal(call.body.widgetType, "line_chart");
      return { status: 201, body: detail({ dashboard: { revision: 4 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}` && call.method === "PATCH") {
      assert.equal(call.body.expectedWidgetRevision, 4);
      assert.equal(call.body.title, "Readiness");
      return { status: 200, body: detail({ dashboard: { revision: 5 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${secondWidgetId}` && call.method === "DELETE") {
      assert.equal(call.body.expectedWidgetRevision, 4);
      return { status: 200, body: detail({ dashboard: { revision: 6 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series`) {
      assert.equal(call.method, "POST");
      assert.equal(call.body.builtInSeriesKey, "srpe");
      return { status: 201, body: detail({ dashboard: { revision: 7 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series/${seriesId}` && call.method === "DELETE") {
      return { status: 200, body: detail({ dashboard: { revision: 8 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series/reorder`) {
      assert.equal(call.method, "PUT");
      assert.deepEqual(call.body.order, [{ seriesId, seriesOrder: 1 }]);
      return { status: 200, body: detail({ dashboard: { revision: 9 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}` && call.method === "GET") return { status: 200, body: detail({ dashboard: { revision: 9 } }) };
    if (call.url === `/api/training-load/dashboards/${dashboardId}/query`) return { status: 200, body: { dashboardRevision: 9, widgets: [] } };
    if (call.url === "/api/training-load/dashboards") return { status: 200, body: { dashboards: [dashboard()] } };
    return { status: 404, body: { error: "unexpected" } };
  });

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-create-widget", widgetType: "line_chart" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-widget-title", widgetId }, "Readiness"), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-add-series", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-delete-series", widgetId, seriesId }), { renderTrainingLoad });
  state.trainingLoad.analysis.selectedSeriesId = seriesId;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-series-up", widgetId, seriesId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-delete-widget", widgetId: secondWidgetId }), { renderTrainingLoad });
  assert.equal(fetchCalls.filter((call) => call.url.endsWith("/query")).length, 3);
  assert.equal(fetchCalls.some((call) => call.url.includes("/widgets/") && call.url.endsWith("/query")), false);
});

test("Analysis metric picker filters catalog metadata and supports built-in binding", async () => {
  resetState();
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.widgets = [widget()];
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/metrics/definitions")) return { status: 200, body: { rows: [{ id: metricId, key: "jump_height", label: "Jump height", short_label: "JH", unit: "cm", value_type: "number", scope_capabilities: ["session"] }], nextCursor: null } };
    if (call.url === "/api/training-load/metrics/domains") return { status: 200, body: { rows: [{ id: "domain-1", name: "Testing" }] } };
    if (call.url === "/api/training-load/metrics/categories") return { status: 200, body: { rows: [{ id: "category-1", name: "Jumping" }] } };
    if (call.url === "/api/training-load/metrics/structure-links") return { status: 200, body: { rows: [{ metric_definition_id: metricId, domain_id: "domain-1", category_id: "category-1" }] } };
    if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series`) return { status: 201, body: detail({ dashboard: { revision: 4 } }) };
    if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series/${seriesId}` && call.method === "DELETE") return { status: 200, body: detail({ dashboard: { revision: 5 } }) };
    if (call.url === `/api/training-load/dashboards/${dashboardId}` && call.method === "GET") return { status: 200, body: detail({ dashboard: { revision: 5 } }) };
    if (call.url === `/api/training-load/dashboards/${dashboardId}/query`) return { status: 200, body: { dashboardRevision: 5, widgets: [] } };
    if (call.url === "/api/training-load/dashboards") return { status: 200, body: { dashboards: [dashboard()] } };
    return { status: 404, body: { error: "unexpected" } };
  });

  await loadAnalysisMetricDefinitions();
  assert.equal(state.trainingLoad.analysis.metricPicker.definitions[0].domainLabel, "Testing");
  assert.equal(state.trainingLoad.analysis.metricPicker.definitions[0].categoryLabel, "Jumping");
  state.trainingLoad.analysis.editor = { open: true, widgetId, seriesId };
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-metric-search" }, "jump"), { renderTrainingLoad });
  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /Jump height/);
  assert.match(html, /Testing/);
  assert.match(html, /Jumping/);
  assert.doesNotMatch(html, /Sprint speed/);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-series-bind-builtin", widgetId, seriesId, builtInKey: "srpe" }), { renderTrainingLoad });
  assert.equal(fetchCalls.some((call) => call.url.endsWith("/series") && call.body?.builtInSeriesKey === "srpe"), true);
});

test("Analysis reloads stale revisions and renders explicit status states", async () => {
  resetState();
  state.trainingLoad.analysis.dashboard = dashboard({ revision: 9 });
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.widgets = [widget()];
  installFetchMock(async (call) => {
    if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}`) {
      return { status: 409, body: { error: "staleRevision" } };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}`) {
      return { status: 200, body: detail({ dashboard: { revision: 10 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}/query`) {
      return { status: 200, body: { dashboardRevision: 10, widgets: [] } };
    }
    return { status: 404, body: { error: "unexpected" } };
  });

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-widget-title", widgetId }, "New title"), { renderTrainingLoad });

  assert.equal(state.trainingLoad.analysis.notice, "Dashboard changed on the server. Reloaded the latest version.");
  assert.equal(state.trainingLoad.analysis.dashboard.revision, 10);

  state.trainingLoad.analysis.widgets = [
    widget({
      series: [{ ...widget().series[0], resolution_status: "unresolved" }],
    }),
    widget({
      id: secondWidgetId,
      widget_type: "table",
      title: "Conflicts",
      mobile_order: 2,
      series: [{ ...widget().series[0], id: "99999999-9999-4999-8999-999999999999", resolution_status: "resolved" }],
    }),
    widget({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Failed series",
      mobile_order: 3,
      series: [{ ...widget().series[0], id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", resolution_status: "resolved" }],
    }),
  ];
  state.trainingLoad.analysis.queryResult = {
    dashboardRevision: 10,
    widgets: [{
      widgetId: secondWidgetId,
      series: [{
        seriesId: "99999999-9999-4999-8999-999999999999",
        status: "ok",
        data: { current: [{ bucketKey: "day-1", value: 10, unit: "AU", conflict: true, unitConflict: true }], comparison: [] },
      }],
    }, {
      widgetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      series: [{ seriesId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "error", error: "seriesQueryFailed" }],
    }],
  };

  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /Choose a metric/);
  assert.match(html, /Conflict/);
  assert.match(html, /Unit conflict/);
  assert.match(html, /seriesQueryFailed|Choose a metric/);
});

// ------------------------------------------------------------
// 3B3 UX slice: sticky toolbar, Use template, date-field click-to-open,
// Choose activity (replacing raw ID inputs), Add widget placement.
// ------------------------------------------------------------

test("the Analysis toolbar is sticky so it stays visible while the dashboard grid scrolls", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.tl-analysis-topbar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*\}/, "position:sticky and top:0 must both be declared INSIDE .tl-analysis-topbar's own rule");
});

test("clicking the From/To date field opens the native picker (app.js showPicker hook) and returns immediately - it must NOT fall through into the query-refresh handling, or the click that merely opens the picker fires a needless /query POST (and the render it triggers replaces the very input mid-open, closing the picker)", () => {
  const appJsSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(
    appJsSource,
    /type === "training-load-analysis-period-from" \|\| type === "training-load-analysis-period-to"\)\s*\{\s*\n\s*action\.showPicker\?\.\(\);\s*\n\s*return;/,
    "handleContentClick must call showPicker() then return - the field's own 'change' event (handleContentChange) is the sole trigger for the actual period query refresh",
  );
});

test("no raw Activity ID / Component ID text inputs remain in the Analysis toolbar", () => {
  resetState();
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.widgets = [];
  const html = renderTrainingLoadAnalysisHtml();
  assert.doesNotMatch(html, /training-load-analysis-runtime-activity/);
  assert.doesNotMatch(html, /training-load-analysis-runtime-component"/);
  assert.doesNotMatch(html, /Analysis activity filter/);
  assert.match(html, /data-action="training-load-analysis-choose-activity"/);
  assert.match(html, />Choose activity</);
});

test("no raw Activity ID / Component ID text inputs in the widget settings editor either - only a Clear override control once one is set", () => {
  resetState();
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.widgets = [widget()];
  state.trainingLoad.analysis.editor = { open: true, widgetId, seriesId };

  let html = renderTrainingLoadAnalysisHtml();
  assert.doesNotMatch(html, /<input[^>]*data-action="training-load-analysis-widget-activity-filter"/, "no free-text activity id entry in the widget editor");
  assert.doesNotMatch(html, /<input[^>]*data-action="training-load-analysis-widget-component-filter"/, "no free-text component id entry in the widget editor");
  assert.match(html, /Uses dashboard\/runtime filter/, "no override set yet - shown as plain text, not an empty text field");

  state.trainingLoad.analysis.widgets = [widget({ local_filter_override: { activityId } })];
  html = renderTrainingLoadAnalysisHtml();
  assert.doesNotMatch(html, new RegExp(activityId), "the override's raw id must never be printed as visible text either");
  assert.match(html, /data-action="training-load-analysis-widget-activity-filter"[^>]*>Clear activity override</, "an active override only offers a Clear control, never a text field to edit it");
});

test("once an activity is chosen, the toolbar shows its real name and date - never the UUID - and a Component select of its own components", () => {
  resetState();
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.widgets = [];
  state.trainingLoad.analysis.runtimeFilter.activityId = activityId;
  state.trainingLoad.analysis.selectedActivity = { id: activityId, name: "Evening Recovery", date: "2026-09-09" };
  state.trainingLoad.analysis.componentOptions = [{ id: componentId, name: "Warm-up" }];

  const html = renderTrainingLoadAnalysisHtml();
  assert.doesNotMatch(html, new RegExp(activityId), "the activity's raw id must never be printed as visible text");
  assert.match(html, /Evening Recovery/);
  assert.match(html, /09\.09\.2026/, "date shown in the day.month.year format formatDate() already uses everywhere else");
  assert.match(html, /data-action="training-load-analysis-runtime-component-select"/);
  assert.match(html, /Warm-up/);
  assert.match(html, /data-action="training-load-analysis-clear-activity"/);
});

test("Choose activity switches Training Load to the Calendar tab in picking mode", async () => {
  resetState();
  state.trainingLoad.section = "analysis";
  installFetchMock(async (call) => ({ status: 200, body: { rows: [], days: [] } }));
  const handled = await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-choose-activity" }), { renderTrainingLoad });
  assert.equal(handled, true);
  assert.equal(state.trainingLoad.section, "today");
  assert.equal(state.trainingLoad.analysis.pickingActivity, true);
});

test("Clear activity clears both the activity AND the component filter, then re-queries", async () => {
  resetState();
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.runtimeFilter.activityId = activityId;
  state.trainingLoad.analysis.runtimeFilter.componentId = componentId;
  state.trainingLoad.analysis.selectedActivity = { id: activityId, name: "Evening Recovery", date: "2026-09-09" };
  state.trainingLoad.analysis.componentOptions = [{ id: componentId, name: "Warm-up" }];
  installFetchMock(async (call) => {
    if (call.url === `/api/training-load/dashboards/${dashboardId}/query`) {
      assert.equal(call.body.activityId, null);
      assert.equal(call.body.componentId, null);
      return { status: 200, body: { dashboardRevision: 3, widgets: [] } };
    }
    return { status: 404, body: { error: "unexpected" } };
  });

  const handled = await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-clear-activity" }), { renderTrainingLoad });
  assert.equal(handled, true);
  assert.equal(state.trainingLoad.analysis.runtimeFilter.activityId, "");
  assert.equal(state.trainingLoad.analysis.runtimeFilter.componentId, "");
  assert.equal(state.trainingLoad.analysis.selectedActivity, null);
  assert.deepEqual(state.trainingLoad.analysis.componentOptions, []);
  assert.ok(fetchCalls.some((c) => c.url.endsWith("/query")));
});

test("picking a component from the select re-queries with that component id", async () => {
  resetState();
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.runtimeFilter.activityId = activityId;
  installFetchMock(async (call) => {
    if (call.url === `/api/training-load/dashboards/${dashboardId}/query`) {
      assert.equal(call.body.componentId, componentId);
      return { status: 200, body: { dashboardRevision: 3, widgets: [] } };
    }
    return { status: 404, body: { error: "unexpected" } };
  });

  const handled = await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-runtime-component-select" }, componentId), { renderTrainingLoad });
  assert.equal(handled, true);
  assert.equal(state.trainingLoad.analysis.runtimeFilter.componentId, componentId);
});

test("Use template replaces Clone template and only shows while viewing a template dashboard", () => {
  resetState();
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.widgets = [];
  let html = renderTrainingLoadAnalysisHtml();
  assert.doesNotMatch(html, />Use template</, "a non-template dashboard must never show the Use-template action");
  assert.doesNotMatch(html, /Clone template/, "the old label must be fully gone");

  state.trainingLoad.analysis.dashboard = dashboard({ id: templateId, is_template: true });
  html = renderTrainingLoadAnalysisHtml();
  assert.match(html, />Use template</);
  assert.match(html, new RegExp(`data-action="training-load-analysis-clone-template" data-template-id="${templateId}"`));
});

test("+ Add widget lives in the dashboard header and shows whenever the dashboard can be edited, even outside Edit mode", () => {
  resetState();
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.widgets = [];
  state.trainingLoad.analysis.editMode = false;
  let html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /class="tl-analysis-dashboard-head">[\s\S]*data-action="training-load-analysis-add-widget"[\s\S]*<\/section>/);
  assert.match(html, /tl-analysis-primary tl-analysis-add-widget-button/);

  state.trainingLoad.analysis.editMode = true;
  html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /data-action="training-load-analysis-add-widget"/);
  assert.match(html, /Save layout/);

  state.trainingLoad.analysis.dashboard = dashboard({ status: "archived" });
  html = renderTrainingLoadAnalysisHtml();
  assert.doesNotMatch(html, /data-action="training-load-analysis-add-widget"/, "an archived (read-only) dashboard must never offer Add widget");

  state.trainingLoad.analysis.dashboard = dashboard({ id: templateId, is_template: true });
  html = renderTrainingLoadAnalysisHtml();
  assert.doesNotMatch(html, /data-action="training-load-analysis-add-widget"/, "a template dashboard must never offer Add widget - clone it first");
});

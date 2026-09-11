import { test } from "node:test";
import assert from "node:assert/strict";

let queried = {};
globalThis.document = {
  querySelector: (sel) => queried[sel] || null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = {
  confirm: () => true,
  prompt: (_message, fallback) => fallback,
  matchMedia: () => ({ matches: false }),
};

let fetchCalls;
function installFetchMock(responder) {
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    fetchCalls.push(call);
    const result = await responder(call);
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
}

const { handleTrainingLoadAction, handleTrainingLoadAnalysisPointerDown, handleTrainingLoadAnalysisPointerEnd, handleTrainingLoadAnalysisPointerMove } = await import("../training-load-actions.js");
const { loadTrainingLoadAnalysis, loadAnalysisMetricDefinitions } = await import("../training-load-analysis-data.js");
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
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "private_coach", scopeId: "coach-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  state.athletes = [];
  queried = {};
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

function pointerEvent(widgetId, mode, pointerId, clientX, clientY) {
  const handle = {
    matches: (selector) => mode === "resize" && selector.includes("resize"),
    closest: (selector) => selector.includes("data-analysis-widget-id") ? { dataset: { widgetId } } : null,
  };
  return {
    pointerId, clientX, clientY,
    target: { closest: () => handle },
    preventDefault() {},
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

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-runtime-activity" }, activityId), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-runtime-component" }, componentId), { renderTrainingLoad });
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
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-runtime-activity" }, activityId), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-runtime-component" }, componentId), { renderTrainingLoad });

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
  installFetchMock(async (call) => {
    if (call.url === `/api/training-load/dashboards/${dashboardId}/layout`) {
      assert.equal(call.method, "PUT");
      assert.deepEqual(call.body, {
        expectedRevision: 3,
        layout: [{ widgetId, x: 1, y: 1, width: 4, height: 4, mobileOrder: 1 }],
      });
      return { status: 200, body: detail({ dashboard: { revision: 4 } }) };
    }
    if (call.url === `/api/training-load/dashboards/${dashboardId}`) return { status: 200, body: detail({ dashboard: { revision: 4 } }) };
    if (call.url === `/api/training-load/dashboards/${dashboardId}/query`) return { status: 200, body: { dashboardRevision: 4, widgets: [] } };
    if (call.url === "/api/training-load/dashboards") return { status: 200, body: { dashboards: [dashboard()] } };
    return { status: 404, body: { error: "unexpected" } };
  });

  assert.equal(handleTrainingLoadAnalysisPointerDown(pointerEvent(widgetId, "drag", 1, 0, 0), renderTrainingLoad), true);
  handleTrainingLoadAnalysisPointerMove(pointerEvent(widgetId, "drag", 1, 100, 56));
  assert.deepEqual(state.trainingLoad.analysis.layoutDraft[0], { widgetId, x: 1, y: 1, width: 3, height: 3, mobileOrder: 1 });
  handleTrainingLoadAnalysisPointerEnd({ pointerId: 1 });
  assert.equal(fetchCalls.length, 0);

  assert.equal(handleTrainingLoadAnalysisPointerDown(pointerEvent(widgetId, "resize", 2, 0, 0), renderTrainingLoad), true);
  handleTrainingLoadAnalysisPointerMove(pointerEvent(widgetId, "resize", 2, 100, 56));
  assert.deepEqual(state.trainingLoad.analysis.layoutDraft[0], { widgetId, x: 1, y: 1, width: 4, height: 4, mobileOrder: 1 });
  handleTrainingLoadAnalysisPointerEnd({ pointerId: 2 });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-save-layout" }), { renderTrainingLoad });
  assert.equal(fetchCalls.filter((call) => call.url.endsWith("/layout")).length, 1);

  state.trainingLoad.analysis.layoutDraft = [{ widgetId, x: 9, y: 9, width: 1, height: 1, mobileOrder: 1 }];
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-cancel-layout" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.layoutDraft, null);
  assert.equal(fetchCalls.filter((call) => call.url.endsWith("/layout")).length, 1);
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

import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { state } from "./state.js";
import { localDateIsoInTimeZone } from "./utils.js";
import { buildContextKey, invalidateCacheEntry, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

const DASHBOARD_LIST_NAMESPACE = "training-load-analysis-dashboards";
const DASHBOARD_DETAIL_NAMESPACE = "training-load-analysis-dashboard";
const DASHBOARD_QUERY_NAMESPACE = "training-load-analysis-query";
const METRIC_DEFINITIONS_NAMESPACE = "training-load-analysis-metrics";

const ANALYSIS_LAYOUT_LIMITS = {
  kpi: { minWidth: 2, maxWidth: 4, minHeight: 2, maxHeight: 3 },
  table: { minWidth: 3, maxWidth: 12, minHeight: 3, maxHeight: 12 },
  line_chart: { minWidth: 3, maxWidth: 12, minHeight: 3, maxHeight: 8 },
  bar_chart: { minWidth: 3, maxWidth: 12, minHeight: 3, maxHeight: 8 },
};

let dashboardsGeneration = 0;
let detailGeneration = 0;
let queryGeneration = 0;
let metricDefinitionsWorkspaceKey = "";

export const BUILT_IN_SERIES = [
  { key: "rpe", label: "RPE", unit: "RPE", icon: "R" },
  { key: "srpe", label: "sRPE", unit: "AU", icon: "S" },
  { key: "duration_minutes", label: "Duration", unit: "min", icon: "D" },
  { key: "session_count", label: "Session count", unit: "count", icon: "#" },
  { key: "last_session_date", label: "Last session date", unit: "", icon: "L" },
];

function todayIso() {
  return localDateIsoInTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
}

// Dashboards UX H1: period presets. Each is "the last N days ending today"
// (inclusive, so 28 days = today minus 27); the default period below is
// exactly the 28-day preset. All well under the route's 400-day cap.
export const ANALYSIS_PERIOD_PRESETS = [
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "28d", label: "Last 28 days", days: 28 },
  { key: "12w", label: "Last 12 weeks", days: 84 },
  { key: "6m", label: "Last 6 months", days: 182 },
];

function presetRange(days) {
  const today = todayIso();
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { dateFrom: start.toISOString().slice(0, 10), dateTo: today };
}

// "custom" whenever From/To don't match a preset exactly - the preset menu
// label is derived from the real dates, never stored separately.
export function analysisPeriodPresetKey(period = state.trainingLoad.analysis.period) {
  const match = ANALYSIS_PERIOD_PRESETS.find((p) => {
    const range = presetRange(p.days);
    return range.dateFrom === period.dateFrom && range.dateTo === period.dateTo;
  });
  return match?.key || "custom";
}

export function applyAnalysisPeriodPreset(key) {
  const preset = ANALYSIS_PERIOD_PRESETS.find((p) => p.key === key);
  if (!preset) return false;
  state.trainingLoad.analysis.period = presetRange(preset.days);
  return true;
}

export function ensureAnalysisPeriod() {
  const analysis = state.trainingLoad.analysis;
  if (analysis.period.dateFrom && analysis.period.dateTo) return;
  analysis.period = presetRange(28);
}

function listContextKey() {
  return buildContextKey(currentUserWorkspaceContextParts());
}

function detailContextKey(dashboardId) {
  const dashboard = state.trainingLoad.analysis.dashboard;
  return buildContextKey([...currentUserWorkspaceContextParts(), dashboardId, dashboard?.revision || ""]);
}

export function analysisRuntimeFilterPayload(filter = state.trainingLoad.analysis.runtimeFilter) {
  const payload = {};
  if (Array.isArray(filter.athleteIds) && filter.athleteIds.length) payload.athleteIds = filter.athleteIds;
  if (Object.prototype.hasOwnProperty.call(filter, "activityId")) payload.activityId = filter.activityId || null;
  if (Object.prototype.hasOwnProperty.call(filter, "componentId")) payload.componentId = filter.componentId || null;
  return payload;
}

function queryContextKey() {
  const a = state.trainingLoad.analysis;
  const widgetRevisions = (a.widgets || []).map((w) => `${w.id}:${w.revision}`).join(",");
  return buildContextKey([
    ...currentUserWorkspaceContextParts(),
    a.selectedDashboardId,
    a.dashboard?.revision || "",
    widgetRevisions,
    a.period.dateFrom,
    a.period.dateTo,
    JSON.stringify(analysisRuntimeFilterPayload()),
  ]);
}

export function invalidateTrainingLoadAnalysis() {
  dashboardsGeneration += 1;
  detailGeneration += 1;
  queryGeneration += 1;
  invalidateCacheNamespace(DASHBOARD_LIST_NAMESPACE);
  invalidateCacheNamespace(DASHBOARD_DETAIL_NAMESPACE);
  invalidateCacheNamespace(DASHBOARD_QUERY_NAMESPACE);
}

function applyDashboardDetail(detail) {
  const analysis = state.trainingLoad.analysis;
  analysis.dashboard = detail.dashboard;
  analysis.widgets = detail.widgets || [];
  analysis.selectedDashboardId = detail.dashboard?.id || "";
  analysis.layoutDraft = null;
  analysis.notice = "";
  analysis.detailLoading = false;
}

export async function loadTrainingLoadAnalysis(onPainted) {
  ensureAnalysisPeriod();
  const analysis = state.trainingLoad.analysis;
  await Promise.all([
    loadDashboards(onPainted),
    loadActiveDashboard(onPainted),
  ]);
  if (!analysis.selectedDashboardId && analysis.activeDashboardId) {
    analysis.selectedDashboardId = analysis.activeDashboardId;
  }
  if (analysis.selectedDashboardId) {
    await loadDashboardDetail(analysis.selectedDashboardId, onPainted);
    await queryAnalysisDashboard(onPainted);
  }
}

export async function loadDashboards(onPainted) {
  const analysis = state.trainingLoad.analysis;
  const generation = ++dashboardsGeneration;
  const contextKey = listContextKey();
  await loadCachedView({
    namespace: DASHBOARD_LIST_NAMESPACE,
    contextKey,
    // Dashboards UX H1: the picker groups archived dashboards under their
    // own heading (read-only once opened, exactly as before), so the list
    // now asks for them too - an existing query flag, not an API change.
    fetcher: () => api("/api/training-load/dashboards?includeTemplates=true&includeArchived=true"),
    showLoading: () => { analysis.listLoading = true; analysis.listError = ""; onPainted?.(); },
    applyData: (data) => {
      if (generation !== dashboardsGeneration) return;
      analysis.dashboards = data.dashboards || [];
      analysis.listLoading = false;
      onPainted?.();
    },
    applyError: (error) => {
      if (generation !== dashboardsGeneration) return;
      analysis.listLoading = false;
      analysis.listError = error.message || "Could not load dashboards.";
      onPainted?.();
    },
    getCurrentContextKey: listContextKey,
  });
}

export async function loadActiveDashboard(onPainted) {
  const analysis = state.trainingLoad.analysis;
  try {
    const data = await api("/api/training-load/dashboards/active");
    analysis.activeDashboardId = data.activeDashboard?.dashboard_id || data.activeDashboard?.dashboardId || "";
  } catch (error) {
    analysis.notice = error.status === 404 ? "" : (error.message || "Could not load active dashboard.");
  }
  onPainted?.();
}

export async function loadDashboardDetail(dashboardId, onPainted, { force = false } = {}) {
  const analysis = state.trainingLoad.analysis;
  const generation = ++detailGeneration;
  const contextKey = detailContextKey(dashboardId);
  await loadCachedView({
    namespace: DASHBOARD_DETAIL_NAMESPACE,
    contextKey,
    forceRefresh: force,
    fetcher: () => api(`/api/training-load/dashboards/${encodeURIComponent(dashboardId)}`),
    showLoading: () => { analysis.detailLoading = true; analysis.detailError = ""; onPainted?.(); },
    applyData: (data) => {
      if (generation !== detailGeneration || state.trainingLoad.analysis.selectedDashboardId !== dashboardId) return;
      applyDashboardDetail(data);
      onPainted?.();
    },
    applyError: (error) => {
      if (generation !== detailGeneration || state.trainingLoad.analysis.selectedDashboardId !== dashboardId) return;
      analysis.detailLoading = false;
      analysis.detailError = error.status === 404 ? "Dashboard not found in this workspace." : (error.message || "Could not load dashboard.");
      onPainted?.();
    },
    getCurrentContextKey: () => (state.trainingLoad.analysis.selectedDashboardId === dashboardId ? detailContextKey(dashboardId) : "__superseded__"),
  });
}

export async function queryAnalysisDashboard(onPainted, { force = false } = {}) {
  const a = state.trainingLoad.analysis;
  if (!a.selectedDashboardId || !a.dashboard || a.dashboard.status === "archived" || a.dashboard.is_template) return;
  ensureAnalysisPeriod();
  const generation = ++queryGeneration;
  const contextKey = queryContextKey();
  await loadCachedView({
    namespace: DASHBOARD_QUERY_NAMESPACE,
    contextKey,
    forceRefresh: force,
    fetcher: () => api(`/api/training-load/dashboards/${encodeURIComponent(a.selectedDashboardId)}/query`, {
      method: "POST",
      body: JSON.stringify({ dateFrom: a.period.dateFrom, dateTo: a.period.dateTo, ...analysisRuntimeFilterPayload() }),
    }),
    showLoading: () => { a.queryLoading = true; a.queryError = ""; onPainted?.(); },
    applyData: (data) => {
      if (generation !== queryGeneration || queryContextKey() !== contextKey) return;
      a.queryResult = data;
      a.queryLoading = false;
      onPainted?.();
    },
    applyError: (error) => {
      if (generation !== queryGeneration || queryContextKey() !== contextKey) return;
      a.queryLoading = false;
      a.queryError = error.status === 409 && error.message === "dashboardArchived" ? "This dashboard is archived." : (error.message || "Could not run dashboard query.");
      onPainted?.();
    },
    getCurrentContextKey: queryContextKey,
  });
}

async function mutateDashboard(fn, onPainted, { reloadDetail = true } = {}) {
  const analysis = state.trainingLoad.analysis;
  try {
    analysis.saving = true; analysis.mutationError = ""; onPainted?.();
    const result = await fn();
    invalidateTrainingLoadAnalysis();
    await loadDashboards(onPainted);
    if (result?.dashboard?.id) analysis.selectedDashboardId = result.dashboard.id;
    if (reloadDetail && analysis.selectedDashboardId) {
      await loadDashboardDetail(analysis.selectedDashboardId, onPainted, { force: true });
      await queryAnalysisDashboard(onPainted, { force: true });
    }
    analysis.saving = false;
    return result;
  } catch (error) {
    analysis.saving = false;
    if (error.status === 409 && error.message === "staleRevision") {
      if (analysis.selectedDashboardId) await loadDashboardDetail(analysis.selectedDashboardId, onPainted, { force: true });
      analysis.notice = "Dashboard changed on the server. Reloaded the latest version.";
      onPainted?.();
    } else {
      analysis.mutationError = error.message || "Could not save this dashboard.";
    }
    onPainted?.();
    return null;
  }
}

export async function createAnalysisDashboard({ name, description = "" }, onPainted) {
  return mutateDashboard(() => api("/api/training-load/dashboards", {
    method: "POST",
    body: JSON.stringify({ name, description: description || null, ownerScope: "user", isTemplate: false }),
  }), onPainted);
}

export async function cloneAnalysisDashboard(templateId, onPainted) {
  return mutateDashboard(() => api(`/api/training-load/dashboards/${encodeURIComponent(templateId)}/clone`, {
    method: "POST",
    body: JSON.stringify({ ownerScope: "user", isTemplate: false }),
  }), onPainted);
}

export async function setActiveAnalysisDashboard(dashboardId, onPainted) {
  const analysis = state.trainingLoad.analysis;
  try {
    await api("/api/training-load/dashboards/active", { method: "POST", body: JSON.stringify({ dashboardId }) });
    analysis.activeDashboardId = dashboardId;
    analysis.notice = "Active dashboard updated.";
    onPainted?.();
  } catch (error) {
    analysis.mutationError = error.status === 404 ? "Dashboard not found in this workspace." : (error.message || "Could not set active dashboard.");
    onPainted?.();
  }
}

export async function archiveAnalysisDashboard(onPainted) {
  const a = state.trainingLoad.analysis;
  if (!a.dashboard) return null;
  return mutateDashboard(() => api(`/api/training-load/dashboards/${encodeURIComponent(a.dashboard.id)}/archive`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: a.dashboard.revision }),
  }), onPainted);
}

export async function updateAnalysisDashboardMetadata(body, onPainted) {
  const a = state.trainingLoad.analysis;
  if (!a.dashboard) return null;
  return mutateDashboard(() => api(`/api/training-load/dashboards/${encodeURIComponent(a.dashboard.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: a.dashboard.revision, ...body }),
  }), onPainted);
}

export async function saveAnalysisLayout(onPainted) {
  const a = state.trainingLoad.analysis;
  if (!a.dashboard || !a.layoutDraft) return null;
  return mutateDashboard(() => api(`/api/training-load/dashboards/${encodeURIComponent(a.dashboard.id)}/layout`, {
    method: "PUT",
    body: JSON.stringify({ expectedRevision: a.dashboard.revision, layout: a.layoutDraft }),
  }), onPainted);
}

// ------------------------------------------------------------
// Dashboards UX H1: the guided "Add metric" panel.
//
// Everything the coach picks in the panel (metric, view, title, per/
// aggregation/scope) is STAGED here and nothing reaches the server until
// Save. POST /:id/query only ever evaluates SAVED widgets (optionally
// narrowed by widgetIds - see routes/trainingLoadDashboard.js), so a live
// data preview of an unsaved widget would need a new API and is
// deliberately NOT offered: the panel shows a static configuration preview
// and the real values appear on the dashboard right after Save, when the
// ordinary detail reload + batch query runs. Cancel just drops this object -
// no draft widget is ever created (creating-then-deleting on Cancel would
// churn dashboard revisions for nothing).
// ------------------------------------------------------------

// Sensible starting aggregation/scope per built-in series; catalog metrics
// start as a session average. Only defaults - all editable in the panel.
const BUILT_IN_DEFAULTS = {
  rpe: { aggregation: "avg", scope: "session" },
  srpe: { aggregation: "sum", scope: "session" },
  duration_minutes: { aggregation: "sum", scope: "session" },
  session_count: { aggregation: "sum", scope: "session" },
  last_session_date: { aggregation: "last", scope: "session" },
};

export function metricPanelMetricForSeries(series) {
  if (!series) return null;
  if (series.built_in_series_key) {
    const builtIn = BUILT_IN_SERIES.find((b) => b.key === series.built_in_series_key);
    return { kind: "builtin", key: series.built_in_series_key, label: builtIn?.label || series.built_in_series_key, unit: builtIn?.unit || "" };
  }
  if (series.metric_definition_id) {
    const def = (state.trainingLoad.analysis.metricPicker.definitions || []).find((d) => d.id === series.metric_definition_id);
    return { kind: "metric", id: series.metric_definition_id, label: def?.label || series.display_label || "Metric", unit: def?.unit || "" };
  }
  return null;
}

export function emptyAnalysisMetricPanel(widget = null) {
  const series = widget ? [...(widget.series || [])].sort((l, r) => Number(l.series_order || 0) - Number(r.series_order || 0))[0] || null : null;
  const metric = metricPanelMetricForSeries(series);
  return {
    widgetId: widget?.id || "",
    seriesId: series?.id || "",
    seriesOrder: Number(series?.series_order || 1),
    metric,
    originalMetric: metric,
    widgetType: widget?.widget_type || "kpi",
    title: widget?.title || "",
    // The title follows the chosen metric until the coach types their own.
    titleTouched: Boolean(widget),
    groupBy: widget?.group_by || "day",
    aggregation: series?.analytical_aggregation || "avg",
    scope: series?.data_scope_level || "session",
    search: "",
    saving: false,
    error: "",
    createdInFlight: false,
  };
}

export function setMetricPanelMetric(panel, metric) {
  panel.metric = metric;
  if (metric?.kind === "builtin" && BUILT_IN_DEFAULTS[metric.key]) {
    panel.aggregation = BUILT_IN_DEFAULTS[metric.key].aggregation;
    panel.scope = BUILT_IN_DEFAULTS[metric.key].scope;
  }
  if (!panel.titleTouched) panel.title = metric?.label || "";
}

export function metricPanelCanSave(panel = state.trainingLoad.analysis.metricPanel) {
  return Boolean(panel && panel.metric && panel.title.trim() && !panel.saving);
}

function sameMetric(left, right) {
  if (!left || !right) return left === right;
  return left.kind === right.kind && (left.kind === "builtin" ? left.key === right.key : left.id === right.id);
}

function seriesBodyForMetric(metric) {
  return metric.kind === "builtin" ? { builtInSeriesKey: metric.key } : { metricDefinitionId: metric.id };
}

function newAnalysisWidgetBody(panel) {
  const a = state.trainingLoad.analysis;
  const widgets = a.widgets || [];
  const maxY = widgets.reduce((m, w) => Math.max(m, Number(w.y || 0) + Number(w.height || 4)), 0);
  const order = widgets.length ? Math.max(...widgets.map((w) => Number(w.widget_order ?? w.widgetOrder ?? 0))) + 1 : 1;
  return {
    expectedDashboardRevision: a.dashboard.revision,
    widgetType: panel.widgetType,
    title: panel.title.trim(),
    widgetOrder: order,
    x: 0,
    y: maxY,
    width: panel.widgetType === "kpi" ? 3 : 6,
    height: panel.widgetType === "kpi" ? 3 : 5,
    mobileOrder: order,
    groupBy: panel.groupBy,
    displayConfig: { schemaVersion: 1 },
  };
}

// Save = a chain of the EXISTING endpoints, in one go. New widget: POST
// widget -> POST series (a freshly inserted widget is at revision 1 -
// migrations_v2 v16's column default - so no extra detail fetch is needed
// in between). Existing widget: PATCH widget (title/type/per) -> series
// change, each step threading the widgetRevision the previous one returned.
// Any server write, successful or not, is followed by the ordinary list +
// detail + batch-query reload so the grid never shows a half-applied state.
export async function saveAnalysisMetricPanel(onPainted) {
  const a = state.trainingLoad.analysis;
  const panel = a.metricPanel;
  if (!panel || !a.dashboard || !metricPanelCanSave(panel)) return false;
  const base = `/api/training-load/dashboards/${encodeURIComponent(a.dashboard.id)}`;
  const post = (url, body) => api(url, { method: "POST", body: JSON.stringify(body) });
  const patch = (url, body) => api(url, { method: "PATCH", body: JSON.stringify(body) });
  const seriesSettings = { dataScopeLevel: panel.scope, analyticalAggregation: panel.aggregation };
  // The new-widget branch stages widgetId as soon as the POST lands (see
  // createdInFlight below), so "new vs edit" is decided up front.
  const wasNew = !panel.widgetId || Boolean(panel.createdInFlight);
  panel.saving = true;
  panel.error = "";
  onPainted?.();
  let wrote = false;
  let saved = false;
  try {
    if (!panel.widgetId) {
      const created = await post(`${base}/widgets`, newAnalysisWidgetBody(panel));
      wrote = true;
      // code-reviewer (MEDIUM): the widget now exists - stage its identity at
      // once, so if the series POST below fails (409/400/network) a retry of
      // Save takes the existing-widget branch and only adds the series,
      // never a second empty widget.
      panel.widgetId = created.widgetId;
      panel.seriesId = "";
      panel.seriesOrder = 1;
      panel.originalMetric = null;
      // Keeps the panel reading "Add metric" (and the success notice "added")
      // on a retry - the coach is still adding, not editing.
      panel.createdInFlight = true;
      await post(`${base}/widgets/${encodeURIComponent(created.widgetId)}/series`, {
        expectedWidgetRevision: 1, seriesOrder: 1, ...seriesBodyForMetric(panel.metric), ...seriesSettings,
      });
    } else {
      const widget = (a.widgets || []).find((w) => w.id === panel.widgetId);
      if (!widget) throw new Error("This widget no longer exists - reopen the dashboard and try again.");
      let revision = widget.revision;
      const widgetPatch = {};
      if (panel.title.trim() !== widget.title) widgetPatch.title = panel.title.trim();
      if (panel.widgetType !== widget.widget_type) widgetPatch.widgetType = panel.widgetType;
      if (panel.groupBy !== widget.group_by) widgetPatch.groupBy = panel.groupBy;
      if (Object.keys(widgetPatch).length) {
        const updated = await patch(`${base}/widgets/${encodeURIComponent(widget.id)}`, { expectedWidgetRevision: revision, ...widgetPatch });
        wrote = true;
        // PATCH returns the v17 update_widget_content row:
        // { widget: { widget_id, widget_revision, dashboard_id } } - the
        // series step below must carry THAT revision or it 409s.
        revision = updated.widget?.widget_revision ?? revision;
      }
      const seriesUrl = `${base}/widgets/${encodeURIComponent(widget.id)}/series`;
      const series = (widget.series || []).find((s) => s.id === panel.seriesId) || null;
      if (!sameMetric(panel.metric, panel.originalMetric) || !series) {
        // A different metric = a different series: replace it (same order
        // slot) rather than mutate a binding in place - the existing
        // bind-builtin/bind-metric actions do exactly the same.
        if (series) {
          const deleted = await api(`${seriesUrl}/${encodeURIComponent(series.id)}`, { method: "DELETE", body: JSON.stringify({ expectedWidgetRevision: revision }) });
          wrote = true;
          revision = deleted.widgetRevision ?? revision;
        }
        await post(seriesUrl, { expectedWidgetRevision: revision, seriesOrder: panel.seriesOrder || 1, ...seriesBodyForMetric(panel.metric), ...seriesSettings });
        wrote = true;
      } else if (series.analytical_aggregation !== panel.aggregation || series.data_scope_level !== panel.scope) {
        await patch(`${seriesUrl}/${encodeURIComponent(series.id)}`, { expectedWidgetRevision: revision, ...seriesSettings });
        wrote = true;
      }
    }
    saved = true;
  } catch (error) {
    panel.saving = false;
    panel.error = error.status === 409 && error.message === "staleRevision"
      ? "Dashboard changed on the server. Reloaded the latest version - check your settings and save again."
      : (error.message || "Could not save this metric.");
    if (error.status === 409) wrote = true; // reload so the panel edits against the current revision
  }
  if (wrote) {
    invalidateTrainingLoadAnalysis();
    await loadDashboards(onPainted);
    if (a.selectedDashboardId) {
      await loadDashboardDetail(a.selectedDashboardId, onPainted, { force: true });
      await queryAnalysisDashboard(onPainted, { force: true });
    }
  }
  if (saved) {
    a.metricPanel = null;
    a.notice = wasNew ? "Metric added to the dashboard." : "Metric updated.";
  }
  onPainted?.();
  return saved;
}

export async function updateAnalysisWidget(widgetId, body, onPainted) {
  const w = state.trainingLoad.analysis.widgets.find((item) => item.id === widgetId);
  if (!w) return null;
  return mutateDashboard(() => api(`/api/training-load/dashboards/${encodeURIComponent(state.trainingLoad.analysis.dashboard.id)}/widgets/${encodeURIComponent(widgetId)}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedWidgetRevision: w.revision, ...body }),
  }), onPainted);
}

export async function deleteAnalysisWidget(widgetId, onPainted) {
  const w = state.trainingLoad.analysis.widgets.find((item) => item.id === widgetId);
  if (!w) return null;
  return mutateDashboard(() => api(`/api/training-load/dashboards/${encodeURIComponent(state.trainingLoad.analysis.dashboard.id)}/widgets/${encodeURIComponent(widgetId)}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedWidgetRevision: w.revision }),
  }), onPainted);
}

export async function addAnalysisSeries(widgetId, seriesBody, onPainted) {
  const w = state.trainingLoad.analysis.widgets.find((item) => item.id === widgetId);
  if (!w) return null;
  return mutateDashboard(() => api(`/api/training-load/dashboards/${encodeURIComponent(state.trainingLoad.analysis.dashboard.id)}/widgets/${encodeURIComponent(widgetId)}/series`, {
    method: "POST",
    body: JSON.stringify({ expectedWidgetRevision: w.revision, seriesOrder: (w.series || []).length + 1, ...seriesBody }),
  }), onPainted);
}

export async function updateAnalysisSeries(widgetId, seriesId, body, onPainted) {
  const w = state.trainingLoad.analysis.widgets.find((item) => item.id === widgetId);
  if (!w) return null;
  return mutateDashboard(() => api(`/api/training-load/dashboards/${encodeURIComponent(state.trainingLoad.analysis.dashboard.id)}/widgets/${encodeURIComponent(widgetId)}/series/${encodeURIComponent(seriesId)}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedWidgetRevision: w.revision, ...body }),
  }), onPainted);
}

export async function deleteAnalysisSeries(widgetId, seriesId, onPainted) {
  const w = state.trainingLoad.analysis.widgets.find((item) => item.id === widgetId);
  if (!w) return null;
  return mutateDashboard(() => api(`/api/training-load/dashboards/${encodeURIComponent(state.trainingLoad.analysis.dashboard.id)}/widgets/${encodeURIComponent(widgetId)}/series/${encodeURIComponent(seriesId)}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedWidgetRevision: w.revision }),
  }), onPainted);
}

export async function reorderAnalysisSeries(widgetId, direction, onPainted) {
  const w = state.trainingLoad.analysis.widgets.find((item) => item.id === widgetId);
  if (!w) return null;
  const series = [...(w.series || [])].sort((a, b) => Number(a.series_order || 0) - Number(b.series_order || 0));
  const index = series.findIndex((s) => s.id === state.trainingLoad.analysis.selectedSeriesId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= series.length) return null;
  [series[index], series[next]] = [series[next], series[index]];
  const order = series.map((s, i) => ({ seriesId: s.id, seriesOrder: i + 1 }));
  return mutateDashboard(() => api(`/api/training-load/dashboards/${encodeURIComponent(state.trainingLoad.analysis.dashboard.id)}/widgets/${encodeURIComponent(widgetId)}/series/reorder`, {
    method: "PUT",
    body: JSON.stringify({ expectedWidgetRevision: w.revision, order }),
  }), onPainted);
}

export async function resolveAnalysisSeries(widgetId, seriesId, metricDefinitionId, onPainted) {
  const w = state.trainingLoad.analysis.widgets.find((item) => item.id === widgetId);
  if (!w) return null;
  return mutateDashboard(() => api(`/api/training-load/dashboards/${encodeURIComponent(state.trainingLoad.analysis.dashboard.id)}/widgets/${encodeURIComponent(widgetId)}/series/${encodeURIComponent(seriesId)}/resolve`, {
    method: "POST",
    body: JSON.stringify({ expectedWidgetRevision: w.revision, metricDefinitionId }),
  }), onPainted);
}

export function moveAnalysisWidgetMobile(widgetId, direction) {
  const widgets = [...ensureAnalysisLayoutDraft()].sort((a, b) => Number(a.mobileOrder || 0) - Number(b.mobileOrder || 0));
  const index = widgets.findIndex((w) => w.widgetId === widgetId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= widgets.length) return;
  [widgets[index], widgets[next]] = [widgets[next], widgets[index]];
  state.trainingLoad.analysis.layoutDraft = widgets.map((w, i) => ({ ...w, mobileOrder: i + 1 }));
}

export function resizeAnalysisWidget(widgetId, deltaWidth, deltaHeight) {
  updateAnalysisLayoutDraft(widgetId, (entry) => ({
    ...entry,
    width: Number(entry.width || 1) + deltaWidth,
    height: Number(entry.height || 1) + deltaHeight,
  }));
}

export function nudgeAnalysisWidget(widgetId, dx, dy) {
  updateAnalysisLayoutDraft(widgetId, (entry) => ({
    ...entry,
    x: Number(entry.x || 0) + dx,
    y: Math.max(0, Number(entry.y || 0) + dy),
  }));
}

export function ensureAnalysisLayoutDraft() {
  const a = state.trainingLoad.analysis;
  if (!a.layoutDraft) {
    a.layoutDraft = a.widgets.map((w) => clampAnalysisLayoutEntry({
      widgetId: w.id, x: w.x, y: w.y, width: w.width, height: w.height, mobileOrder: w.mobile_order,
    }, w.widget_type));
  }
  return a.layoutDraft;
}

export function updateAnalysisLayoutDraft(widgetId, update) {
  const a = state.trainingLoad.analysis;
  const widget = a.widgets.find((item) => item.id === widgetId);
  const nextDraft = ensureAnalysisLayoutDraft().map((entry) => entry.widgetId === widgetId
    ? clampAnalysisLayoutEntry(typeof update === "function" ? update(entry) : { ...entry, ...update }, widget?.widget_type)
    : entry);
  a.layoutDraft = resolveAnalysisLayoutCollision(nextDraft, widgetId);
}

export function clampAnalysisLayoutEntry(entry, widgetType) {
  const limits = ANALYSIS_LAYOUT_LIMITS[widgetType] || { minWidth: 1, maxWidth: 12, minHeight: 1, maxHeight: 24 };
  const width = Math.max(limits.minWidth, Math.min(limits.maxWidth, Number(entry.width || limits.minWidth)));
  return {
    ...entry,
    x: Math.max(0, Math.min(12 - width, Number(entry.x || 0))),
    y: Math.max(0, Number(entry.y || 0)),
    width,
    height: Math.max(limits.minHeight, Math.min(limits.maxHeight, Number(entry.height || limits.minHeight))),
  };
}

function analysisLayoutEntriesOverlap(left, right) {
  const leftX = Number(left.x || 0);
  const leftY = Number(left.y || 0);
  const rightX = Number(right.x || 0);
  const rightY = Number(right.y || 0);
  return leftX < rightX + Number(right.width || 1)
    && leftX + Number(left.width || 1) > rightX
    && leftY < rightY + Number(right.height || 1)
    && leftY + Number(left.height || 1) > rightY;
}

function resolveAnalysisLayoutCollision(entries, movedWidgetId) {
  const movedIndex = entries.findIndex((entry) => entry.widgetId === movedWidgetId);
  if (movedIndex < 0) return entries;
  const moved = { ...entries[movedIndex] };
  const others = entries.filter((entry) => entry.widgetId !== movedWidgetId);
  while (others.some((entry) => analysisLayoutEntriesOverlap(moved, entry))) {
    moved.y = Math.max(...others
      .filter((entry) => analysisLayoutEntriesOverlap({ ...moved, y: Number(moved.y || 0) }, entry))
      .map((entry) => Number(entry.y || 0) + Number(entry.height || 1)), Number(moved.y || 0) + 1);
  }
  return entries.map((entry) => entry.widgetId === movedWidgetId ? moved : entry);
}

export function cancelAnalysisLayoutDraft() {
  state.trainingLoad.analysis.layoutDraft = null;
}

export async function loadAnalysisMetricDefinitions() {
  const analysis = state.trainingLoad.analysis;
  const picker = analysis.metricPicker;
  const contextKey = buildContextKey(currentUserWorkspaceContextParts());
  if (picker.definitions && metricDefinitionsWorkspaceKey === contextKey) return picker.definitions;
  picker.loading = true;
  picker.error = "";
  try {
    const rows = [];
    let cursor = null;
    for (let page = 0; page < 200; page += 1) {
      const query = cursor ? `?limit=100&cursorLabel=${encodeURIComponent(cursor.label)}&cursorId=${encodeURIComponent(cursor.id)}` : "?limit=100";
      const data = await api(`/api/training-load/metrics/definitions${query}`);
      rows.push(...(data.rows || []));
      if (!data.nextCursor) break;
      cursor = data.nextCursor;
    }
    const [domains, categories, links] = await Promise.all([
      api("/api/training-load/metrics/domains").catch(() => ({ rows: [] })),
      api("/api/training-load/metrics/categories").catch(() => ({ rows: [] })),
      api("/api/training-load/metrics/structure-links").catch(() => ({ rows: [] })),
    ]);
    const domainNameById = new Map((domains.rows || []).map((d) => [d.id, d.name]));
    const categoryNameById = new Map((categories.rows || []).map((c) => [c.id, c.name]));
    const structureByDefId = new Map();
    for (const link of links.rows || []) {
      if (structureByDefId.has(link.metric_definition_id)) continue;
      structureByDefId.set(link.metric_definition_id, {
        domainLabel: link.domain_id ? domainNameById.get(link.domain_id) || null : null,
        categoryLabel: link.category_id ? categoryNameById.get(link.category_id) || null : null,
      });
    }
    picker.definitions = rows.map((d) => ({
      id: d.id,
      key: d.key,
      label: d.label,
      shortLabel: d.short_label,
      unit: d.unit,
      iconUrl: d.icon_url,
      valueType: d.value_type,
      scopeCapabilities: d.scope_capabilities || [],
      ...(structureByDefId.get(d.id) || {}),
    }));
    metricDefinitionsWorkspaceKey = contextKey;
    picker.loading = false;
    return picker.definitions;
  } catch (error) {
    picker.loading = false;
    picker.error = error.message || "Could not load metric definitions.";
    return [];
  }
}

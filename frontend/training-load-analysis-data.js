import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { state } from "./state.js";
import { localDateIsoInTimeZone } from "./utils.js";
import { buildContextKey, invalidateCacheEntry, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

const DASHBOARD_LIST_NAMESPACE = "training-load-analysis-dashboards";
const DASHBOARD_DETAIL_NAMESPACE = "training-load-analysis-dashboard";
const DASHBOARD_QUERY_NAMESPACE = "training-load-analysis-query";
const METRIC_DEFINITIONS_NAMESPACE = "training-load-analysis-metrics";

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

export function ensureAnalysisPeriod() {
  const analysis = state.trainingLoad.analysis;
  if (analysis.period.dateFrom && analysis.period.dateTo) return;
  const today = todayIso();
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 27);
  analysis.period.dateFrom = start.toISOString().slice(0, 10);
  analysis.period.dateTo = today;
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
    fetcher: () => api("/api/training-load/dashboards?includeTemplates=true"),
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

export async function createAnalysisWidget(widgetType, onPainted) {
  const a = state.trainingLoad.analysis;
  const widgets = a.widgets || [];
  const maxY = widgets.reduce((m, w) => Math.max(m, Number(w.y || 0) + Number(w.height || 4)), 0);
  const order = widgets.length ? Math.max(...widgets.map((w) => Number(w.widget_order ?? w.widgetOrder ?? 0))) + 1 : 1;
  return mutateDashboard(() => api(`/api/training-load/dashboards/${encodeURIComponent(a.dashboard.id)}/widgets`, {
    method: "POST",
    body: JSON.stringify({
      expectedDashboardRevision: a.dashboard.revision,
      widgetType,
      title: widgetType.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      widgetOrder: order,
      x: 0,
      y: maxY,
      width: widgetType === "kpi" ? 3 : 6,
      height: widgetType === "kpi" ? 3 : 5,
      mobileOrder: order,
      groupBy: "day",
      displayConfig: { schemaVersion: 1 },
    }),
  }), onPainted);
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
  const widgets = [...(state.trainingLoad.analysis.layoutDraft || state.trainingLoad.analysis.widgets.map((w) => ({
    widgetId: w.id, x: w.x, y: w.y, width: w.width, height: w.height, mobileOrder: w.mobile_order,
  })))].sort((a, b) => Number(a.mobileOrder || 0) - Number(b.mobileOrder || 0));
  const index = widgets.findIndex((w) => w.widgetId === widgetId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= widgets.length) return;
  [widgets[index], widgets[next]] = [widgets[next], widgets[index]];
  state.trainingLoad.analysis.layoutDraft = widgets.map((w, i) => ({ ...w, mobileOrder: i + 1 }));
}

export function resizeAnalysisWidget(widgetId, deltaWidth, deltaHeight) {
  const a = state.trainingLoad.analysis;
  const source = a.layoutDraft || a.widgets.map((w) => ({ widgetId: w.id, x: w.x, y: w.y, width: w.width, height: w.height, mobileOrder: w.mobile_order }));
  a.layoutDraft = source.map((entry) => entry.widgetId === widgetId
    ? { ...entry, width: Math.max(1, Math.min(12, Number(entry.width || 1) + deltaWidth)), height: Math.max(1, Number(entry.height || 1) + deltaHeight) }
    : entry);
}

export function nudgeAnalysisWidget(widgetId, dx, dy) {
  const a = state.trainingLoad.analysis;
  const source = a.layoutDraft || a.widgets.map((w) => ({ widgetId: w.id, x: w.x, y: w.y, width: w.width, height: w.height, mobileOrder: w.mobile_order }));
  a.layoutDraft = source.map((entry) => entry.widgetId === widgetId
    ? { ...entry, x: Math.max(0, Math.min(11, Number(entry.x || 0) + dx)), y: Math.max(0, Number(entry.y || 0) + dy) }
    : entry);
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
    const groupByDefId = new Map();
    for (const link of links.rows || []) {
      if (groupByDefId.has(link.metric_definition_id)) continue;
      const label = (link.domain_id && domainNameById.get(link.domain_id)) || (link.category_id && categoryNameById.get(link.category_id)) || null;
      if (label) groupByDefId.set(link.metric_definition_id, label);
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
      domainLabel: groupByDefId.get(d.id) || null,
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

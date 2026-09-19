import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { state } from "./state.js";
import { localDateIsoInTimeZone } from "./utils.js";
import { buildContextKey, invalidateCacheEntry, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

const DASHBOARD_LIST_NAMESPACE = "training-load-analysis-dashboards";
const DASHBOARD_DETAIL_NAMESPACE = "training-load-analysis-dashboard";
const DASHBOARD_QUERY_NAMESPACE = "training-load-analysis-query";
const METRIC_DEFINITIONS_NAMESPACE = "training-load-analysis-metrics";

// Mirrors training_load.dashboard_widget_types.max_series (migrations_v2
// v18 seed) - the DB trigger on add_series() rejects a series past this with
// a generic 400, so the guided panel must know up front whether a metric
// replace can add-first (below capacity) or has to delete-first (at
// capacity, e.g. a KPI with its single series). Same convention as
// ANALYSIS_LAYOUT_LIMITS above.
const ANALYSIS_SERIES_LIMITS = { kpi: 1, table: 12, line_chart: 8, bar_chart: 8 };

// Mirrors training_load.dashboard_builtin_series.fixed_data_scope_level
// (migrations_v2 v18 seed): a built-in series' data level is fixed by the
// catalog, and the v16 validate_builtin_scope trigger rejects any other
// value with a generic 400. Same convention as ANALYSIS_SERIES_LIMITS.
export const BUILT_IN_FIXED_SCOPE = { rpe: "session", srpe: "session", duration_minutes: "session", session_count: "day", last_session_date: "day" };

// Mirrors dashboard_widget_types.supports_comparison_period (v18 seed: KPI
// only) - the v16 type-change trigger refuses a comparison on any other type.
const ANALYSIS_COMPARISON_TYPES = new Set(["kpi"]);

// Mirrors dashboard_widget_types.has_shared_axis (v18 seed): on these types
// the v16 validate_axis_unit trigger refuses a series whose unit differs
// from another series on the same axis - so a metric replace there must
// remove the previous series BEFORE adding the new one (code-reviewer HIGH).
const ANALYSIS_SHARED_AXIS_TYPES = new Set(["line_chart", "bar_chart"]);

// Mirrors dashboard_builtin_series.unit / value_type (v18 seed). A text or
// boolean value only supports the "last" / "none" aggregation (v16
// validate_aggregation_type_compat).
const BUILT_IN_SERIES_UNITS = { rpe: null, srpe: "AU", duration_minutes: "min", session_count: null, last_session_date: null };
const BUILT_IN_VALUE_TYPES = { rpe: "numeric", srpe: "numeric", duration_minutes: "numeric", session_count: "numeric", last_session_date: "text" };
const NON_NUMERIC_AGGREGATIONS = new Set(["last", "none"]);
const ANALYSIS_WIDGET_TYPE_LABELS = { kpi: "KPI", table: "Table", line_chart: "Line chart", bar_chart: "Bar chart" };

export function analysisSeriesLimit(widgetType) {
  return ANALYSIS_SERIES_LIMITS[widgetType] ?? 20;
}

export function analysisWidgetSupportsComparison(widgetType) {
  return ANALYSIS_COMPARISON_TYPES.has(widgetType);
}

const ANALYSIS_LAYOUT_LIMITS = {
  kpi: { minWidth: 2, maxWidth: 4, minHeight: 2, maxHeight: 3 },
  table: { minWidth: 3, maxWidth: 12, minHeight: 3, maxHeight: 12 },
  line_chart: { minWidth: 3, maxWidth: 12, minHeight: 3, maxHeight: 8 },
  bar_chart: { minWidth: 3, maxWidth: 12, minHeight: 3, maxHeight: 8 },
};

// H2: the layout toolbar disables a nudge/resize button that would be a
// no-op at the current position (clampAnalysisLayoutEntry would undo it).
export function analysisLayoutLimits(widgetType) {
  return ANALYSIS_LAYOUT_LIMITS[widgetType] || { minWidth: 1, maxWidth: 12, minHeight: 1, maxHeight: 24 };
}

let dashboardsGeneration = 0;
let detailGeneration = 0;
let queryGeneration = 0;
let metricDefinitionsWorkspaceKey = "";
// One catalog load per workspace at a time. loadCachedView can call a
// dashboard's applyData twice (cached, then fresh), and several callers
// (the dashboard, the editors, the pickers) ask independently, so a load that
// is already running is shared instead of started again.
let metricDefinitionsInFlight = null;

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
  // H2: layout editing belongs to one dashboard - a detail for a DIFFERENT
  // dashboard (create, clone, fallback after a delete) never opens in
  // layout mode. A reload of the same dashboard (save, stale revision)
  // keeps the mode; its draft is dropped either way, as before.
  if (analysis.dashboard?.id !== detail.dashboard?.id) analysis.editMode = false;
  analysis.dashboard = detail.dashboard;
  analysis.widgets = detail.widgets || [];
  analysis.selectedDashboardId = detail.dashboard?.id || "";
  analysis.layoutDraft = null;
  analysis.notice = "";
  analysis.detailLoading = false;
}

export async function loadTrainingLoadAnalysis(onPainted) {
  ensureAnalysisPeriod();
  await Promise.all([
    loadDashboards(onPainted),
    loadActiveDashboard(onPainted),
  ]);
  await selectFallbackDashboard(onPainted);
}

// Which dashboard to show when none is explicitly selected: the account's
// own active dashboard for this workspace, else nothing (the empty state).
// Shared by the initial load and by a permanent delete - never "some other
// dashboard picked from the list".
async function selectFallbackDashboard(onPainted, { force = false } = {}) {
  const analysis = state.trainingLoad.analysis;
  if (!analysis.selectedDashboardId && analysis.activeDashboardId) {
    analysis.selectedDashboardId = analysis.activeDashboardId;
  }
  if (analysis.selectedDashboardId) {
    await loadDashboardDetail(analysis.selectedDashboardId, onPainted, { force });
    await queryAnalysisDashboard(onPainted, { force });
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
      // Series bound to a catalog metric are labelled with that metric's
      // name, which lives in the catalog. It is fetched once per workspace
      // (memoized in loadAnalysisMetricDefinitions) and only when needed.
      const needsCatalog = (state.trainingLoad.analysis.widgets || []).some((w) => (w.series || []).some((s) => s.metric_definition_id));
      if (needsCatalog) {
        void loadAnalysisMetricDefinitions().then(() => onPainted?.(), () => {});
      }
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

// Permanent delete of the dashboard that is currently OPEN (the menu only
// ever acts on a.dashboard - there is no per-row delete in the picker).
// The server removes the dashboard, its widgets and series, and every
// active-selection row pointing at it (v19). Deliberately NOT built on
// mutateDashboard(): that helper reloads the SAME selected dashboard after
// the write, which no longer exists here.
export async function deleteAnalysisDashboard(onPainted) {
  const a = state.trainingLoad.analysis;
  const target = a.dashboard;
  if (!target) return false;
  a.saving = true;
  a.mutationError = "";
  onPainted?.();
  let alreadyGone = false;
  try {
    await api(`/api/training-load/dashboards/${encodeURIComponent(target.id)}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision: target.revision }),
    });
  } catch (error) {
    a.saving = false;
    if (error.status === 404) {
      // Already gone (deleted elsewhere, or by a concurrent request) - the
      // same cleanup as a successful delete, never a "phantom" dashboard
      // left open (code-reviewer).
      alreadyGone = true;
    } else {
      if (error.status === 409 && error.message === "staleRevision") {
        await loadDashboardDetail(target.id, onPainted, { force: true });
        a.notice = "Dashboard changed on the server. Reloaded the latest version - review it before deleting.";
      } else {
        a.mutationError = {
          dashboardHasClones: "This dashboard has been cloned into other dashboards and cannot be permanently deleted. Archive it instead.",
          systemTemplateProtected: "System templates cannot be permanently deleted.",
          forbidden: "You can't delete this dashboard.",
        }[error.message] || error.message || "Could not delete this dashboard.";
      }
      onPainted?.();
      return false;
    }
  }
  a.saving = false;
  await forgetDeletedAnalysisDashboard(target, onPainted);
  a.notice = alreadyGone
    ? `Dashboard "${target.name}" no longer exists.`
    : `Dashboard "${target.name}" was permanently deleted.`;
  onPainted?.();
  return !alreadyGone;
}

// Drops a dashboard that no longer exists from every place the client
// holds it. The open view is cleared ONLY if that dashboard is still the
// selected one: the coach may have picked another dashboard while the
// DELETE was in flight, and that newer choice must survive (code-reviewer).
// Every cached list/detail/query entry is invalidated either way - which
// also discards a detail load still in flight - so the fallback step then
// reloads whatever is selected: the newer choice, the remaining active
// dashboard, or nothing (the empty state).
async function forgetDeletedAnalysisDashboard(target, onPainted) {
  const a = state.trainingLoad.analysis;
  if (a.selectedDashboardId === target.id) {
    a.dashboard = null;
    a.widgets = [];
    a.queryResult = null;
    a.selectedDashboardId = "";
    a.editMode = false;
    a.layoutDraft = null;
    a.metricPanel = null;
    a.editor = closedAnalysisWidgetEditor();
  }
  if (a.activeDashboardId === target.id) a.activeDashboardId = "";
  invalidateTrainingLoadAnalysis();
  await Promise.all([loadDashboards(onPainted), loadActiveDashboard(onPainted)]);
  await selectFallbackDashboard(onPainted, { force: true });
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
  // Dashboards UX H3: these two are DAY-level by the catalog
  // (BUILT_IN_FIXED_SCOPE) - "session" here made the panel's Save a 400.
  session_count: { aggregation: "sum", scope: "day" },
  last_session_date: { aggregation: "last", scope: "day" },
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
    // Set when a partial save left the server different from what the coach
    // last saw (see saveAnalysisMetricPanel): the footer's Cancel becomes
    // Close, and staleSeriesId names a series a retry must remove first.
    serverChanged: false,
    staleSeriesId: "",
    // Set when an add-first POST failed WITHOUT a status (network): the
    // server may or may not have added it. After the reload a series with
    // this metric is treated as that add - never POSTed again.
    pendingAddMetric: null,
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

// The POST body that recreates an existing series row exactly (used to put
// the previous metric back when a delete-first replace fails half-way).
function seriesRestoreBody(series) {
  const body = {
    seriesOrder: Number(series.series_order || 1),
    axis: series.axis || "primary",
    dataScopeLevel: series.data_scope_level,
    analyticalAggregation: series.analytical_aggregation,
    aggregationRolePolicy: series.aggregation_role_policy,
    coveragePolicy: series.coverage_policy,
    sourcePolicy: series.source_policy,
  };
  if (series.built_in_series_key) body.builtInSeriesKey = series.built_in_series_key;
  else if (series.metric_definition_id) body.metricDefinitionId = series.metric_definition_id;
  else if (Array.isArray(series.template_metric_key_hints) && series.template_metric_key_hints.length) body.templateMetricKeyHints = series.template_metric_key_hints;
  if (series.color) body.color = series.color;
  if (series.display_label) body.displayLabel = series.display_label;
  if (series.source_connection_id) body.sourceConnectionId = series.source_connection_id;
  if (series.comparison_period) body.comparisonPeriod = series.comparison_period;
  for (const key of Object.keys(body)) if (body[key] === undefined || body[key] === null) delete body[key];
  return body;
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
//
// Partial-failure contract (owner review of PR #89): a coach must never be
// left with a widget that has no metric while the panel still offers a
// "Cancel" that pretends nothing happened. So:
// - new widget, series POST fails -> the just-created empty widget is
//   DELETEd again (compensation); if that delete also fails, the panel
//   re-stages the created widget (a retry only adds the series) and says so;
// - metric change on an existing widget: the NEW series is POSTed FIRST and
//   the old one DELETEd only afterwards, so a failed add leaves the previous
//   metric untouched; if the delete fails, the new series is removed again
//   (compensation) and the previous metric stays; if even that fails, both
//   are on the widget and the panel says so (a retry removes the old one);
// - whenever the server state genuinely differs from what the coach last saw,
//   `panel.serverChanged` turns the footer's Cancel into Close.
// Any server write, successful or not, is followed by the ordinary list +
// detail + batch-query reload so the grid never shows a half-applied state.
export async function saveAnalysisMetricPanel(onPainted) {
  const a = state.trainingLoad.analysis;
  const panel = a.metricPanel;
  if (!panel || !a.dashboard || !metricPanelCanSave(panel)) return false;
  const base = `/api/training-load/dashboards/${encodeURIComponent(a.dashboard.id)}`;
  const post = (url, body) => api(url, { method: "POST", body: JSON.stringify(body) });
  const patch = (url, body) => api(url, { method: "PATCH", body: JSON.stringify(body) });
  const del = (url, body) => api(url, { method: "DELETE", body: JSON.stringify(body) });
  // A best-effort compensating call: true when it went through.
  const tryQuietly = async (fn) => { try { await fn(); return true; } catch { return false; } };
  const failure = (message, cause) => { const err = new Error(message); err.status = cause?.status; err.cause = cause; err.userFacing = true; return err; };
  const seriesSettings = { dataScopeLevel: panel.scope, analyticalAggregation: panel.aggregation };
  // The new-widget branch may stage widgetId mid-flight (see createdInFlight
  // below), so "new vs edit" is decided up front.
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
      const widgetUrl = `${base}/widgets/${encodeURIComponent(created.widgetId)}`;
      let seriesError = null;
      try {
        await post(`${widgetUrl}/series`, { expectedWidgetRevision: 1, seriesOrder: 1, ...seriesBodyForMetric(panel.metric), ...seriesSettings });
      } catch (error) {
        seriesError = error;
      }
      if (seriesError) {
        // Compensation: take the metric-less widget away again, so the
        // dashboard is exactly as it was and Cancel stays honest.
        if (await tryQuietly(() => del(widgetUrl, { expectedWidgetRevision: 1 }))) {
          throw failure(seriesError.status === 409 && seriesError.message === "staleRevision"
            ? "Dashboard changed on the server while saving - nothing was saved. Reloaded the latest version; check your settings and try again."
            : "Could not add the metric - nothing was saved. Check the settings and try again.", seriesError);
        }
        // The empty widget is on the dashboard and could not be removed:
        // stage it so a retry of Save only adds the series (never a second
        // widget), and be explicit about the server state.
        panel.widgetId = created.widgetId;
        panel.seriesId = "";
        panel.seriesOrder = 1;
        panel.originalMetric = null;
        panel.createdInFlight = true;
        panel.serverChanged = true;
        throw failure("The widget was created but its metric could not be added, and removing the empty widget failed too. Save again to add the metric, or close and delete the widget from the dashboard.", seriesError);
      }
    } else {
      const widget = (a.widgets || []).find((w) => w.id === panel.widgetId);
      if (!widget) throw failure("This widget no longer exists - reopen the dashboard and try again.");
      let revision = widget.revision;
      const seriesUrl = `${base}/widgets/${encodeURIComponent(widget.id)}/series`;
      const allSeries = [...(widget.series || [])].sort((l, r) => Number(l.series_order || 0) - Number(r.series_order || 0));
      // Leftover from an earlier partial replace (new added, old not removed):
      // remove the old series first, then carry on with an ordinary save.
      const stale = panel.staleSeriesId ? allSeries.find((s) => s.id === panel.staleSeriesId) : null;
      if (stale) {
        const deleted = await del(`${seriesUrl}/${encodeURIComponent(stale.id)}`, { expectedWidgetRevision: revision });
        wrote = true;
        panel.serverChanged = true; // persisted - Cancel must read Close from here on
        revision = deleted.widgetRevision ?? revision;
        panel.staleSeriesId = "";
      }
      const widgetPatch = {};
      if (panel.title.trim() !== widget.title) widgetPatch.title = panel.title.trim();
      if (panel.widgetType !== widget.widget_type) widgetPatch.widgetType = panel.widgetType;
      if (panel.groupBy !== widget.group_by) widgetPatch.groupBy = panel.groupBy;
      if (Object.keys(widgetPatch).length) {
        const updated = await patch(`${base}/widgets/${encodeURIComponent(widget.id)}`, { expectedWidgetRevision: revision, ...widgetPatch });
        wrote = true;
        panel.serverChanged = true; // persisted - Cancel must read Close from here on
        // PATCH returns the v17 update_widget_content row:
        // { widget: { widget_id, widget_revision, dashboard_id } } - the
        // series step below must carry THAT revision or it 409s.
        revision = updated.widget?.widget_revision ?? revision;
      }
      let series = allSeries.find((s) => s.id === panel.seriesId) || null;
      if (!series) {
        // code-reviewer (MEDIUM): a retry after a LOST response (the series
        // POST committed, the reply never arrived) must adopt the series the
        // reload shows instead of adding an identical second one.
        const adopted = allSeries.find((s) => sameMetric(metricPanelMetricForSeries(s), panel.metric)) || null;
        if (adopted) {
          series = adopted;
          panel.seriesId = adopted.id;
          panel.seriesOrder = Number(adopted.series_order || 1);
          panel.originalMetric = panel.metric;
        } else if (panel.originalMetric) {
          // A restored previous metric (new row id) is still the one to replace.
          const restoredOriginal = allSeries.find((s) => sameMetric(metricPanelMetricForSeries(s), panel.originalMetric)) || null;
          if (restoredOriginal) {
            series = restoredOriginal;
            panel.seriesId = restoredOriginal.id;
            panel.seriesOrder = Number(restoredOriginal.series_order || 1);
          }
        }
      }
      const capacity = ANALYSIS_SERIES_LIMITS[panel.widgetType] ?? ANALYSIS_SERIES_LIMITS[widget.widget_type] ?? 20;
      // H3 (code-reviewer HIGH): on a shared-axis chart an add-first POST of a
      // metric with another unit is refused by the axis-unit trigger - delete
      // first there as well (the restore below still protects the metric).
      if (series && !sameMetric(panel.metric, panel.originalMetric) && (allSeries.length >= capacity || ANALYSIS_SHARED_AXIS_TYPES.has(panel.widgetType))) {
        // AT CAPACITY (e.g. a KPI and its single series): add_series() would
        // be rejected, so this has to delete first. If the new series then
        // fails, the previous one is put back exactly as it was
        // (compensation); only if THAT fails too is the widget left without
        // a metric - said explicitly, with Close instead of Cancel, and a
        // retry that only adds.
        const deleted = await del(`${seriesUrl}/${encodeURIComponent(series.id)}`, { expectedWidgetRevision: revision });
        wrote = true;
        revision = deleted.widgetRevision ?? revision;
        let addError = null;
        try {
          await post(seriesUrl, { expectedWidgetRevision: revision, seriesOrder: Number(series.series_order || 1), ...seriesBodyForMetric(panel.metric), ...seriesSettings });
        } catch (error) {
          addError = error;
        }
        if (addError) {
          let restored = null;
          if (await tryQuietly(async () => { restored = await post(seriesUrl, { expectedWidgetRevision: revision, ...seriesRestoreBody(series) }); })) {
            // code-reviewer (MEDIUM): the restored row has a NEW id - point
            // the panel at it, or "Try again" would look for the deleted one
            // and add-first into a full KPI.
            panel.seriesId = restored?.seriesId || "";
            panel.seriesOrder = Number(series.series_order || 1);
            throw failure("Could not replace the metric - your previous metric was put back unchanged. Try again.", addError);
          }
          panel.seriesId = "";
          panel.originalMetric = null;
          panel.serverChanged = true;
          throw failure(addError.status === undefined
            ? "Could not confirm whether the new metric was added - the dashboard was reloaded. Check the widget, then save again or close."
            : "The previous metric was removed but the new one could not be added, and putting the previous one back failed too. Save again to add the metric, or close and pick one under Advanced settings.", addError);
        }
      } else if (!sameMetric(panel.metric, panel.originalMetric) || !series) {
        // Below capacity: ADD FIRST, remove afterwards - a failed add leaves
        // the previous metric untouched.
        const nextOrder = allSeries.reduce((m, s) => Math.max(m, Number(s.series_order || 0)), 0) + 1;
        // Owner review: an earlier add whose RESPONSE was lost may already be
        // on the reloaded widget - adopt it instead of adding a copy.
        const landed = panel.pendingAddMetric && sameMetric(panel.pendingAddMetric, panel.metric)
          ? allSeries.find((s) => s.id !== series?.id && sameMetric(metricPanelMetricForSeries(s), panel.metric)) || null
          : null;
        let added;
        if (landed) {
          added = { seriesId: landed.id, widgetRevision: revision };
        } else {
          try {
            added = await post(seriesUrl, { expectedWidgetRevision: revision, seriesOrder: nextOrder, ...seriesBodyForMetric(panel.metric), ...seriesSettings });
          } catch (error) {
            if (error.status === undefined) {
              // Unknown outcome: remember what was sent so the retry can
              // recognise it after the reload; the reload decides Cancel/Close.
              panel.pendingAddMetric = panel.metric;
              wrote = true; // the reload is what tells whether it landed
              throw failure("Could not confirm whether the new metric was added - the dashboard was reloaded. Check the widget, then save again or close.", error);
            }
            throw error;
          }
          wrote = true;
        }
        panel.pendingAddMetric = null;
        revision = added.widgetRevision ?? revision;
        if (series) {
          let deleteError = null;
          try {
            const deleted = await del(`${seriesUrl}/${encodeURIComponent(series.id)}`, { expectedWidgetRevision: revision });
            revision = deleted.widgetRevision ?? revision;
          } catch (error) {
            deleteError = error;
          }
          if (deleteError) {
            // Compensation: remove the series we just added, so the widget
            // shows exactly the previous metric again.
            if (await tryQuietly(() => del(`${seriesUrl}/${encodeURIComponent(added.seriesId)}`, { expectedWidgetRevision: revision }))) {
              throw failure("Could not replace the metric - your previous metric is unchanged. Try again.", deleteError);
            }
            // Both series are on the widget now: stage the new one as current
            // and remember the old one so a retry only removes it.
            panel.seriesId = added.seriesId;
            panel.seriesOrder = nextOrder;
            panel.originalMetric = panel.metric;
            panel.staleSeriesId = series.id;
            panel.serverChanged = true;
            throw failure("The new metric was added but the previous one could not be removed - the widget shows both for now. Save again to remove the previous metric, or close and remove it under Advanced settings.", deleteError);
          }
          // Keep the replaced series in its old slot when the widget has
          // other series (cosmetic - a failure here changes no data).
          const others = allSeries.filter((s) => s.id !== series.id && s.id !== stale?.id && s.id !== added.seriesId);
          if (others.length) {
            const order = [added.seriesId, ...others.map((s) => s.id)].map((seriesId, i) => ({ seriesId, seriesOrder: i + 1 }));
            await tryQuietly(() => api(`${seriesUrl}/reorder`, { method: "PUT", body: JSON.stringify({ expectedWidgetRevision: revision, order }) }));
          }
        }
      } else if (series.analytical_aggregation !== panel.aggregation || series.data_scope_level !== panel.scope) {
        await patch(`${seriesUrl}/${encodeURIComponent(series.id)}`, { expectedWidgetRevision: revision, ...seriesSettings });
        wrote = true;
      }
    }
    saved = true;
  } catch (error) {
    panel.saving = false;
    // No HTTP status = the request itself failed (network) AFTER it may have
    // committed server-side: reload so the grid and any retry see the truth.
    if (error.status === undefined && !error.userFacing) wrote = true;
    if (error.userFacing) panel.error = error.message;
    else if (error.status === 409 && error.message === "staleRevision") panel.error = "Dashboard changed on the server. Reloaded the latest version - check your settings and save again.";
    else panel.error = error.message || "Could not save this metric.";
    if (error.status === 409) wrote = true; // reload so the panel edits against the current revision
  }
  if (wrote) {
    invalidateTrainingLoadAnalysis();
    await loadDashboards(onPainted);
    if (a.selectedDashboardId) {
      await loadDashboardDetail(a.selectedDashboardId, onPainted, { force: true });
      await queryAnalysisDashboard(onPainted, { force: true });
    }
    if (panel.pendingAddMetric && a.metricPanel === panel) {
      // The reload tells whether the lost add landed: if it did, the widget
      // now carries both metrics and Cancel must read Close.
      const reloaded = (a.widgets || []).find((w) => w.id === panel.widgetId);
      const landed = (reloaded?.series || []).some((s) => s.id !== panel.seriesId && sameMetric(metricPanelMetricForSeries(s), panel.pendingAddMetric));
      if (landed) {
        panel.serverChanged = true;
        panel.error = "The new metric was added but the previous one is still on the widget. Save again to remove the previous metric, or close and remove it under Advanced settings.";
      } else {
        panel.pendingAddMetric = null; // it never landed - an ordinary retry
      }
    }
  }
  if (saved) {
    a.metricPanel = null;
    a.notice = wasNew ? "Metric added to the dashboard." : "Metric updated.";
  }
  onPainted?.();
  return saved;
}

// ------------------------------------------------------------
// Dashboards UX H3: the advanced per-series editor, staged.
//
// Every change in "Advanced settings" (widget title/type/per, clearing a
// filter override, adding/removing/reordering series, a series' metric and
// its settings) edits `editor.draft` only - nothing reaches the server until
// "Save changes". Save compares the draft with the widget as the server has
// it NOW (analysisEditorPlan) and applies the difference through the
// existing endpoints, threading the widget revision each call returns, in an
// order the v16/v17 triggers accept:
//   1. remove series (removed by the coach, or left over from an earlier
//      partial replace) - frees capacity before anything is added,
//   2. series settings, when the type moves away from KPI (a comparison
//      must be cleared before the type change is allowed),
//   3. the widget itself (title / type / per / filter override),
//   4. metric changes: resolve for an unresolved template series, otherwise
//      replace - ADD FIRST below the type's series cap, DELETE FIRST at the
//      cap with the previous series put back if the new one fails,
//   5. the remaining series settings,
//   6. new series,
//   7. the order, when it can differ.
// Partial-failure contract (same as the H1 panel, owner review of #89):
// nothing is ever silently lost or duplicated. Any failure stops the save,
// reloads the dashboard and rebases the draft on what the server now has
// (rebaseAnalysisEditorDraft: a lost add is recognised, never posted twice);
// what still differs stays staged for "Save again", and once anything was
// written the footer's Cancel reads Close.
// ------------------------------------------------------------

const SERIES_FIELDS = [
  ["displayLabel", "display_label"], ["axis", "axis"], ["color", "color"],
  ["dataScopeLevel", "data_scope_level"], ["analyticalAggregation", "analytical_aggregation"],
  ["sourcePolicy", "source_policy"], ["aggregationRolePolicy", "aggregation_role_policy"],
  ["coveragePolicy", "coverage_policy"], ["comparisonPeriod", "comparison_period"],
];
const NULLABLE_SERIES_FIELDS = new Set(["displayLabel", "color", "comparisonPeriod"]);

export function closedAnalysisWidgetEditor() {
  return { open: false, widgetId: "", seriesKey: "", draft: null, base: null, saving: false, error: "", serverChanged: false };
}

function sortedWidgetSeries(widget) {
  return [...(widget?.series || [])].sort((l, r) => Number(l.series_order || 0) - Number(r.series_order || 0));
}

export function analysisEditorMetricOf(row) {
  if (row.built_in_series_key) return { kind: "builtin", key: row.built_in_series_key };
  if (row.metric_definition_id) return { kind: "metric", id: row.metric_definition_id };
  return { kind: "template", hints: row.template_metric_key_hints || [] };
}

function sameEditorMetric(left, right) {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "builtin") return left.key === right.key;
  if (left.kind === "metric") return left.id === right.id;
  return JSON.stringify(left.hints || []) === JSON.stringify(right.hints || []);
}

function seriesFieldsOf(row) {
  const fields = {};
  for (const [key, column] of SERIES_FIELDS) fields[key] = row[column] ?? null;
  return fields;
}

function editorEntryFor(row) {
  return { key: row.id, id: row.id, metric: analysisEditorMetricOf(row), fields: seriesFieldsOf(row), sourceConnectionId: row.source_connection_id || null, pendingAdd: null };
}

function normalizedFilterOverride(override) {
  if (!override) return null;
  const clean = {};
  for (const [key, value] of Object.entries(override)) if (value !== null && value !== undefined && value !== "") clean[key] = value;
  return Object.keys(clean).length ? clean : null;
}

export function analysisEditorDraftFromWidget(widget) {
  return {
    title: widget.title || "",
    widgetType: widget.widget_type,
    groupBy: widget.group_by || "day",
    localFilterOverride: normalizedFilterOverride(widget.local_filter_override),
    series: sortedWidgetSeries(widget).map(editorEntryFor),
    removedIds: [],
    staleIds: [],
    nextKey: 1,
  };
}

export function openAnalysisWidgetEditor(widget) {
  const draft = analysisEditorDraftFromWidget(widget);
  // `base` is the widget as the coach first saw it: after a stale-revision
  // reload, only what the coach actually changed stays theirs (see
  // rebaseAnalysisEditorDraft).
  state.trainingLoad.analysis.editor = { ...closedAnalysisWidgetEditor(), open: true, widgetId: widget.id, seriesKey: draft.series[0]?.key || "", draft, base: analysisEditorDraftFromWidget(widget) };
}

export function editorSeriesEntry(draft, key) {
  return draft?.series.find((entry) => entry.key === key) || null;
}

export function addEditorSeries(draft) {
  const key = `new-${draft.nextKey}`;
  draft.nextKey += 1;
  const entry = {
    key, id: "", metric: null, sourceConnectionId: null, pendingAdd: null,
    fields: { displayLabel: null, axis: "primary", color: null, dataScopeLevel: "session", analyticalAggregation: "avg", sourcePolicy: null, aggregationRolePolicy: "standalone_and_source_rollup", coveragePolicy: "complete_and_partial", comparisonPeriod: null },
  };
  setEditorSeriesMetric(entry, { kind: "builtin", key: "rpe" });
  draft.series.push(entry);
  return key;
}

// Returns the key to select next (the neighbour), or "".
export function removeEditorSeries(draft, key) {
  const index = draft.series.findIndex((entry) => entry.key === key);
  if (index < 0) return "";
  const [entry] = draft.series.splice(index, 1);
  if (entry.id && !draft.removedIds.includes(entry.id)) draft.removedIds.push(entry.id);
  return (draft.series[index] || draft.series[index - 1])?.key || "";
}

export function moveEditorSeries(draft, key, direction) {
  const index = draft.series.findIndex((entry) => entry.key === key);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= draft.series.length) return;
  [draft.series[index], draft.series[next]] = [draft.series[next], draft.series[index]];
}

// A metric change keeps the series' settings, but never in a combination
// the table CHECKs refuse: a built-in is always source 'not_applicable' at
// its catalog-fixed data level; a catalog metric never 'not_applicable'.
export function setEditorSeriesMetric(entry, metric) {
  entry.metric = metric;
  if (metric.kind === "builtin") {
    entry.fields.sourcePolicy = "not_applicable";
    entry.sourceConnectionId = null;
    if (BUILT_IN_FIXED_SCOPE[metric.key]) entry.fields.dataScopeLevel = BUILT_IN_FIXED_SCOPE[metric.key];
  } else if (metric.kind === "metric" && (!entry.fields.sourcePolicy || entry.fields.sourcePolicy === "not_applicable")) {
    entry.fields.sourcePolicy = "all_with_conflicts";
  }
  // code-reviewer (MEDIUM): settings the catalog makes impossible for the
  // new metric are moved to the nearest allowed value (text values only
  // take last/none; a catalog metric only its configured data levels).
  const facts = editorMetricFacts(metric);
  if (facts.textual && !NON_NUMERIC_AGGREGATIONS.has(entry.fields.analyticalAggregation)) {
    entry.fields.analyticalAggregation = (metric.kind === "builtin" && BUILT_IN_DEFAULTS[metric.key]?.aggregation) || "last";
  }
  if (facts.scopes.length && !facts.scopes.includes(entry.fields.dataScopeLevel)) entry.fields.dataScopeLevel = facts.scopes[0];
}

// What the catalog says about a staged metric: its unit (undefined when not
// known client-side), whether it is text/boolean, and its allowed data levels.
function editorMetricFacts(metric) {
  if (metric?.kind === "builtin") {
    return { unit: BUILT_IN_SERIES_UNITS[metric.key], known: metric.key in BUILT_IN_SERIES_UNITS, textual: BUILT_IN_VALUE_TYPES[metric.key] === "text", scopes: [], label: BUILT_IN_SERIES.find((b) => b.key === metric.key)?.label || metric.key };
  }
  if (metric?.kind === "metric") {
    const def = (state.trainingLoad.analysis.metricPicker.definitions || []).find((d) => d.id === metric.id);
    return { unit: def ? (def.unit || null) : undefined, known: Boolean(def), textual: ["text", "boolean"].includes(def?.valueType), scopes: def?.scopeCapabilities || [], label: def?.label || "This metric" };
  }
  return { unit: undefined, known: false, textual: false, scopes: [], label: "This series" };
}

export function setEditorWidgetType(draft, widgetType) {
  draft.widgetType = widgetType;
  if (!analysisWidgetSupportsComparison(widgetType)) {
    for (const entry of draft.series) entry.fields.comparisonPeriod = null;
  }
}

// What would block a Save before any request is made ("" = nothing).
export function analysisEditorProblem(draft) {
  if (!draft) return "";
  const title = draft.title.trim();
  if (!title) return "Give the widget a title.";
  if (title.length > 200) return "The title can be at most 200 characters.";
  const cap = analysisSeriesLimit(draft.widgetType);
  if (draft.series.length > cap) {
    return `A ${ANALYSIS_WIDGET_TYPE_LABELS[draft.widgetType] || draft.widgetType} widget holds at most ${cap} series - remove ${draft.series.length - cap} or choose another type.`;
  }
  for (const entry of draft.series) {
    const fixed = entry.metric?.kind === "builtin" ? BUILT_IN_FIXED_SCOPE[entry.metric.key] : null;
    if (fixed && entry.fields.dataScopeLevel !== fixed) return `A built-in series is always at the ${fixed} level.`;
    if (entry.fields.sourcePolicy === "source_connection" && !entry.sourceConnectionId) return "Choosing one connected source is not available here yet - pick another data source.";
    if (entry.fields.comparisonPeriod && !analysisWidgetSupportsComparison(draft.widgetType)) return "Only a KPI widget can compare with a previous period.";
    const facts = editorMetricFacts(entry.metric);
    if (facts.textual && !NON_NUMERIC_AGGREGATIONS.has(entry.fields.analyticalAggregation)) return `${facts.label} can only show the latest value or raw values - choose "last" or "none".`;
    if (facts.scopes.length && !facts.scopes.includes(entry.fields.dataScopeLevel)) return `${facts.label} is only available at the ${facts.scopes.join(" / ")} level.`;
  }
  if (ANALYSIS_SHARED_AXIS_TYPES.has(draft.widgetType)) {
    const unitByAxis = new Map();
    for (const entry of draft.series) {
      const facts = editorMetricFacts(entry.metric);
      if (!facts.known) continue;
      const axis = entry.fields.axis || "primary";
      if (!unitByAxis.has(axis)) unitByAxis.set(axis, facts.unit);
      else if (unitByAxis.get(axis) !== facts.unit) return `Series on the ${axis} axis must share one unit - move ${facts.label} to the other axis or choose another metric.`;
    }
  }
  return "";
}

export function analysisEditorPlan(widget, draft) {
  if (!widget || !draft) return [];
  const rows = sortedWidgetSeries(widget);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const toRemove = [...new Set([...draft.staleIds, ...draft.removedIds])].filter((id) => byId.has(id));
  const ops = toRemove.map((seriesId) => ({ type: "deleteSeries", seriesId }));

  const widgetBody = {};
  if (draft.title.trim() !== widget.title) widgetBody.title = draft.title.trim();
  if (draft.widgetType !== widget.widget_type) widgetBody.widgetType = draft.widgetType;
  if (draft.groupBy !== (widget.group_by || "day")) widgetBody.groupBy = draft.groupBy;
  const override = normalizedFilterOverride(draft.localFilterOverride);
  if (JSON.stringify(override) !== JSON.stringify(normalizedFilterOverride(widget.local_filter_override))) widgetBody.localFilterOverride = override;

  const metricOps = [];
  const patches = [];
  const comparisonOn = [];
  const adds = [];
  for (const entry of draft.series) {
    const row = entry.id && !toRemove.includes(entry.id) ? byId.get(entry.id) : null;
    if (!row) {
      adds.push({ type: "addSeries", key: entry.key });
      continue;
    }
    if (!sameEditorMetric(entry.metric, analysisEditorMetricOf(row))) {
      if (row.resolution_status !== "resolved" && entry.metric?.kind === "metric") {
        metricOps.push({ type: "resolveSeries", key: entry.key, seriesId: row.id, metricDefinitionId: entry.metric.id });
      } else {
        // the replacement series is posted with the draft's settings; a
        // comparison can only be set once the widget is a KPI (below)
        metricOps.push({ type: "replaceSeries", key: entry.key, seriesId: row.id });
        if (widgetBody.widgetType && entry.fields.comparisonPeriod) comparisonOn.push({ type: "patchSeries", key: entry.key, seriesId: "", body: { comparisonPeriod: entry.fields.comparisonPeriod } });
        continue;
      }
    }
    const current = seriesFieldsOf(row);
    const body = {};
    for (const [key] of SERIES_FIELDS) {
      const next = entry.fields[key] ?? null;
      if (next === null && !NULLABLE_SERIES_FIELDS.has(key)) continue;
      if (next !== (current[key] ?? null)) body[key] = next;
    }
    if (body.comparisonPeriod && widgetBody.widgetType) {
      comparisonOn.push({ type: "patchSeries", key: entry.key, seriesId: row.id, body: { comparisonPeriod: body.comparisonPeriod } });
      delete body.comparisonPeriod;
    }
    if (Object.keys(body).length) patches.push({ type: "patchSeries", key: entry.key, seriesId: row.id, body });
  }

  // code-reviewer (MEDIUM): the v16 type-change trigger validates the series
  // that exist AT THAT MOMENT (cap, comparison only on KPI, one unit per
  // axis), so every series change the final state depends on happens before
  // the widget PATCH - except turning a comparison ON, which the series
  // trigger only allows once the widget is a KPI. New series come last,
  // under the new type's cap.
  // code-reviewer (re-review MEDIUM): the other direction - leaving a
  // shared-axis chart for a type without one - must change the type FIRST,
  // or the series changes are still judged by the old chart's one-unit-per-
  // axis rule. Charts carry no comparisons, and removals already ran, so a
  // move to a KPI stays within its cap.
  const typeFirst = Boolean(widgetBody.widgetType) && ANALYSIS_SHARED_AXIS_TYPES.has(widget.widget_type) && !ANALYSIS_SHARED_AXIS_TYPES.has(draft.widgetType);
  if (typeFirst) {
    ops.push({ type: "patchWidget", body: widgetBody }, ...metricOps, ...patches);
  } else {
    ops.push(...metricOps, ...patches);
    if (Object.keys(widgetBody).length) ops.push({ type: "patchWidget", body: widgetBody });
  }
  ops.push(...comparisonOn, ...adds);

  const keptInDraftOrder = draft.series.filter((entry) => entry.id && byId.has(entry.id) && !toRemove.includes(entry.id)).map((entry) => entry.id);
  const keptInServerOrder = rows.map((row) => row.id).filter((id) => keptInDraftOrder.includes(id));
  const orderChanged = keptInDraftOrder.join(",") !== keptInServerOrder.join(",");
  if (draft.series.length > 1 && (orderChanged || adds.length || metricOps.some((op) => op.type === "replaceSeries"))) ops.push({ type: "reorder" });
  return ops;
}

export function analysisEditorIsDirty(analysis = state.trainingLoad.analysis) {
  const editor = analysis.editor;
  if (!editor?.open || !editor.draft) return false;
  const widget = (analysis.widgets || []).find((w) => w.id === editor.widgetId);
  return analysisEditorPlan(widget, editor.draft).length > 0;
}

function editorSeriesPostBody(entry, seriesOrder) {
  const body = { seriesOrder };
  if (entry.metric.kind === "builtin") body.builtInSeriesKey = entry.metric.key;
  else if (entry.metric.kind === "metric") body.metricDefinitionId = entry.metric.id;
  else body.templateMetricKeyHints = entry.metric.hints;
  for (const [key] of SERIES_FIELDS) {
    const value = entry.fields[key];
    if (value !== null && value !== undefined && value !== "") body[key] = value;
  }
  if (body.sourcePolicy === "source_connection" && entry.sourceConnectionId) body.sourceConnectionId = entry.sourceConnectionId;
  return body;
}

// After a failed/partial save and the reload: line the draft up with what
// the server now has, keeping every change the coach still wants. `base` is
// the widget as the coach last saw it (editor.base): a field the coach did
// NOT change takes the server's current value, so a retry after a stale
// revision never reverts someone else's edit (code-reviewer HIGH, 3-way
// base/draft/server). Returns true when a lost add turned out to have
// landed (the server changed).
export function rebaseAnalysisEditorDraft(widget, draft, base = null) {
  let adopted = false;
  const rows = sortedWidgetSeries(widget);
  const ids = new Set(rows.map((row) => row.id));
  const referenced = new Set(draft.series.map((entry) => entry.id).filter(Boolean));
  for (const entry of draft.series) {
    if (!entry.pendingAdd) continue;
    // A POST whose response was lost: if a series with this metric appeared
    // that was not there before the POST, it landed - adopt it (a replace
    // that added first still has its previous series to remove).
    const known = new Set(entry.pendingAdd.knownIds);
    const landed = rows.find((row) => !known.has(row.id) && !referenced.has(row.id) && sameEditorMetric(analysisEditorMetricOf(row), entry.metric));
    if (landed) {
      if (entry.id && ids.has(entry.id)) draft.staleIds.push(entry.id);
      entry.id = landed.id;
      referenced.add(landed.id);
      adopted = true;
    }
    entry.pendingAdd = null;
  }
  const serverDraft = analysisEditorDraftFromWidget(widget);
  if (base) {
    for (const key of ["title", "widgetType", "groupBy"]) if (draft[key] === base[key]) draft[key] = serverDraft[key];
    if (JSON.stringify(draft.localFilterOverride) === JSON.stringify(base.localFilterOverride)) draft.localFilterOverride = serverDraft.localFilterOverride;
    const baseById = new Map(base.series.map((entry) => [entry.id, entry]));
    const serverById = new Map(serverDraft.series.map((entry) => [entry.id, entry]));
    const untouched = (entry, was) => sameEditorMetric(entry.metric, was.metric) && Object.keys(was.fields).every((key) => entry.fields[key] === was.fields[key]);
    draft.series = draft.series.filter((entry) => {
      const was = entry.id ? baseById.get(entry.id) : null;
      // deleted elsewhere and never touched here: let it go
      return !(was && !ids.has(entry.id) && untouched(entry, was));
    });
    for (const entry of draft.series) {
      const was = entry.id ? baseById.get(entry.id) : null;
      const now = entry.id ? serverById.get(entry.id) : null;
      if (!was || !now) continue;
      if (sameEditorMetric(entry.metric, was.metric)) entry.metric = now.metric;
      for (const key of Object.keys(was.fields)) if (entry.fields[key] === was.fields[key]) entry.fields[key] = now.fields[key];
      if (entry.sourceConnectionId === was.sourceConnectionId) entry.sourceConnectionId = now.sourceConnectionId;
    }
    // Order the coach did not touch follows the server's order.
    const baseOrder = base.series.map((entry) => entry.id);
    const known = draft.series.filter((entry) => entry.id && baseOrder.includes(entry.id));
    const newOnesLast = draft.series.findIndex((entry) => !entry.id || !baseOrder.includes(entry.id)) === -1
      || draft.series.slice(draft.series.findIndex((entry) => !entry.id || !baseOrder.includes(entry.id))).every((entry) => !entry.id || !baseOrder.includes(entry.id));
    const sameRelativeOrder = known.map((entry) => entry.id).join(",") === baseOrder.filter((id) => known.some((entry) => entry.id === id)).join(",");
    if (newOnesLast && sameRelativeOrder) {
      const position = new Map(rows.map((row, index) => [row.id, index]));
      const rest = draft.series.filter((entry) => !known.includes(entry));
      draft.series = [...known.sort((l, r) => (position.get(l.id) ?? 1e9) - (position.get(r.id) ?? 1e9)), ...rest];
    }
  }
  // Gone on the server (removed half-way through a replace, or changed here
  // but deleted elsewhere): add it again.
  for (const entry of draft.series) if (entry.id && !ids.has(entry.id)) entry.id = "";
  draft.removedIds = draft.removedIds.filter((id) => ids.has(id));
  draft.staleIds = [...new Set(draft.staleIds)].filter((id) => ids.has(id));
  // A series that appeared on the server meanwhile is shown, never deleted
  // behind the coach's back.
  const accounted = new Set([...draft.series.map((entry) => entry.id).filter(Boolean), ...draft.removedIds, ...draft.staleIds]);
  for (const row of rows) if (!accounted.has(row.id)) draft.series.push(editorEntryFor(row));
  return adopted;
}

export async function saveAnalysisWidgetEditor(onPainted) {
  const a = state.trainingLoad.analysis;
  const editor = a.editor;
  const draft = editor?.draft;
  if (!editor?.open || !draft || editor.saving || !a.dashboard) return false;
  const widget = (a.widgets || []).find((w) => w.id === editor.widgetId);
  if (!widget) {
    editor.error = "This widget no longer exists - close the editor.";
    onPainted?.();
    return false;
  }
  const problem = analysisEditorProblem(draft);
  if (problem) {
    editor.error = problem;
    onPainted?.();
    return false;
  }
  const plan = analysisEditorPlan(widget, draft);
  if (!plan.length) {
    a.editor = closedAnalysisWidgetEditor();
    onPainted?.();
    return true;
  }
  const widgetUrl = `/api/training-load/dashboards/${encodeURIComponent(a.dashboard.id)}/widgets/${encodeURIComponent(widget.id)}`;
  const seriesUrl = `${widgetUrl}/series`;
  const send = (method, url, body) => api(url, { method, body: JSON.stringify(body) });
  const failure = (message, cause) => { const err = new Error(message); err.status = cause?.status; err.cause = cause; err.userFacing = true; return err; };
  const rows = sortedWidgetSeries(widget);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const liveIds = new Set(rows.map((row) => row.id));
  // The widget's type as the SERVER has it at each step (the PATCH that
  // changes it comes after the series changes - see analysisEditorPlan).
  let currentType = widget.widget_type;
  let revision = widget.revision;
  let count = rows.length;
  let nextOrder = rows.reduce((max, row) => Math.max(max, Number(row.series_order || 0)), 0) + 1;
  let wrote = false;
  let saved = false;
  const written = (result) => {
    wrote = true;
    editor.serverChanged = true;
    revision = result?.widgetRevision ?? result?.widget?.widget_revision ?? revision;
  };
  // POST a series for `entry`; a request that fails without a status may
  // still have committed - remember what existed before, so the rebase can
  // recognise it after the reload.
  const postSeries = async (entry, seriesOrder) => {
    const knownIds = [...liveIds];
    try {
      const body = editorSeriesPostBody(entry, seriesOrder);
      // a comparison is turned on after the type change (plan: comparisonOn)
      if (!analysisWidgetSupportsComparison(currentType)) delete body.comparisonPeriod;
      const added = await send("POST", seriesUrl, { expectedWidgetRevision: revision, ...body });
      written(added);
      liveIds.add(added.seriesId);
      count += 1;
      entry.id = added.seriesId;
      entry.pendingAdd = null;
      return added;
    } catch (error) {
      if (error.status === undefined) entry.pendingAdd = { knownIds };
      throw error;
    }
  };
  const deleteSeries = async (seriesId) => {
    written(await send("DELETE", `${seriesUrl}/${encodeURIComponent(seriesId)}`, { expectedWidgetRevision: revision }));
    liveIds.delete(seriesId);
    count -= 1;
  };
  editor.saving = true;
  editor.error = "";
  onPainted?.();
  try {
    for (const op of plan) {
      const entry = op.key ? editorSeriesEntry(draft, op.key) : null;
      if (op.type === "deleteSeries") {
        await deleteSeries(op.seriesId);
        draft.removedIds = draft.removedIds.filter((id) => id !== op.seriesId);
        draft.staleIds = draft.staleIds.filter((id) => id !== op.seriesId);
      } else if (op.type === "patchWidget") {
        written(await send("PATCH", widgetUrl, { expectedWidgetRevision: revision, ...op.body }));
        if (op.body.widgetType) currentType = op.body.widgetType;
      } else if (op.type === "resolveSeries") {
        written(await send("POST", `${seriesUrl}/${encodeURIComponent(op.seriesId)}/resolve`, { expectedWidgetRevision: revision, metricDefinitionId: op.metricDefinitionId }));
      } else if (op.type === "patchSeries") {
        const seriesId = op.seriesId || entry?.id;
        if (seriesId) written(await send("PATCH", `${seriesUrl}/${encodeURIComponent(seriesId)}`, { expectedWidgetRevision: revision, ...op.body }));
      } else if (op.type === "addSeries") {
        await postSeries(entry, nextOrder);
        nextOrder += 1;
      } else if (op.type === "replaceSeries") {
        const previous = byId.get(op.seriesId);
        if (count < analysisSeriesLimit(currentType) && !ANALYSIS_SHARED_AXIS_TYPES.has(currentType)) {
          // Below the cap: ADD FIRST - a failed add leaves the previous metric untouched.
          await postSeries(entry, nextOrder);
          nextOrder += 1;
          try {
            await deleteSeries(previous.id);
          } catch (error) {
            draft.staleIds.push(previous.id);
            if (error.status === undefined) throw error;
            throw failure("The new metric was added, but the previous one could not be removed yet - both are on the widget for now. Save again to finish.", error);
          }
        } else {
          // At the cap (e.g. a KPI's single series), or on a shared-axis chart
          // where the new unit may differ: DELETE FIRST, then add
          // into the same slot; if the add fails, put the previous one back.
          await deleteSeries(previous.id);
          entry.id = "";
          try {
            await postSeries(entry, Number(previous.series_order || 1));
          } catch (error) {
            if (error.status === undefined) throw error;
            let restored = null;
            try {
              restored = await send("POST", seriesUrl, { expectedWidgetRevision: revision, ...seriesRestoreBody(previous) });
            } catch {
              restored = null;
            }
            if (restored) {
              written(restored);
              liveIds.add(restored.seriesId);
              count += 1;
              entry.id = restored.seriesId;
              throw failure("Could not replace the metric - the previous one was put back unchanged. Your other changes are still here; save again to retry.", error);
            }
            throw failure("The previous metric was removed but the new one could not be added, and putting it back failed too. Save again to add the new metric.", error);
          }
        }
      } else if (op.type === "reorder") {
        const order = draft.series.map((item, index) => ({ seriesId: item.id, seriesOrder: index + 1 }));
        if (order.length > 1 && order.every((item) => item.seriesId)) {
          written(await send("PUT", `${seriesUrl}/reorder`, { expectedWidgetRevision: revision, order }));
        }
      }
    }
    saved = true;
  } catch (error) {
    // No status = the request itself failed after it may have committed;
    // 409/404 = the dashboard or widget changed elsewhere - reload either way.
    if (error.status === undefined || error.status === 409 || error.status === 404) wrote = true;
    if (error.userFacing) editor.error = error.message;
    else if (error.status === undefined) editor.error = "Could not confirm whether the last change was saved - the dashboard was reloaded. Check the widget, then save again or close.";
    else if (error.status === 409 && error.message === "staleRevision") editor.error = "The widget changed on the server. Reloaded the latest version - your remaining changes are still here; check them and save again.";
    else if (error.status === 409) editor.error = "This dashboard can't be edited right now (archived or a template). Close the editor.";
    else editor.error = "The server refused one of the changes (a setting that doesn't fit this metric or widget type). What was saved so far is kept; the rest is still here - adjust it and save again.";
  }
  editor.saving = false;
  if (wrote) {
    invalidateTrainingLoadAnalysis();
    await loadDashboards(onPainted);
    if (a.selectedDashboardId) {
      await loadDashboardDetail(a.selectedDashboardId, onPainted, { force: true });
      await queryAnalysisDashboard(onPainted, { force: true });
    }
  }
  if (saved) {
    if (a.editor === editor) a.editor = closedAnalysisWidgetEditor();
    a.notice = "Widget settings saved.";
  } else if (a.editor === editor) {
    const reloaded = (a.widgets || []).find((w) => w.id === editor.widgetId);
    if (reloaded) {
      if (rebaseAnalysisEditorDraft(reloaded, draft, editor.base)) editor.serverChanged = true;
      editor.base = analysisEditorDraftFromWidget(reloaded);
      if (!editorSeriesEntry(draft, editor.seriesKey)) editor.seriesKey = draft.series[0]?.key || "";
    } else {
      editor.error = "This widget no longer exists - close the editor.";
    }
  }
  onPainted?.();
  return saved;
}

export async function deleteAnalysisWidget(widgetId, onPainted) {
  const w = state.trainingLoad.analysis.widgets.find((item) => item.id === widgetId);
  if (!w) return null;
  return mutateDashboard(() => api(`/api/training-load/dashboards/${encodeURIComponent(state.trainingLoad.analysis.dashboard.id)}/widgets/${encodeURIComponent(widgetId)}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedWidgetRevision: w.revision }),
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
  const limits = analysisLayoutLimits(widgetType);
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
  if (metricDefinitionsInFlight && metricDefinitionsInFlight.key === contextKey && metricDefinitionsInFlight.picker === picker) {
    return metricDefinitionsInFlight.promise;
  }
  const promise = fetchAnalysisMetricDefinitions(picker, contextKey);
  const entry = { key: contextKey, picker, promise };
  metricDefinitionsInFlight = entry;
  try {
    return await promise;
  } finally {
    if (metricDefinitionsInFlight === entry) metricDefinitionsInFlight = null;
  }
}

// Writes only into the picker it was started for. After a workspace switch
// the analysis state is a new object, so a late response for the old
// workspace already lands in the discarded one; the check below is defence in
// depth that also keeps the old load from recording its workspace key.
async function fetchAnalysisMetricDefinitions(picker, contextKey) {
  const current = () => state.trainingLoad.analysis.metricPicker === picker;
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
    if (!current()) return [];
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
    if (!current()) return [];
    picker.loading = false;
    picker.error = error.message || "Could not load metric definitions.";
    return [];
  }
}

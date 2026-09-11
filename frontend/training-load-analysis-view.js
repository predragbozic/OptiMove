import { BUILT_IN_SERIES } from "./training-load-analysis-data.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml, formatDate } from "./utils.js";

const WIDGET_TYPES = [
  { key: "kpi", label: "KPI" },
  { key: "table", label: "Table" },
  { key: "line_chart", label: "Line" },
  { key: "bar_chart", label: "Bar" },
];
const GROUP_BY = ["day", "week", "session", "component", "athlete", "cohort"];
const AGGREGATIONS = ["sum", "avg", "max", "last", "none"];
const SCOPE_LEVELS = ["day", "session", "component"];
const SOURCE_POLICIES = ["all_with_conflicts", "source_connection", "manual", "api_import", "csv_import", "derived", "not_applicable"];
const COVERAGE_POLICIES = ["complete_only", "complete_and_partial", "any"];
const ROLE_POLICIES = ["standalone_only", "standalone_and_source_rollup", "all_including_derived"];
const COMPARISONS = ["", "previous_period", "previous_year"];

function optionHtml(value, label, selected) {
  return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label || value)}</option>`;
}

function dashboardName(dashboard) {
  const flags = [];
  if (dashboard.id === state.trainingLoad.analysis.activeDashboardId) flags.push("Active");
  if (dashboard.is_template) flags.push("Template");
  if (dashboard.status === "archived") flags.push("Archived");
  return `${dashboard.name}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}

function selectedWidget() {
  return state.trainingLoad.analysis.widgets.find((w) => w.id === state.trainingLoad.analysis.editor.widgetId) || null;
}

function selectedSeries(widget) {
  return (widget?.series || []).find((s) => s.id === state.trainingLoad.analysis.editor.seriesId) || null;
}

function resultByWidgetId(widgetId) {
  return (state.trainingLoad.analysis.queryResult?.widgets || []).find((w) => w.widgetId === widgetId) || null;
}

function layoutFor(widget) {
  const draft = state.trainingLoad.analysis.layoutDraft?.find((entry) => entry.widgetId === widget.id);
  return draft || { widgetId: widget.id, x: widget.x, y: widget.y, width: widget.width, height: widget.height, mobileOrder: widget.mobile_order };
}

function canEdit() {
  const d = state.trainingLoad.analysis.dashboard;
  return Boolean(d) && d.status !== "archived" && !d.is_template;
}

function renderTopBarHtml() {
  const a = state.trainingLoad.analysis;
  const runtime = a.runtimeFilter || {};
  const dashboards = a.dashboards || [];
  const templates = dashboards.filter((d) => d.is_template && d.status !== "archived");
  return `
    <div class="tl-analysis-topbar">
      <label class="tl-analysis-control">
        <span>Dashboard</span>
        <select data-action="training-load-analysis-select-dashboard" aria-label="Analysis dashboard">
          <option value="">Choose dashboard</option>
          ${dashboards.map((d) => optionHtml(d.id, dashboardName(d), a.selectedDashboardId)).join("")}
        </select>
      </label>
      <button type="button" class="plain-button compact-button" data-action="training-load-analysis-create">Create</button>
      <label class="tl-analysis-control">
        <span>Template</span>
        <select data-action="training-load-analysis-clone-template">
          <option value="">Clone template</option>
          ${templates.map((d) => optionHtml(d.id, d.name, "")).join("")}
        </select>
      </label>
      <button type="button" class="plain-button compact-button ${a.editMode ? "is-active" : ""}" data-action="training-load-analysis-toggle-edit" ${canEdit() ? "" : "disabled"}>${a.editMode ? "Done" : "Edit"}</button>
      <label class="tl-analysis-control tl-analysis-date-control"><span>From</span><input type="date" data-action="training-load-analysis-period-from" value="${escapeAttr(a.period.dateFrom)}"></label>
      <label class="tl-analysis-control tl-analysis-date-control"><span>To</span><input type="date" data-action="training-load-analysis-period-to" value="${escapeAttr(a.period.dateTo)}"></label>
      <label class="tl-analysis-control tl-analysis-id-control"><span>Activity</span><input type="text" data-action="training-load-analysis-runtime-activity" value="${escapeAttr(runtime.activityId || "")}" placeholder="Optional ID" aria-label="Analysis activity filter"></label>
      <label class="tl-analysis-control tl-analysis-id-control"><span>Component</span><input type="text" data-action="training-load-analysis-runtime-component" value="${escapeAttr(runtime.componentId || "")}" placeholder="Optional ID" aria-label="Analysis component filter"></label>
      <button type="button" class="plain-button compact-button" data-action="training-load-filter-open">Filter${filterCountLabel()}</button>
      ${a.editMode ? `<button type="button" class="plain-button compact-button tl-analysis-primary" data-action="training-load-analysis-add-widget">Add widget</button>` : ""}
    </div>
  `;
}

function filterCountLabel() {
  const f = state.trainingLoad.filter;
  const count = (f.clubIds || []).length + (f.teamIds || []).length + (f.athleteIds || []).length;
  const runtime = state.trainingLoad.analysis.runtimeFilter;
  const runtimeCount = (runtime.athleteIds?.length || 0) + (runtime.activityId ? 1 : 0) + (runtime.componentId ? 1 : 0);
  return count + runtimeCount ? ` (${count + runtimeCount})` : "";
}

function renderEmptyHtml() {
  return `
    <section class="panel tl-analysis-empty">
      <p class="eyebrow">Analysis</p>
      <h3>No dashboard selected</h3>
      <p class="muted">Create a dashboard, choose an existing one, or clone a template for this workspace.</p>
      <div class="tl-analysis-empty-actions">
        <button type="button" class="plain-button" data-action="training-load-analysis-create">Create dashboard</button>
        <button type="button" class="plain-button compact-button" data-action="training-load-analysis-focus-selector">Choose dashboard</button>
      </div>
    </section>
  `;
}

function renderWidgetToolbarHtml(widget, layout) {
  if (!state.trainingLoad.analysis.editMode || !canEdit()) return "";
  return `
    <div class="tl-analysis-widget-tools">
      <button type="button" class="plain-button icon-button" data-action="training-load-analysis-widget-left" data-widget-id="${escapeAttr(widget.id)}" aria-label="Move left" title="Move left">&larr;</button>
      <button type="button" class="plain-button icon-button" data-action="training-load-analysis-widget-right" data-widget-id="${escapeAttr(widget.id)}" aria-label="Move right" title="Move right">&rarr;</button>
      <button type="button" class="plain-button icon-button" data-action="training-load-analysis-widget-up" data-widget-id="${escapeAttr(widget.id)}" aria-label="Move up" title="Move up">&uarr;</button>
      <button type="button" class="plain-button icon-button" data-action="training-load-analysis-widget-down" data-widget-id="${escapeAttr(widget.id)}" aria-label="Move down" title="Move down">&darr;</button>
      <button type="button" class="plain-button icon-button" data-action="training-load-analysis-widget-wider" data-widget-id="${escapeAttr(widget.id)}" aria-label="Wider" title="Wider">+</button>
      <button type="button" class="plain-button icon-button" data-action="training-load-analysis-widget-narrower" data-widget-id="${escapeAttr(widget.id)}" aria-label="Narrower" title="Narrower">-</button>
      <button type="button" class="plain-button compact-button" data-action="training-load-analysis-edit-widget" data-widget-id="${escapeAttr(widget.id)}">Settings</button>
      <button type="button" class="plain-button compact-button" data-action="training-load-analysis-widget-mobile-up" data-widget-id="${escapeAttr(widget.id)}">Move up</button>
      <button type="button" class="plain-button compact-button" data-action="training-load-analysis-widget-mobile-down" data-widget-id="${escapeAttr(widget.id)}">Move down</button>
      <span class="muted">${Number(layout.width || 0)}x${Number(layout.height || 0)}</span>
    </div>
  `;
}

function seriesLabel(series) {
  if (series.display_label) return series.display_label;
  if (series.built_in_series_key) return BUILT_IN_SERIES.find((b) => b.key === series.built_in_series_key)?.label || series.built_in_series_key;
  if (series.metric_definition_id) return "Metric";
  const hint = series.template_metric_key_hints?.[0];
  return hint?.key || "Choose a metric";
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1);
  return String(value);
}

function renderSeriesStatusHtml(series, result) {
  if (series.resolution_status === "unresolved") return `<div class="tl-analysis-status is-unresolved">Choose a metric</div>`;
  if (series.resolution_status === "ambiguous") {
    const candidates = series.template_resolution_candidates || [];
    return `<div class="tl-analysis-status is-ambiguous">Ambiguous metric${candidates.length ? `: ${escapeHtml(String(candidates.length))} candidates` : ""}</div>`;
  }
  if (result?.status === "error") return `<div class="tl-analysis-status is-error">seriesQueryFailed</div>`;
  return "";
}

function flattenSeriesRows(result) {
  const current = result?.data?.current || [];
  const comparison = result?.data?.comparison || [];
  return { current, comparison };
}

function renderKpiHtml(widget, results) {
  const series = widget.series?.[0];
  if (!series) return `<p class="muted">Add a series to show this KPI.</p>`;
  const result = results?.series?.find((r) => r.seriesId === series.id);
  const status = renderSeriesStatusHtml(series, result);
  if (status) return status;
  const { current, comparison } = flattenSeriesRows(result);
  const first = current[0];
  const comp = comparison[0];
  return `
    <div class="tl-analysis-kpi">
      <span class="tl-analysis-kpi-value">${escapeHtml(formatValue(first?.value))}</span>
      <span class="tl-analysis-kpi-label">${escapeHtml(seriesLabel(series))}${first?.unit ? ` · ${escapeHtml(first.unit)}` : ""}</span>
      ${comp ? `<span class="tl-analysis-kpi-compare">Compare ${escapeHtml(formatValue(comp.value))}</span>` : ""}
      ${first?.conflict ? `<span class="tl-analysis-status is-conflict">Conflict</span>` : ""}
      ${first?.unitConflict ? `<span class="tl-analysis-status is-conflict">Unit conflict</span>` : ""}
    </div>
  `;
}

function renderTableHtml(widget, results) {
  const seriesResults = results?.series || [];
  if (!(widget.series || []).length) return `<p class="muted">Add series to build a table.</p>`;
  return `
    <div class="tl-analysis-table-wrap">
      <table class="tl-analysis-table">
        <thead><tr><th>Series</th><th>Bucket</th><th>Value</th><th>Unit</th><th>Status</th></tr></thead>
        <tbody>
          ${(widget.series || []).map((series) => {
            const result = seriesResults.find((r) => r.seriesId === series.id);
            const status = renderSeriesStatusHtml(series, result);
            if (status) return `<tr><td>${escapeHtml(seriesLabel(series))}</td><td colspan="4">${status}</td></tr>`;
            const rows = result?.data?.current || [];
            if (!rows.length) return `<tr><td>${escapeHtml(seriesLabel(series))}</td><td colspan="4" class="muted">No data</td></tr>`;
            return rows.map((row) => `
              <tr>
                <td>${escapeHtml(seriesLabel(series))}</td>
                <td>${escapeHtml(row.bucketKey || row.athleteId || "")}</td>
                <td>${escapeHtml(formatValue(row.value))}</td>
                <td>${escapeHtml(row.unit || "")}</td>
                <td>${[row.conflict ? "Conflict" : "", row.unitConflict ? "Unit conflict" : ""].filter(Boolean).join(" / ")}</td>
              </tr>
            `).join("");
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderChartHtml(widget, results, kind) {
  const series = widget.series || [];
  if (!series.length) return `<p class="muted">Add a series to draw the chart.</p>`;
  const rows = [];
  for (const s of series) {
    const result = results?.series?.find((r) => r.seriesId === s.id);
    if (s.resolution_status !== "resolved" || result?.status === "error") {
      rows.push({ label: seriesLabel(s), status: renderSeriesStatusHtml(s, result) });
      continue;
    }
    for (const point of result?.data?.current || []) {
      rows.push({ label: seriesLabel(s), bucket: point.bucketKey || "", value: Number(point.value), conflict: point.conflict || point.unitConflict });
    }
  }
  const numeric = rows.filter((r) => Number.isFinite(r.value));
  const max = Math.max(1, ...numeric.map((r) => Math.abs(r.value)));
  return `
    <div class="tl-analysis-chart ${kind === "line_chart" ? "is-line" : "is-bar"}">
      ${rows.map((row, index) => {
        if (row.status) return `<div class="tl-analysis-chart-row">${row.status}</div>`;
        const pct = Math.max(4, Math.min(100, Math.abs(row.value) / max * 100));
        return `
          <div class="tl-analysis-chart-row">
            <span class="tl-analysis-chart-label">${escapeHtml(row.bucket || row.label)}</span>
            <span class="tl-analysis-chart-track"><span style="width:${pct}%"></span></span>
            <span class="tl-analysis-chart-value">${escapeHtml(formatValue(row.value))}${row.conflict ? " !" : ""}</span>
          </div>
        `;
      }).join("")}
      ${!rows.length ? `<p class="muted">No data for ${escapeHtml(formatDate(state.trainingLoad.analysis.period.dateFrom))} - ${escapeHtml(formatDate(state.trainingLoad.analysis.period.dateTo))}.</p>` : ""}
    </div>
  `;
}

function renderWidgetBodyHtml(widget, results) {
  if (state.trainingLoad.analysis.queryLoading && !results) return `<p class="muted">Loading...</p>`;
  if (state.trainingLoad.analysis.queryError) return `<p class="builder-error">${escapeHtml(state.trainingLoad.analysis.queryError)}</p>`;
  if (widget.widget_type === "kpi") return renderKpiHtml(widget, results);
  if (widget.widget_type === "table") return renderTableHtml(widget, results);
  return renderChartHtml(widget, results, widget.widget_type);
}

function renderWidgetHtml(widget) {
  const layout = layoutFor(widget);
  const results = resultByWidgetId(widget.id);
  return `
    <article class="panel tl-analysis-widget tl-analysis-widget-${escapeAttr(widget.widget_type)}" style="--tl-x:${Number(layout.x || 0)};--tl-y:${Number(layout.y || 0)};--tl-w:${Number(layout.width || 4)};--tl-h:${Number(layout.height || 4)};--tl-mobile:${Number(layout.mobileOrder || 0)}">
      <header class="tl-analysis-widget-head">
        <div>
          <p class="eyebrow">${escapeHtml(widget.widget_type.replace("_", " "))}</p>
          <h3>${escapeHtml(widget.title)}</h3>
        </div>
        <span class="muted">rev ${escapeHtml(String(widget.revision))}</span>
      </header>
      ${renderWidgetBodyHtml(widget, results)}
      ${renderWidgetToolbarHtml(widget, layout)}
    </article>
  `;
}

function renderGridHtml() {
  const a = state.trainingLoad.analysis;
  if (a.detailLoading && !a.dashboard) return `<p class="muted training-load-empty">Loading dashboard...</p>`;
  if (a.detailError) return `<p class="builder-error">${escapeHtml(a.detailError)}</p>`;
  if (!a.dashboard) return renderEmptyHtml();
  const widgets = [...(a.widgets || [])].sort((l, r) => Number(layoutFor(l).mobileOrder || 0) - Number(layoutFor(r).mobileOrder || 0));
  return `
    <section class="tl-analysis-dashboard-head">
      <div>
        <p class="eyebrow">${a.dashboard.is_template ? "Template" : a.dashboard.status === "archived" ? "Archived" : "Dashboard"}</p>
        <h3>${escapeHtml(a.dashboard.name)}</h3>
        ${a.dashboard.description ? `<p class="muted">${escapeHtml(a.dashboard.description)}</p>` : ""}
      </div>
      ${a.editMode && canEdit() ? `
        <div class="tl-analysis-layout-actions">
          ${a.dashboard.id !== a.activeDashboardId ? `<button type="button" class="plain-button compact-button tl-analysis-active-action" data-action="training-load-analysis-set-active">Set active</button>` : `<span class="tl-analysis-active-badge">Active dashboard</span>`}
          <button type="button" class="plain-button compact-button" data-action="training-load-analysis-save-layout" ${a.layoutDraft && !a.saving ? "" : "disabled"}>Save layout</button>
          <button type="button" class="plain-button compact-button" data-action="training-load-analysis-cancel-layout" ${a.layoutDraft ? "" : "disabled"}>Cancel</button>
          <button type="button" class="plain-button compact-button" data-action="training-load-analysis-edit-dashboard">Metadata</button>
          <button type="button" class="plain-button compact-button danger" data-action="training-load-analysis-archive">Archive</button>
        </div>
      ` : ""}
      ${!a.editMode && canEdit() && a.dashboard.id !== a.activeDashboardId ? `
        <div class="tl-analysis-layout-actions">
          <button type="button" class="plain-button compact-button tl-analysis-active-action" data-action="training-load-analysis-set-active">Set active</button>
        </div>
      ` : ""}
    </section>
    ${a.dashboard.is_template ? `<p class="tl-analysis-status is-unresolved">Clone this template before querying or editing it.</p>` : ""}
    ${a.dashboard.status === "archived" ? `<p class="tl-analysis-status is-unresolved">Archived dashboards are read-only.</p>` : ""}
    ${widgets.length ? `<div class="tl-analysis-grid">${widgets.map(renderWidgetHtml).join("")}</div>` : `<section class="panel tl-analysis-empty"><h3>No widgets yet</h3><p class="muted">Enter Edit mode and add a KPI, table, line chart or bar chart.</p></section>`}
  `;
}

function renderWidgetTypeMenuHtml() {
  if (!state.trainingLoad.analysis.addWidgetOpen) return "";
  return `
    <div class="builder-athlete-overlay">
      <button class="builder-athlete-backdrop" type="button" data-action="training-load-analysis-close-add-widget" aria-label="Close"></button>
      <section class="panel tl-analysis-modal" role="dialog" aria-modal="true" aria-label="Add widget">
        <div class="builder-section-panel-head">
          <strong>Add widget</strong>
          <button type="button" class="plain-button icon-button" data-action="training-load-analysis-close-add-widget" aria-label="Close">&times;</button>
        </div>
        <div class="tl-analysis-widget-type-grid">
          ${WIDGET_TYPES.map((type) => `<button type="button" class="plain-button tl-analysis-type-button" data-action="training-load-analysis-create-widget" data-widget-type="${type.key}">${escapeHtml(type.label)}</button>`).join("")}
        </div>
      </section>
    </div>
  `;
}

function renderMetricPickerHtml(widget, series) {
  const picker = state.trainingLoad.analysis.metricPicker;
  const search = picker.search.trim().toLowerCase();
  const definitions = (picker.definitions || []).filter((d) => !search || `${d.label} ${d.key} ${d.unit || ""} ${d.domainLabel || ""}`.toLowerCase().includes(search));
  const groups = new Map();
  for (const d of definitions) {
    const key = d.domainLabel || d.categoryLabel || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  return `
    <div class="tl-analysis-metric-picker">
      <label class="search-field"><span>Search metrics</span><input type="search" data-action="training-load-analysis-metric-search" value="${escapeAttr(picker.search)}" placeholder="Metric name or unit"></label>
      <div class="tl-analysis-builtins">
        <p class="eyebrow">Built-in series</p>
        ${BUILT_IN_SERIES.map((b) => `<button type="button" class="plain-button compact-button" data-action="training-load-analysis-series-bind-builtin" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series?.id || "")}" data-built-in-key="${escapeAttr(b.key)}"><span class="tl-metric-icon-fallback">${escapeHtml(b.icon)}</span>${escapeHtml(b.label)}${b.unit ? ` · ${escapeHtml(b.unit)}` : ""}</button>`).join("")}
      </div>
      ${picker.loading ? `<p class="muted">Loading metrics...</p>` : ""}
      ${picker.error ? `<p class="builder-error">${escapeHtml(picker.error)}</p>` : ""}
      ${[...groups.entries()].map(([group, rows]) => `
        <div class="tl-analysis-metric-group">
          <p class="eyebrow">${escapeHtml(group)}</p>
          ${rows.map((d) => `<button type="button" class="tl-analysis-metric-option" data-action="training-load-analysis-series-bind-metric" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series?.id || "")}" data-metric-id="${escapeAttr(d.id)}">
            ${d.iconUrl ? `<img src="${escapeAttr(d.iconUrl)}" alt="">` : `<span class="tl-metric-icon-fallback">${escapeHtml((d.shortLabel || d.label || "?").slice(0, 1))}</span>`}
            <span><strong>${escapeHtml(d.label)}</strong><small>${escapeHtml([d.unit, d.valueType, d.domainLabel, d.categoryLabel, (d.scopeCapabilities || []).join("/")].filter(Boolean).join(" · "))}</small></span>
          </button>`).join("")}
        </div>
      `).join("")}
    </div>
  `;
}

function renderEditorHtml() {
  const editor = state.trainingLoad.analysis.editor;
  if (!editor.open) return "";
  const widget = selectedWidget();
  if (!widget) return "";
  const series = selectedSeries(widget);
  return `
    <div class="builder-athlete-overlay">
      <button class="builder-athlete-backdrop" type="button" data-action="training-load-analysis-close-editor" aria-label="Close"></button>
      <section class="panel tl-analysis-modal tl-analysis-editor" role="dialog" aria-modal="true" aria-label="Widget settings">
        <div class="builder-section-panel-head">
          <div><strong>Widget settings</strong><p class="muted">${escapeHtml(widget.title)}</p></div>
          <button type="button" class="plain-button icon-button" data-action="training-load-analysis-close-editor" aria-label="Close">&times;</button>
        </div>
        <div class="tl-analysis-editor-grid">
          <label>Title<input type="text" data-action="training-load-analysis-widget-title" data-widget-id="${escapeAttr(widget.id)}" value="${escapeAttr(widget.title)}"></label>
          <label>Type<select data-action="training-load-analysis-widget-type" data-widget-id="${escapeAttr(widget.id)}">${WIDGET_TYPES.map((t) => optionHtml(t.key, t.label, widget.widget_type)).join("")}</select></label>
          <label>Group by<select data-action="training-load-analysis-widget-group" data-widget-id="${escapeAttr(widget.id)}">${GROUP_BY.map((g) => optionHtml(g, g, widget.group_by)).join("")}</select></label>
          <label>Activity ID<input type="text" data-action="training-load-analysis-widget-activity-filter" data-widget-id="${escapeAttr(widget.id)}" value="${escapeAttr(widget.local_filter_override?.activityId || "")}"></label>
          <label>Component ID<input type="text" data-action="training-load-analysis-widget-component-filter" data-widget-id="${escapeAttr(widget.id)}" value="${escapeAttr(widget.local_filter_override?.componentId || "")}"></label>
        </div>
        <div class="tl-analysis-series-editor">
          <div class="tl-analysis-series-head">
            <strong>Series</strong>
            <button type="button" class="plain-button compact-button" data-action="training-load-analysis-add-series" data-widget-id="${escapeAttr(widget.id)}">Add series</button>
          </div>
          <div class="tl-analysis-series-list">
            ${(widget.series || []).map((s) => `
              <button type="button" class="tl-analysis-series-row ${editor.seriesId === s.id ? "is-active" : ""}" data-action="training-load-analysis-select-series" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(s.id)}">
                <span>${escapeHtml(seriesLabel(s))}</span>
                <small>${escapeHtml(s.resolution_status || "resolved")} · ${escapeHtml(s.axis || "primary")}</small>
              </button>
            `).join("") || `<p class="muted">No series yet.</p>`}
          </div>
          ${series ? `
            <div class="tl-analysis-editor-grid">
              <label>Label<input type="text" data-action="training-load-analysis-series-label" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series.id)}" value="${escapeAttr(series.display_label || "")}"></label>
              <label>Axis<select data-action="training-load-analysis-series-axis" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series.id)}">${["primary", "secondary"].map((v) => optionHtml(v, v, series.axis)).join("")}</select></label>
              <label>Color<input type="color" data-action="training-load-analysis-series-color" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series.id)}" value="${escapeAttr(series.color || "#0f766e")}"></label>
              <label>Scope<select data-action="training-load-analysis-series-scope" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series.id)}">${SCOPE_LEVELS.map((v) => optionHtml(v, v, series.data_scope_level)).join("")}</select></label>
              <label>Aggregation<select data-action="training-load-analysis-series-aggregation" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series.id)}">${AGGREGATIONS.map((v) => optionHtml(v, v, series.analytical_aggregation)).join("")}</select></label>
              <label>Source<select data-action="training-load-analysis-series-source" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series.id)}">${SOURCE_POLICIES.map((v) => optionHtml(v, v, series.source_policy)).join("")}</select></label>
              <label>Role policy<select data-action="training-load-analysis-series-role" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series.id)}">${ROLE_POLICIES.map((v) => optionHtml(v, v, series.aggregation_role_policy)).join("")}</select></label>
              <label>Coverage<select data-action="training-load-analysis-series-coverage" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series.id)}">${COVERAGE_POLICIES.map((v) => optionHtml(v, v, series.coverage_policy)).join("")}</select></label>
              <label>Comparison<select data-action="training-load-analysis-series-comparison" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series.id)}">${COMPARISONS.map((v) => optionHtml(v, v || "None", series.comparison_period || "")).join("")}</select></label>
            </div>
            <div class="tl-analysis-series-actions">
              <button type="button" class="plain-button compact-button" data-action="training-load-analysis-series-up" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series.id)}">Move up</button>
              <button type="button" class="plain-button compact-button" data-action="training-load-analysis-series-down" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series.id)}">Move down</button>
              <button type="button" class="plain-button compact-button danger" data-action="training-load-analysis-delete-series" data-widget-id="${escapeAttr(widget.id)}" data-series-id="${escapeAttr(series.id)}">Delete</button>
            </div>
            ${renderMetricPickerHtml(widget, series)}
          ` : ""}
        </div>
        <div class="tl-analysis-modal-actions">
          <button type="button" class="plain-button compact-button danger" data-action="training-load-analysis-delete-widget" data-widget-id="${escapeAttr(widget.id)}">Delete widget</button>
        </div>
      </section>
    </div>
  `;
}

export function renderTrainingLoadAnalysisHtml() {
  const a = state.trainingLoad.analysis;
  return `
    <div class="tl-analysis">
      ${renderTopBarHtml()}
      ${a.notice ? `<p class="tl-analysis-status">${escapeHtml(a.notice)}</p>` : ""}
      ${a.mutationError ? `<p class="builder-error">${escapeHtml(a.mutationError)}</p>` : ""}
      ${a.listError ? `<p class="builder-error">${escapeHtml(a.listError)}</p>` : ""}
      ${renderGridHtml()}
      ${renderWidgetTypeMenuHtml()}
      ${renderEditorHtml()}
    </div>
  `;
}

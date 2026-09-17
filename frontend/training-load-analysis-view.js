import { ANALYSIS_PERIOD_PRESETS, BUILT_IN_SERIES, analysisPeriodPresetKey, metricPanelCanSave } from "./training-load-analysis-data.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml, formatDate } from "./utils.js";

const WIDGET_TYPES = [
  { key: "kpi", label: "KPI", hint: "One number" },
  { key: "table", label: "Table", hint: "Rows per bucket" },
  { key: "line_chart", label: "Line", hint: "Trend over time" },
  { key: "bar_chart", label: "Bar", hint: "Compare buckets" },
];
const GROUP_BY = ["day", "week", "session", "component", "athlete", "cohort"];
const AGGREGATIONS = ["sum", "avg", "max", "last", "none"];
const SCOPE_LEVELS = ["day", "session", "component"];
// Dashboards UX H1: coach-facing labels for the guided panel's basic
// settings. The advanced editor below keeps showing the raw enum values.
const GROUP_BY_LABELS = { day: "Per day", week: "Per week", session: "Per session", component: "Per component", athlete: "Per athlete", cohort: "Whole group" };
const AGGREGATION_LABELS = { sum: "Total", avg: "Average", max: "Maximum", last: "Latest value", none: "Raw values" };
const SCOPE_LABELS = { day: "Day", session: "Session", component: "Component" };
const SOURCE_POLICIES = ["all_with_conflicts", "source_connection", "manual", "api_import", "csv_import", "derived", "not_applicable"];
const COVERAGE_POLICIES = ["complete_only", "complete_and_partial", "any"];
const ROLE_POLICIES = ["standalone_only", "standalone_and_source_rollup", "all_including_derived"];
const COMPARISONS = ["", "previous_period", "previous_year"];

function optionHtml(value, label, selected) {
  return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label || value)}</option>`;
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

// 3B3 UX slice: the "Choose activity" chip replaces the old raw Activity/
// Component ID text inputs - it always shows the activity's real name and
// date (never its UUID), and the Component select only appears once an
// activity is chosen, populated from that activity's own components (see
// training-load-analysis-open-in-analysis in training-load-actions.js,
// which is the only place selectedActivity/componentOptions get filled in,
// from the existing Calendar -> activity detail hand-off).
function renderActivityPickerHtml() {
  const a = state.trainingLoad.analysis;
  const runtime = a.runtimeFilter || {};
  if (!runtime.activityId) {
    return `<button type="button" class="plain-button compact-button" data-action="training-load-analysis-choose-activity">Choose activity</button>`;
  }
  const activity = a.selectedActivity;
  return `
    <div class="tl-analysis-activity-picker">
      <span class="tl-analysis-activity-chip">
        <strong>${escapeHtml(activity?.name || "Activity")}</strong>
        <small>${activity?.date ? escapeHtml(formatDate(activity.date)) : ""}</small>
      </span>
      <button type="button" class="plain-button icon-button" data-action="training-load-analysis-clear-activity" aria-label="Clear activity" title="Clear activity">&times;</button>
      ${(a.componentOptions || []).length ? `
        <label class="tl-analysis-control">
          <span>Component</span>
          <select data-action="training-load-analysis-runtime-component-select" aria-label="Analysis component filter">
            <option value="">Whole session</option>
            ${a.componentOptions.map((c) => optionHtml(c.id, c.name, runtime.componentId || "")).join("")}
          </select>
        </label>
      ` : ""}
    </div>
  `;
}

// ---------------- Dashboards UX H1: picker + popover menus ----------------
// One popover at a time (picker OR a menu); a transparent full-screen
// backdrop button behind it closes on outside click, Escape closes via
// closeTrainingLoadAnalysisOverlay() (training-load-actions.js). On phones
// the same markup renders as a bottom sheet (styles.css, <=720px).

const CHEVRON_ICON = `<svg class="tl-analysis-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;

function popoverBackdropHtml() {
  return `<button type="button" class="tl-popover-backdrop" data-action="training-load-analysis-close-popovers" aria-label="Close menu" tabindex="-1"></button>`;
}

function dashboardBadges(dashboard) {
  const a = state.trainingLoad.analysis;
  const badges = [];
  if (dashboard.id === a.activeDashboardId) badges.push(`<span class="tl-dash-badge is-active">Active</span>`);
  if (dashboard.is_template) badges.push(`<span class="tl-dash-badge">Template</span>`);
  if (dashboard.status === "archived") badges.push(`<span class="tl-dash-badge">Archived</span>`);
  return badges.join("");
}

// Groups for the picker list. The server list is already ordered by
// updated_at desc, so "Recent" is simply the first three live dashboards;
// it is skipped while searching (the matches themselves are the answer).
export function dashboardPickerGroups(dashboards, search) {
  const q = (search || "").trim().toLowerCase();
  const rows = (dashboards || []).filter((d) => !q || `${d.name} ${d.description || ""}`.toLowerCase().includes(q));
  const live = rows.filter((d) => !d.is_template && d.status !== "archived");
  const groups = [];
  if (!q && live.length > 3) groups.push({ key: "recent", label: "Recent", rows: live.slice(0, 3) });
  const mine = live.filter((d) => d.owner_scope === "user");
  const shared = live.filter((d) => d.owner_scope !== "user");
  if (mine.length) groups.push({ key: "mine", label: "My dashboards", rows: mine });
  if (shared.length) groups.push({ key: "shared", label: "Club & team", rows: shared });
  const templates = rows.filter((d) => d.is_template && d.status !== "archived");
  if (templates.length) groups.push({ key: "templates", label: "Templates", rows: templates });
  const archived = rows.filter((d) => d.status === "archived");
  if (archived.length) groups.push({ key: "archived", label: "Archived", rows: archived });
  return groups;
}

function renderDashboardPickerHtml() {
  const a = state.trainingLoad.analysis;
  const current = (a.dashboards || []).find((d) => d.id === a.selectedDashboardId) || a.dashboard;
  const open = a.picker.open;
  const groups = dashboardPickerGroups(a.dashboards, a.picker.search);
  return `
    <div class="tl-popover-anchor tl-dash-picker-anchor">
      <button type="button" class="plain-button tl-dash-picker-trigger ${open ? "is-open" : ""}" data-action="training-load-analysis-open-picker" aria-haspopup="dialog" aria-expanded="${open ? "true" : "false"}" aria-label="Choose dashboard">
        <span class="tl-dash-picker-trigger-text">
          <small>Dashboard</small>
          <strong>${current ? escapeHtml(current.name) : "Choose dashboard"}</strong>
        </span>
        ${CHEVRON_ICON}
      </button>
      ${open ? `
        ${popoverBackdropHtml()}
        <div class="tl-popover tl-dash-picker" role="dialog" aria-label="Choose dashboard">
          <label class="search-field tl-dash-picker-search"><span>Search dashboards</span><input type="search" data-action="training-load-analysis-picker-search" data-tl-analysis-search="picker" value="${escapeAttr(a.picker.search)}" placeholder="Search dashboards" autocomplete="off"></label>
          <div class="tl-dash-picker-list" role="listbox" aria-label="Dashboards">
            ${a.listLoading ? `<p class="muted tl-analysis-loading" aria-live="polite">Loading dashboards...</p>` : ""}
            ${!a.listLoading && !groups.length ? `<p class="muted tl-dash-picker-empty">${a.picker.search.trim() ? "No dashboards match your search." : "No dashboards yet - create your first one below."}</p>` : ""}
            ${groups.map((group) => `
              <div class="tl-dash-picker-group" role="group" aria-label="${escapeAttr(group.label)}">
                <p class="eyebrow">${escapeHtml(group.label)}</p>
                ${group.rows.map((d) => `
                  <button type="button" class="tl-dash-option ${d.id === a.selectedDashboardId ? "is-selected" : ""}" role="option" aria-selected="${d.id === a.selectedDashboardId ? "true" : "false"}" data-action="training-load-analysis-select-dashboard" data-dashboard-id="${escapeAttr(d.id)}">
                    <span class="tl-dash-option-text">
                      <strong>${escapeHtml(d.name)}</strong>
                      <small>${escapeHtml([d.description, d.updated_at ? `Updated ${formatDate(d.updated_at)}` : ""].filter(Boolean).join(" · "))}</small>
                    </span>
                    <span class="tl-dash-option-badges">${dashboardBadges(d)}</span>
                  </button>
                `).join("")}
              </div>
            `).join("")}
          </div>
          <div class="tl-popover-footer">
            <button type="button" class="plain-button compact-button tl-analysis-primary" data-action="training-load-analysis-new-dashboard"><svg class="tl-analysis-button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>New dashboard</span></button>
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

function menuItemHtml({ action, label, dataset = {}, disabled = false, danger = false, checked = null }) {
  const attrs = Object.entries(dataset).map(([k, v]) => `data-${k}="${escapeAttr(v)}"`).join(" ");
  return `<button type="button" class="tl-menu-item ${danger ? "is-danger" : ""}" role="${checked === null ? "menuitem" : "menuitemradio"}" ${checked === null ? "" : `aria-checked="${checked ? "true" : "false"}"`} data-action="${action}" ${attrs} ${disabled ? "disabled" : ""}>${label}</button>`;
}

function renderDashboardMenuHtml() {
  const a = state.trainingLoad.analysis;
  if (!a.dashboard || !canEdit()) return "";
  const open = a.menu === "dashboard";
  const isActive = a.dashboard.id === a.activeDashboardId;
  return `
    <div class="tl-popover-anchor">
      <button type="button" class="plain-button icon-button tl-menu-trigger ${open ? "is-open" : ""}" data-action="training-load-analysis-open-menu" data-menu="dashboard" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}" aria-label="Dashboard actions" title="Dashboard actions"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>
      ${open ? `
        ${popoverBackdropHtml()}
        <div class="tl-popover tl-menu" role="menu" aria-label="Dashboard actions">
          ${menuItemHtml({ action: "training-load-analysis-rename-dashboard", label: "Rename" })}
          ${isActive
            ? menuItemHtml({ action: "training-load-analysis-set-active", label: "Active dashboard", disabled: true })
            : menuItemHtml({ action: "training-load-analysis-set-active", label: "Set as active" })}
          ${menuItemHtml({ action: "training-load-analysis-toggle-edit", label: a.editMode ? "Done editing layout" : "Edit layout" })}
          ${menuItemHtml({ action: "training-load-analysis-archive", label: "Archive", danger: true })}
        </div>
      ` : ""}
    </div>
  `;
}

function renderPeriodMenuHtml() {
  const a = state.trainingLoad.analysis;
  const open = a.menu === "period";
  const presetKey = analysisPeriodPresetKey();
  const label = ANALYSIS_PERIOD_PRESETS.find((p) => p.key === presetKey)?.label || "Custom";
  return `
    <div class="tl-popover-anchor">
      <button type="button" class="plain-button tl-menu-trigger tl-period-trigger ${open ? "is-open" : ""}" data-action="training-load-analysis-open-menu" data-menu="period" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}" aria-label="Period preset">
        <span class="tl-dash-picker-trigger-text"><small>Period</small><strong>${escapeHtml(label)}</strong></span>
        ${CHEVRON_ICON}
      </button>
      ${open ? `
        ${popoverBackdropHtml()}
        <div class="tl-popover tl-menu" role="menu" aria-label="Period presets">
          ${ANALYSIS_PERIOD_PRESETS.map((p) => menuItemHtml({ action: "training-load-analysis-period-preset", label: escapeHtml(p.label), dataset: { preset: p.key }, checked: p.key === presetKey })).join("")}
          ${menuItemHtml({ action: "training-load-analysis-close-popovers", label: "Custom dates (From / To)", checked: presetKey === "custom" })}
        </div>
      ` : ""}
    </div>
  `;
}

function renderTopBarHtml() {
  const a = state.trainingLoad.analysis;
  return `
    <div class="tl-analysis-topbar">
      <div class="tl-analysis-topbar-group">
        ${renderDashboardPickerHtml()}
        ${renderDashboardMenuHtml()}
      </div>
      <div class="tl-analysis-topbar-group">
        ${renderPeriodMenuHtml()}
        <label class="tl-analysis-control tl-analysis-date-control"><span>From</span><input type="date" data-action="training-load-analysis-period-from" value="${escapeAttr(a.period.dateFrom)}"></label>
        <label class="tl-analysis-control tl-analysis-date-control"><span>To</span><input type="date" data-action="training-load-analysis-period-to" value="${escapeAttr(a.period.dateTo)}"></label>
      </div>
      <div class="tl-analysis-topbar-group">
        ${renderActivityPickerHtml()}
      </div>
    </div>
  `;
}

function renderEmptyHtml() {
  return `
    <section class="panel tl-analysis-empty">
      <p class="eyebrow">Dashboards</p>
      <h3>No dashboard selected</h3>
      <p class="muted">Create a dashboard, choose an existing one, or start from a template for this workspace.</p>
      <div class="tl-analysis-empty-actions">
        <button type="button" class="plain-button tl-analysis-primary" data-action="training-load-analysis-new-dashboard">New dashboard</button>
        <button type="button" class="plain-button compact-button" data-action="training-load-analysis-open-picker">Choose dashboard</button>
      </div>
    </section>
  `;
}

function renderWidgetToolbarHtml(widget, layout) {
  if (!state.trainingLoad.analysis.editMode || !canEdit()) return "";
  return `
    <div class="tl-analysis-widget-tools">
      <button type="button" class="plain-button icon-button tl-analysis-grid-control" data-action="training-load-analysis-widget-left" data-widget-id="${escapeAttr(widget.id)}" aria-label="Move left" title="Move left">&larr;</button>
      <button type="button" class="plain-button icon-button tl-analysis-grid-control" data-action="training-load-analysis-widget-right" data-widget-id="${escapeAttr(widget.id)}" aria-label="Move right" title="Move right">&rarr;</button>
      <button type="button" class="plain-button icon-button tl-analysis-grid-control" data-action="training-load-analysis-widget-up" data-widget-id="${escapeAttr(widget.id)}" aria-label="Move up" title="Move up">&uarr;</button>
      <button type="button" class="plain-button icon-button tl-analysis-grid-control" data-action="training-load-analysis-widget-down" data-widget-id="${escapeAttr(widget.id)}" aria-label="Move down" title="Move down">&darr;</button>
      <button type="button" class="plain-button icon-button tl-analysis-grid-control" data-action="training-load-analysis-widget-wider" data-widget-id="${escapeAttr(widget.id)}" aria-label="Wider" title="Wider">+</button>
      <button type="button" class="plain-button icon-button tl-analysis-grid-control" data-action="training-load-analysis-widget-narrower" data-widget-id="${escapeAttr(widget.id)}" aria-label="Narrower" title="Narrower">-</button>
      <button type="button" class="plain-button compact-button" data-action="training-load-analysis-edit-widget" data-widget-id="${escapeAttr(widget.id)}">Settings</button>
      <button type="button" class="plain-button compact-button danger" data-action="training-load-analysis-delete-widget" data-widget-id="${escapeAttr(widget.id)}">Delete</button>
      <button type="button" class="plain-button compact-button tl-analysis-mobile-reorder" data-action="training-load-analysis-widget-mobile-up" data-widget-id="${escapeAttr(widget.id)}">Move up</button>
      <button type="button" class="plain-button compact-button tl-analysis-mobile-reorder" data-action="training-load-analysis-widget-mobile-down" data-widget-id="${escapeAttr(widget.id)}">Move down</button>
      <span class="muted tl-analysis-grid-control">${Number(layout.width || 0)}x${Number(layout.height || 0)}</span>
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
        <thead><tr><th scope="col">Series</th><th scope="col">Bucket</th><th scope="col">Value</th><th scope="col">Unit</th><th scope="col">Status</th></tr></thead>
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
  if (state.trainingLoad.analysis.queryLoading && !results) return `<p class="muted tl-analysis-loading" aria-live="polite">Loading...</p>`;
  if (state.trainingLoad.analysis.queryError) return `<p class="builder-error" role="alert">${escapeHtml(state.trainingLoad.analysis.queryError)}</p>`;
  if (widget.widget_type === "kpi") return renderKpiHtml(widget, results);
  if (widget.widget_type === "table") return renderTableHtml(widget, results);
  return renderChartHtml(widget, results, widget.widget_type);
}

function renderWidgetHtml(widget) {
  const layout = layoutFor(widget);
  const results = resultByWidgetId(widget.id);
  return `
    <article class="panel tl-analysis-widget tl-analysis-widget-${escapeAttr(widget.widget_type)}" data-analysis-widget-id="${escapeAttr(widget.id)}" style="--tl-x:${Number(layout.x || 0)};--tl-y:${Number(layout.y || 0)};--tl-w:${Number(layout.width || 4)};--tl-h:${Number(layout.height || 4)};--tl-mobile:${Number(layout.mobileOrder || 0)}">
      ${state.trainingLoad.analysis.editMode && canEdit() ? `<button type="button" class="tl-analysis-widget-move" data-analysis-drag-handle="true" aria-label="Move widget" title="Move widget"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M8 7l4-4 4 4M16 17l-4 4-4-4M7 8l-4 4 4 4M17 16l4-4-4-4"/></svg></button>` : ""}
      ${state.trainingLoad.analysis.editMode && canEdit() ? `<button type="button" class="tl-analysis-widget-delete" data-action="training-load-analysis-delete-widget" data-widget-id="${escapeAttr(widget.id)}" aria-label="Delete widget" title="Delete widget"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14"/></svg></button>` : ""}
      <header class="tl-analysis-widget-head ${state.trainingLoad.analysis.editMode && canEdit() ? "is-draggable" : ""}" data-analysis-drag-handle="${state.trainingLoad.analysis.editMode && canEdit() ? "true" : "false"}">
        <div>
          <p class="eyebrow">${escapeHtml(widget.widget_type.replace("_", " "))}</p>
          <h3>${escapeHtml(widget.title)}</h3>
        </div>
        <span class="muted">rev ${escapeHtml(String(widget.revision))}</span>
      </header>
      ${renderWidgetBodyHtml(widget, results)}
      ${renderWidgetToolbarHtml(widget, layout)}
      ${state.trainingLoad.analysis.editMode && canEdit() ? `<button type="button" class="tl-analysis-resize-handle" data-analysis-resize-handle aria-label="Resize widget" title="Resize widget"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20h12V8M13 20l7-7M18 20l2-2"/></svg></button>` : ""}
    </article>
  `;
}

function renderGridHtml() {
  const a = state.trainingLoad.analysis;
  if (a.detailLoading && !a.dashboard) return `<p class="muted training-load-empty tl-analysis-loading" aria-live="polite">Loading dashboard...</p>`;
  if (a.detailError) return `<p class="builder-error" role="alert">${escapeHtml(a.detailError)}</p>`;
  if (!a.dashboard) return renderEmptyHtml();
  const widgets = [...(a.widgets || [])].sort((l, r) => Number(layoutFor(l).mobileOrder || 0) - Number(layoutFor(r).mobileOrder || 0));
  return `
    <section class="tl-analysis-dashboard-head">
      <div>
        <p class="eyebrow">${a.dashboard.is_template ? "Template" : a.dashboard.status === "archived" ? "Archived" : "Dashboard"}</p>
        <h3>${escapeHtml(a.dashboard.name)}</h3>
        ${a.dashboard.description ? `<p class="muted">${escapeHtml(a.dashboard.description)}</p>` : ""}
      </div>
      ${canEdit() ? `
        <div class="tl-analysis-layout-actions">
          ${a.editMode ? `
            <button type="button" class="plain-button compact-button" data-action="training-load-analysis-save-layout" ${a.layoutDraft && !a.saving ? "" : "disabled"}>Save layout</button>
            <button type="button" class="plain-button compact-button" data-action="training-load-analysis-cancel-layout" ${a.layoutDraft ? "" : "disabled"}>Cancel</button>
            <button type="button" class="plain-button compact-button is-active" data-action="training-load-analysis-toggle-edit">Done</button>
          ` : ""}
          <button type="button" class="plain-button compact-button tl-analysis-primary tl-analysis-add-widget-button" data-action="training-load-analysis-add-widget"><svg class="tl-analysis-button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add metric</span></button>
        </div>
      ` : ""}
    </section>
    ${a.dashboard.is_template ? `
      <div class="tl-analysis-template-banner">
        <p class="tl-analysis-status is-unresolved">This is a template. Clone it before querying or editing it.</p>
        <button type="button" class="plain-button compact-button tl-analysis-primary" data-action="training-load-analysis-clone-template" data-template-id="${escapeAttr(a.dashboard.id)}">Use template</button>
      </div>
    ` : ""}
    ${a.dashboard.status === "archived" ? `<p class="tl-analysis-status is-unresolved">Archived dashboards are read-only.</p>` : ""}
    ${widgets.length
      ? `<div class="tl-analysis-grid">${widgets.map(renderWidgetHtml).join("")}</div>`
      : `<section class="panel tl-analysis-empty">
          <h3>No metrics yet</h3>
          <p class="muted">${canEdit() ? "Pick a metric (RPE, sRPE, duration or any catalog metric), choose how to show it, and it appears here." : "This dashboard has no widgets."}</p>
          ${canEdit() ? `<div class="tl-analysis-empty-actions"><button type="button" class="plain-button tl-analysis-primary" data-action="training-load-analysis-add-widget">Add your first metric</button></div>` : ""}
        </section>`}
  `;
}

// ---------------- Dashboards UX H1: "New dashboard" / "Rename" dialog ----------------
// The <form> carries data-tl-analysis-form, NOT data-action: app.js's
// handleContentClick resolves closest("[data-action]"), so a data-action on
// the form itself would turn every click inside it (a label, the title, the
// padding) into a submit (code-reviewer HIGH). Only the submit event
// (handleContentSubmit) dispatches the -dashboard-form-submit action.

function renderDashboardFormHtml() {
  const form = state.trainingLoad.analysis.dashboardForm;
  if (!form) return "";
  const isRename = form.mode === "rename";
  return `
    <div class="builder-athlete-overlay">
      <button class="builder-athlete-backdrop" type="button" data-action="training-load-analysis-dashboard-form-cancel" aria-label="Close"></button>
      <form class="panel tl-analysis-modal tl-dash-form" role="dialog" aria-modal="true" aria-labelledby="tl-dash-form-title" data-tl-analysis-form="dashboard" novalidate>
        <div class="tl-overlay-head">
          <strong id="tl-dash-form-title">${isRename ? "Rename dashboard" : "New dashboard"}</strong>
          <button type="button" class="plain-button icon-button" data-action="training-load-analysis-dashboard-form-cancel" aria-label="Close">&times;</button>
        </div>
        <div class="tl-analysis-editor-grid tl-dash-form-grid">
          <label>Name<input type="text" name="name" data-action="training-load-analysis-dashboard-form-name" value="${escapeAttr(form.name)}" maxlength="200" required autocomplete="off" ${form.submitting ? "disabled" : ""}></label>
          ${isRename ? "" : `<label>Description <span class="muted">(optional)</span><input type="text" name="description" data-action="training-load-analysis-dashboard-form-description" value="${escapeAttr(form.description)}" maxlength="2000" autocomplete="off" ${form.submitting ? "disabled" : ""}></label>`}
        </div>
        ${form.error ? `<p class="builder-error" role="alert">${escapeHtml(form.error)}</p>` : ""}
        <div class="tl-analysis-modal-actions tl-dash-form-actions">
          <button type="button" class="plain-button compact-button" data-action="training-load-analysis-dashboard-form-cancel" ${form.submitting ? "disabled" : ""}>Cancel</button>
          <button type="submit" class="plain-button compact-button tl-analysis-primary" ${form.submitting ? "disabled" : ""}>${form.submitting ? "Saving..." : (isRename ? "Save name" : "Create dashboard")}</button>
        </div>
      </form>
    </div>
  `;
}

// ---------------- Dashboards UX H1: guided "Add metric" panel ----------------
// Staged client-side (see emptyAnalysisMetricPanel in training-load-
// analysis-data.js); the preview card below is a CONFIGURATION preview -
// the batch query only knows saved widgets, so real values show on the
// dashboard right after Save.

function renderPanelMetricListHtml(panel) {
  const picker = state.trainingLoad.analysis.metricPicker;
  const search = panel.search.trim().toLowerCase();
  const builtIns = BUILT_IN_SERIES.filter((b) => !search || `${b.label} ${b.unit}`.toLowerCase().includes(search));
  const definitions = (picker.definitions || []).filter((d) => !search || `${d.label} ${d.key} ${d.unit || ""} ${d.domainLabel || ""}`.toLowerCase().includes(search));
  const groups = new Map();
  for (const d of definitions) {
    const key = d.domainLabel || d.categoryLabel || "Other metrics";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const isSelected = (metric) => panel.metric && panel.metric.kind === metric.kind && (metric.kind === "builtin" ? panel.metric.key === metric.key : panel.metric.id === metric.id);
  return `
    <div class="tl-metric-panel-list">
      ${builtIns.length ? `
        <div class="tl-analysis-metric-group">
          <p class="eyebrow">Training load</p>
          ${builtIns.map((b) => `<button type="button" class="tl-analysis-metric-option ${isSelected({ kind: "builtin", key: b.key }) ? "is-selected" : ""}" aria-pressed="${isSelected({ kind: "builtin", key: b.key }) ? "true" : "false"}" data-action="training-load-analysis-panel-pick-builtin" data-built-in-key="${escapeAttr(b.key)}">
            <span class="tl-metric-icon-fallback">${escapeHtml(b.icon)}</span>
            <span><strong>${escapeHtml(b.label)}</strong><small>${escapeHtml(b.unit || "date")}</small></span>
          </button>`).join("")}
        </div>
      ` : ""}
      ${picker.loading ? `<p class="muted tl-analysis-loading" aria-live="polite">Loading metrics...</p>` : ""}
      ${picker.error ? `<p class="builder-error" role="alert">${escapeHtml(picker.error)}</p>` : ""}
      ${[...groups.entries()].map(([group, rows]) => `
        <div class="tl-analysis-metric-group">
          <p class="eyebrow">${escapeHtml(group)}</p>
          ${rows.map((d) => `<button type="button" class="tl-analysis-metric-option ${isSelected({ kind: "metric", id: d.id }) ? "is-selected" : ""}" aria-pressed="${isSelected({ kind: "metric", id: d.id }) ? "true" : "false"}" data-action="training-load-analysis-panel-pick-metric" data-metric-id="${escapeAttr(d.id)}">
            ${d.iconUrl ? `<img src="${escapeAttr(d.iconUrl)}" alt="">` : `<span class="tl-metric-icon-fallback">${escapeHtml((d.shortLabel || d.label || "?").slice(0, 1))}</span>`}
            <span><strong>${escapeHtml(d.label)}</strong><small>${escapeHtml([d.unit, d.valueType, d.categoryLabel].filter(Boolean).join(" · "))}</small></span>
          </button>`).join("")}
        </div>
      `).join("")}
      ${!builtIns.length && !groups.size && !picker.loading ? `<p class="muted">No metrics match "${escapeHtml(panel.search.trim())}".</p>` : ""}
    </div>
  `;
}

function renderPanelPreviewHtml(panel) {
  const type = WIDGET_TYPES.find((t) => t.key === panel.widgetType) || WIDGET_TYPES[0];
  const summary = panel.metric
    ? [`${AGGREGATION_LABELS[panel.aggregation] || panel.aggregation} ${panel.metric.label}`, panel.metric.unit ? panel.metric.unit : "", (GROUP_BY_LABELS[panel.groupBy] || panel.groupBy).toLowerCase()].filter(Boolean).join(" · ")
    : "Choose a metric to see the configuration";
  let body;
  if (panel.widgetType === "kpi") body = `<div class="tl-analysis-kpi"><span class="tl-analysis-kpi-value tl-preview-placeholder">--</span><span class="tl-analysis-kpi-label">${escapeHtml(summary)}</span></div>`;
  else if (panel.widgetType === "table") body = `<div class="tl-preview-rows" aria-hidden="true"><span></span><span></span><span></span></div><p class="tl-analysis-kpi-label">${escapeHtml(summary)}</p>`;
  else body = `<div class="tl-preview-bars ${panel.widgetType === "line_chart" ? "is-line" : ""}" aria-hidden="true"><span style="--h:40%"></span><span style="--h:70%"></span><span style="--h:55%"></span><span style="--h:85%"></span><span style="--h:60%"></span></div><p class="tl-analysis-kpi-label">${escapeHtml(summary)}</p>`;
  return `
    <article class="panel tl-analysis-widget tl-metric-panel-preview" aria-label="Widget preview">
      <header class="tl-analysis-widget-head"><div><p class="eyebrow">${escapeHtml(type.label)}</p><h3>${escapeHtml(panel.title.trim() || "Untitled metric")}</h3></div></header>
      ${body}
      <p class="muted tl-metric-panel-preview-note">Preview shows the configuration. Values appear on the dashboard after saving.</p>
    </article>
  `;
}

function renderMetricPanelHtml() {
  const a = state.trainingLoad.analysis;
  const panel = a.metricPanel;
  if (!panel) return "";
  const editing = Boolean(panel.widgetId) && !panel.createdInFlight;
  const canSave = metricPanelCanSave(panel);
  return `
    <div class="builder-athlete-overlay tl-metric-panel-overlay">
      <button class="builder-athlete-backdrop" type="button" data-action="training-load-analysis-panel-close" aria-label="Close" ${panel.saving ? "disabled" : ""}></button>
      <section class="panel tl-metric-panel" role="dialog" aria-modal="true" aria-labelledby="tl-metric-panel-title">
        <div class="tl-overlay-head tl-metric-panel-head">
          <div><strong id="tl-metric-panel-title">${editing ? "Edit metric" : "Add metric"}</strong><p class="muted">${panel.serverChanged ? "Part of this change is already on the dashboard." : editing ? "Changes apply when you save." : "Nothing is saved until you press Save."}</p></div>
          <button type="button" class="plain-button icon-button" data-action="training-load-analysis-panel-close" aria-label="Close" ${panel.saving ? "disabled" : ""}>&times;</button>
        </div>
        <div class="tl-metric-panel-body">
          <section class="tl-metric-panel-step">
            <h4><span class="tl-metric-panel-step-no">1</span>Metric</h4>
            ${panel.metric ? `<p class="tl-metric-panel-chosen"><span class="tl-analysis-activity-chip"><strong>${escapeHtml(panel.metric.label)}</strong>${panel.metric.unit ? `<small>${escapeHtml(panel.metric.unit)}</small>` : ""}</span></p>` : ""}
            <label class="search-field"><span>Search metrics</span><input type="search" data-action="training-load-analysis-panel-search" data-tl-analysis-search="metric" value="${escapeAttr(panel.search)}" placeholder="Search metrics" autocomplete="off"></label>
            ${renderPanelMetricListHtml(panel)}
          </section>
          <section class="tl-metric-panel-step">
            <h4><span class="tl-metric-panel-step-no">2</span>View</h4>
            <div class="tl-analysis-widget-type-grid tl-metric-panel-types">
              ${WIDGET_TYPES.map((type) => `<button type="button" class="plain-button tl-analysis-type-button ${panel.widgetType === type.key ? "is-selected" : ""}" aria-pressed="${panel.widgetType === type.key ? "true" : "false"}" data-action="training-load-analysis-panel-type" data-widget-type="${type.key}"><strong>${escapeHtml(type.label)}</strong><small>${escapeHtml(type.hint)}</small></button>`).join("")}
            </div>
          </section>
          <section class="tl-metric-panel-step">
            <h4><span class="tl-metric-panel-step-no">3</span>Settings</h4>
            <div class="tl-analysis-editor-grid">
              <label>Title<input type="text" data-action="training-load-analysis-panel-title" value="${escapeAttr(panel.title)}" maxlength="200" placeholder="${escapeAttr(panel.metric?.label || "Widget title")}"></label>
              <label>Show<select data-action="training-load-analysis-panel-field" data-field="groupBy">${GROUP_BY.map((g) => optionHtml(g, GROUP_BY_LABELS[g], panel.groupBy)).join("")}</select></label>
              <label>Calculate<select data-action="training-load-analysis-panel-field" data-field="aggregation">${AGGREGATIONS.map((v) => optionHtml(v, AGGREGATION_LABELS[v], panel.aggregation)).join("")}</select></label>
              <label>Data level<select data-action="training-load-analysis-panel-field" data-field="scope">${SCOPE_LEVELS.map((v) => optionHtml(v, SCOPE_LABELS[v], panel.scope)).join("")}</select></label>
            </div>
            ${editing ? `<div class="tl-metric-panel-advanced"><span class="muted">Source, coverage, comparison and extra series:</span> <button type="button" class="plain-button compact-button" data-action="training-load-analysis-open-advanced" data-widget-id="${escapeAttr(panel.widgetId)}">Advanced settings</button></div>` : ""}
          </section>
          <section class="tl-metric-panel-step">
            <h4><span class="tl-metric-panel-step-no">4</span>Preview</h4>
            ${renderPanelPreviewHtml(panel)}
          </section>
        </div>
        ${panel.error ? `<p class="builder-error" role="alert">${escapeHtml(panel.error)}</p>` : ""}
        ${panel.serverChanged ? `<p class="muted tl-metric-panel-server-note">Closing keeps what is already saved on the dashboard.</p>` : ""}
        <div class="tl-analysis-modal-actions tl-metric-panel-actions">
          <button type="button" class="plain-button compact-button" data-action="training-load-analysis-panel-close" ${panel.saving ? "disabled" : ""}>${panel.serverChanged ? "Close" : "Cancel"}</button>
          <button type="button" class="plain-button compact-button tl-analysis-primary" data-action="training-load-analysis-panel-save" ${canSave ? "" : "disabled"}>${panel.saving ? "Saving..." : (editing ? "Save changes" : "Save metric")}</button>
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
      ${picker.loading ? `<p class="muted tl-analysis-loading" aria-live="polite">Loading metrics...</p>` : ""}
      ${picker.error ? `<p class="builder-error" role="alert">${escapeHtml(picker.error)}</p>` : ""}
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
          <div class="tl-analysis-control">
            <span>Activity override</span>
            ${widget.local_filter_override?.activityId
              ? `<button type="button" class="plain-button compact-button" value="" data-action="training-load-analysis-widget-activity-filter" data-widget-id="${escapeAttr(widget.id)}">Clear activity override</button>`
              : `<span class="muted">Uses dashboard/runtime filter</span>`}
          </div>
          <div class="tl-analysis-control">
            <span>Component override</span>
            ${widget.local_filter_override?.componentId
              ? `<button type="button" class="plain-button compact-button" value="" data-action="training-load-analysis-widget-component-filter" data-widget-id="${escapeAttr(widget.id)}">Clear component override</button>`
              : `<span class="muted">Uses dashboard/runtime filter</span>`}
          </div>
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
      ${a.notice ? `<p class="tl-analysis-status" aria-live="polite">${escapeHtml(a.notice)}</p>` : ""}
      ${a.mutationError ? `<p class="builder-error" role="alert">${escapeHtml(a.mutationError)}</p>` : ""}
      ${a.listError ? `<p class="builder-error" role="alert">${escapeHtml(a.listError)}</p>` : ""}
      ${renderGridHtml()}
      ${renderDashboardFormHtml()}
      ${renderMetricPanelHtml()}
      ${renderEditorHtml()}
    </div>
  `;
}

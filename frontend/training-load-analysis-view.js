import {analysisEditorCanPreview,analysisEditorPreviewBody,metricPanelCanPreview,metricPanelPreviewBody} from './training-load-analysis-data.js';
import {referenceChartModel,referenceReason} from './dashboard-reference-model.js';
import {chartPickerIllustration,renderGalleryPicker} from './training-load-gallery-picker.js';
import {dashboardDisclosureOpen} from './training-load-dashboard-disclosures.js';
import {GALLERY_CHOICES} from './training-load-gallery-editor.js';
import {renderDashboardPages} from './training-load-pages-view.js';
import { calculationErrors, renderCalculationFormula, renderRatioCoverage } from './training-load-calculation-view.js';
import { analysisChartDay, analysisChartInteractionGeneration, BUILT_IN_FIXED_SCOPE, BUILT_IN_SERIES, analysisEditorDraftFromWidget, analysisEditorPlan, analysisEditorProblem, analysisLayoutLimits, analysisSeriesLimit, analysisWidgetSupportsComparison, metricPanelCanSave } from "./training-load-analysis-data.js";
import { renderSimpleEditorHtml } from './training-load-simple-view.js';
import { state } from "./state.js";
import { viewModuleOpen } from "./view-modules.js";
import { formatDashboardValue as formatValue, renderDashboardMetricTable, renderDashboardPivotTable } from "./training-load-dashboard-table.js";
import { buildDashboardWidgetDisplayModel } from "./training-load-analysis-display-model.js";
import { dashboardGroupLabels } from "./training-load-analysis-group-labels.js";
import { renderDashboardChartPlots } from "./training-load-analysis-echarts-options.js";
import { escapeAttr, escapeHtml, formatDate } from "./utils.js";
import { renderMetricIconHtml } from "./icon-render.js";
import { pickable, pickerName } from "./metric-picker-visibility.js";
import { CALCULATED_TEXT } from "./calculated-text.js";

const WIDGET_TYPES = [
  { key: "kpi", label: "KPI", hint: "One number" },
  { key: "table", label: "Table", hint: "Rows per bucket" },
  { key: "line_chart", label: "Line", hint: "Trend over time" },
  { key: "bar_chart", label: "Bar", hint: "Compare buckets" },
];
const GROUP_BY = ["day", "week", "session", "component", "athlete", "cohort"];
const AGGREGATIONS = ["sum", "avg", "min", "max", "last", "none", "ratio"];
const SCOPE_LEVELS = ["day", "session", "component"];
// Dashboards UX H1: coach-facing labels for the guided panel's basic
// settings (H4: the advanced editor uses them too).
const GROUP_BY_LABELS = { day: "Per day", week: "Per week", session: "Per session", component: "Per component", athlete: "Per athlete", cohort: "Whole group" };
const AGGREGATION_LABELS = { ratio: "Ratio", sum: "Total", avg: "Average", min: "Minimum", max: "Maximum", last: "Latest value", none: "Raw values" };
const SCOPE_LABELS = { day: "Day", session: "Session", component: "Component" };
const SOURCE_POLICIES = ["all_with_conflicts", "source_connection", "manual", "api_import", "csv_import", "derived", "estimate", "not_applicable"];
const COVERAGE_POLICIES = ["complete_only", "complete_and_partial", "any"];
const ROLE_POLICIES = ["standalone_only", "standalone_and_source_rollup", "all_including_derived"];
const COMPARISONS = ["", "previous_period", "previous_year"];
// Dashboards UX H4: labels for the advanced editor's stored values, named after
// what the query engine does with them (resolveFactsToRows and shiftDateRange
// in backend/src/trainingLoadDashboardQuery.js; value meanings in the v3
// Metrics-Core and v16 dashboard migrations). The stored values never change.
// Source filters a catalog metric's values by how they were recorded
// (occasion entry_method, metric_values.is_derived, source connection).
const SOURCE_LABELS = {
  all_with_conflicts: "All sources",
  source_connection: "One connected source",
  manual: "Manual entry only",
  api_import: "API import only",
  csv_import: "CSV import only",
  derived: "Calculated values only",
  estimate: "Estimates only",
  not_applicable: "Not used for built-in metrics",
};
// Values included filters by metric_values.aggregation_role: standalone = a value
// recorded as it is, source_rollup = a total reported by the source itself,
// derived_rollup = a total computed afterwards from other values.
const ROLE_POLICY_LABELS = {
  standalone_only: "Direct values only",
  standalone_and_source_rollup: "Direct values and source totals",
  all_including_derived: "Direct values, source totals and calculated totals",
};
// Total coverage filters totals by metric_values.coverage; a direct value has
// no coverage (not_applicable) and passes every option.
const COVERAGE_LABELS = {
  complete_only: "Complete totals only",
  complete_and_partial: "Complete and partial totals",
  any: "All totals, also unknown coverage",
};
const AXIS_LABELS = { primary: "Primary", secondary: "Secondary" };
const COMPARISON_LABELS = { "": "None", previous_period: "Previous period of the same length", previous_year: "Same dates last year" };

function optionHtml(value, label, selected) {
  return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label || value)}</option>`;
}

function selectedWidget() {
  return state.trainingLoad.analysis.widgets.find((w) => w.id === state.trainingLoad.analysis.editor.widgetId) || null;
}


function resultByWidgetId(widgetId) {
  return (state.trainingLoad.analysis.queryResult?.widgets || []).find((w) => w.widgetId === widgetId) || null;
}

function layoutFor(widget) {
  const draft = state.trainingLoad.analysis.layoutDraft?.find((entry) => entry.widgetId === widget.id);
  return draft || { widgetId: widget.id, x: widget.x, y: widget.y, width: widget.width, height: widget.height, mobileOrder: widget.mobile_order };
}

function pageBusy() {
  const a = state.trainingLoad.analysis;
  return Boolean(a.pagesAvailable && (a.pageLoading || a.pageSaving || a.pagePending));
}

// Roles V-6: a view workspace (club_view / team_view with dashboards.view) reads dashboards only: no New dashboard, no
// template copy, no edit, no Set as active, no delete. The server refuses every one of them there anyway.
function readOnlyView() {
  return viewModuleOpen("dashboards");
}

function canCreateDashboard() {
  return !readOnlyView() && state.trainingLoad.analysis.canCreateDashboard === true;
}

function canEditDashboard() {
  const a = state.trainingLoad.analysis;
  const d = a.dashboard;
  return Boolean(d) && d.status !== "archived" && !d.is_template && !readOnlyView() && a.dashboardCanManage === true;
}

function canEdit() {
  const a = state.trainingLoad.analysis;
  return canEditDashboard() && (!a.pagesAvailable || a.pageCanManage === true);
}

// Archived dashboards may still be deleted by an authorized owner.
function canDeleteDashboard() {
  const d = state.trainingLoad.analysis.dashboard;
  return Boolean(d) && d.owner_scope !== "system" && !readOnlyView() && state.trainingLoad.analysis.dashboardCanManage === true;
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
            ${!a.listLoading && !groups.length ? `<p class="muted tl-dash-picker-empty">${a.picker.search.trim() ? "No dashboards match your search." : readOnlyView() ? "No dashboards are shared here yet." : "No dashboards yet - create your first one below."}</p>` : ""}
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
          ${canCreateDashboard() ? `<div class="tl-popover-footer">
            <button type="button" class="plain-button compact-button tl-analysis-primary" data-action="training-load-analysis-new-dashboard"><svg class="tl-analysis-button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>New dashboard</span></button>
          </div>` : ""}
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
  if (!a.dashboard) return "";
  const open = a.menu === "dashboard";
  const isActive = a.dashboard.id === a.activeDashboardId;
  return `
    <div class="tl-popover-anchor">
      <button type="button" class="plain-button icon-button tl-menu-trigger ${open ? "is-open" : ""}" data-action="training-load-analysis-open-menu" data-menu="dashboard" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}" aria-label="Dashboard actions" title="Dashboard actions"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>
      ${open ? `
        ${popoverBackdropHtml()}
        <div class="tl-popover tl-menu" role="menu" aria-label="Dashboard actions">
          ${menuItemHtml({ action: "training-load-analysis-print", label: "Export page as PDF" })}
          ${canEditDashboard() ? menuItemHtml({ action: "training-load-analysis-rename-dashboard", label: "Rename" }) : ""}
          ${!readOnlyView() && a.dashboard.status !== "archived" && !a.dashboard.is_template ? `
            ${isActive
              ? menuItemHtml({ action: "training-load-analysis-set-active", label: "Active dashboard", disabled: true })
              : menuItemHtml({ action: "training-load-analysis-set-active", label: "Set as active" })}
          ` : ""}
          ${canEdit() ? `
            ${menuItemHtml({ action: "training-load-analysis-toggle-edit", label: a.editMode ? "Done editing layout" : "Edit layout" })}
          ` : ""}
          ${canEditDashboard() ? menuItemHtml({ action: "training-load-analysis-archive", label: "Archive", danger: true }) : ""}
          ${canDeleteDashboard() ? `
            ${canEditDashboard() ? `<div class="tl-menu-separator" role="separator"></div>` : ""}
            ${menuItemHtml({ action: "training-load-analysis-delete-dashboard", label: "Delete permanently", danger: true, disabled: a.saving })}
          ` : ""}
        </div>
      ` : ""}
    </div>
  `;
}

function renderTopBarHtml() {
  const chartDay=analysisChartDay();
  return `
    <div class="tl-analysis-topbar tl-analysis-topbar-compact">
      <div class="tl-compact-dashboard-picker">${renderDashboardPickerHtml()}</div>
      <div data-dashboard-controls="period" class="tl-compact-period-host"></div>
      <div class="tl-compact-dashboard-menu">${renderDashboardMenuHtml()}</div>
      ${chartDay?`<button type="button" class="plain-button compact-button tl-chart-day-chip" data-action="training-load-analysis-clear-chart-day" aria-label="Clear chart day filter">Chart day · ${escapeHtml(formatDate(chartDay))} ×</button>`:''}
      <section id="dashboard-period-panel" class="tl-compact-filter-panel" aria-label="Period and activity" hidden>
        <div data-dashboard-controls="fields"></div>
        <div class="tl-compact-activity-filter">${renderActivityPickerHtml()}</div>
      </section>
      ${renderLayoutBarHtml()}
    </div>
  `;
}

// ---------------- Dashboards UX H2: layout editing bar ----------------
// Layout editing is its own mode (dashboard or widget "⋯" -> Edit layout).
// While it is on, this bar is the one place to leave it: Cancel drops the
// local draft and exits; the primary button saves the draft (atomic
// PUT /layout) and exits, or reads "Done" while nothing has been moved.
// Desktop: a full-width row of the sticky top bar, so it stays in view
// while the grid scrolls. Phones (<= 720px, where the top bar is static):
// pinned to the bottom of the screen instead (styles.css).
function renderLayoutBarHtml() {
  const a = state.trainingLoad.analysis;
  if (!a.editMode || !canEdit()) return "";
  const dirty = Boolean(a.layoutDraft);
  return `
    <div class="tl-layout-bar" role="region" aria-label="Layout editing">
      <div class="tl-layout-bar-text">
        <strong>Editing layout</strong>
        <span class="muted tl-layout-bar-hint tl-layout-bar-hint-desktop">Drag a widget or use its arrows; drag the corner or use − / + to resize.</span>
        <span class="muted tl-layout-bar-hint tl-layout-bar-hint-phone">Use Move up / Move down to set the order on phones.</span>
        <span class="tl-layout-bar-status ${dirty ? "is-dirty" : ""}" aria-live="polite">${dirty ? "Unsaved changes" : "No changes yet"}</span>
      </div>
      <div class="tl-layout-bar-actions">
        <button type="button" class="plain-button compact-button" data-action="training-load-analysis-cancel-layout" ${a.saving ? "disabled" : ""}>Cancel</button>
        ${dirty
          ? `<button type="button" class="plain-button compact-button tl-analysis-primary" data-action="training-load-analysis-save-layout" ${a.saving ? "disabled" : ""}>${a.saving ? "Saving..." : "Save layout"}</button>`
          : `<button type="button" class="plain-button compact-button tl-analysis-primary" data-action="training-load-analysis-toggle-edit">Done</button>`}
      </div>
    </div>
  `;
}

function renderEmptyHtml() {
  if (!canCreateDashboard()) {
    return `
    <section class="panel tl-analysis-empty">
      <p class="eyebrow">Dashboards</p>
      <h3>No dashboard selected</h3>
      <p class="muted">Choose one of the dashboards shared here. You can look at them; changes are made by the people who manage this club or team.</p>
      <div class="tl-analysis-empty-actions">
        <button type="button" class="plain-button tl-analysis-primary" data-action="training-load-analysis-open-picker">Choose dashboard</button>
      </div>
    </section>
  `;
  }
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

// H2: layout-only controls, shown in layout mode (Settings/Delete moved to
// the widget "⋯" menu). A button that would be a no-op at the current
// position is disabled - clampAnalysisLayoutEntry would undo it anyway.
// Desktop gets the 12-column nudges and width -/+; phones only Move up/
// Move down, because the phone layout reads nothing but the order
// (styles.css hides each group where it has no visible effect).
function layoutToolButtonHtml(action, widgetId, label, symbol, disabled) {
  return `<button type="button" class="plain-button icon-button tl-layout-tool" data-action="training-load-analysis-widget-${action}" data-widget-id="${escapeAttr(widgetId)}" aria-label="${label}" title="${label}" ${disabled ? "disabled" : ""}>${symbol}</button>`;
}

function renderWidgetToolbarHtml(widget, layout, position) {
  if (!state.trainingLoad.analysis.editMode || !canEdit()) return "";
  const limits = analysisLayoutLimits(widget.widget_type);
  const x = Number(layout.x || 0);
  const y = Number(layout.y || 0);
  const width = Number(layout.width || limits.minWidth);
  const height = Number(layout.height || limits.minHeight);
  const id = widget.id;
  return `
    <div class="tl-analysis-widget-tools" role="group" aria-label="${escapeAttr(`Layout of ${widget.title}`)}">
      <div class="tl-layout-tool-group tl-analysis-grid-control">
        ${layoutToolButtonHtml("left", id, "Move left", "&larr;", x <= 0)}
        ${layoutToolButtonHtml("right", id, "Move right", "&rarr;", x + width >= 12)}
        ${layoutToolButtonHtml("up", id, "Move up", "&uarr;", y <= 0)}
        ${layoutToolButtonHtml("down", id, "Move down", "&darr;", false)}
      </div>
      <div class="tl-layout-tool-group tl-analysis-grid-control">
        ${layoutToolButtonHtml("narrower", id, "Narrower", "&minus;", width <= limits.minWidth)}
        <span class="tl-layout-size" title="Width × height in grid units">${width} × ${height}</span>
        ${layoutToolButtonHtml("wider", id, "Wider", "+", width >= limits.maxWidth)}
      </div>
      <div class="tl-layout-tool-group tl-analysis-mobile-reorder-group">
        <button type="button" class="plain-button compact-button tl-analysis-mobile-reorder" data-action="training-load-analysis-widget-mobile-up" data-widget-id="${escapeAttr(id)}" ${position.index <= 0 ? "disabled" : ""}>Move up</button>
        <button type="button" class="plain-button compact-button tl-analysis-mobile-reorder" data-action="training-load-analysis-widget-mobile-down" data-widget-id="${escapeAttr(id)}" ${position.index >= position.total - 1 ? "disabled" : ""}>Move down</button>
      </div>
    </div>
  `;
}

// H2: the widget "⋯" menu - on every widget of an editable dashboard, in
// and out of layout mode (before H2 a widget's Settings were only reachable
// from inside layout mode). While a layout draft is unsaved, Settings/
// Advanced/Delete are disabled: each of them reloads the dashboard on
// success, which would silently drop the draft.
function renderWidgetMenuHtml(widget) {
  const a = state.trainingLoad.analysis;
  if (!canEdit()) return "";
  const menuKey = `widget:${widget.id}`;
  const open = a.menu === menuKey;
  const blocked = Boolean(a.editMode && a.layoutDraft) || pageBusy();
  const dataset = { "widget-id": widget.id };
  return `
    <div class="tl-popover-anchor tl-widget-menu-anchor ${open ? "is-open" : ""}">
      <button type="button" class="plain-button icon-button tl-menu-trigger tl-widget-menu-trigger ${open ? "is-open" : ""}" data-action="training-load-analysis-open-menu" data-menu="${escapeAttr(menuKey)}" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}" aria-label="${escapeAttr(`Widget actions: ${widget.title}`)}" title="Widget actions"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>
      ${open ? `
        ${popoverBackdropHtml()}
        <div class="tl-popover tl-menu tl-popover-align-end" role="menu" tabindex="-1" aria-label="${escapeAttr(`Actions for ${widget.title}`)}">
          ${blocked ? `<p class="tl-menu-note" role="note">${pageBusy() ? (a.pagePending ? "Check the pending page update before editing widgets." : "Wait until this page finishes updating.") : "Save or cancel the layout changes first."}</p>` : ""}
          ${menuItemHtml({ action: "training-load-analysis-edit-widget", label: "Settings", dataset, disabled: blocked || a.saving })}
          ${menuItemHtml({ action: "training-load-analysis-open-advanced", label: "Advanced settings", dataset, disabled: blocked || a.saving })}
          ${a.referencesAvailable && ["line_chart","bar_chart"].includes(widget.widget_type) ? menuItemHtml({ action: "training-load-reference-open", label: "References and Radar", dataset, disabled: blocked || a.saving }) : ""}
          ${a.pagesAvailable ? menuItemHtml({ action: "training-load-pages-open-copy", label: "Copy to page", dataset, disabled: blocked || a.saving }) : ""}
          ${a.editMode ? "" : menuItemHtml({ action: "training-load-analysis-toggle-edit", label: "Edit layout", disabled: pageBusy() })}
          <div class="tl-menu-separator" role="separator"></div>
          ${menuItemHtml({ action: "training-load-analysis-delete-widget", label: "Delete widget", dataset, danger: true, disabled: blocked || a.saving })}
        </div>
      ` : ""}
    </div>
  `;
}

function seriesLabel(series) {
  if (series.display_label) return series.display_label;
  if (series.built_in_series_key) return BUILT_IN_SERIES.find((b) => b.key === series.built_in_series_key)?.label || series.built_in_series_key;
  // A catalog metric's own name. The catalog is loaded alongside a dashboard
  // that has such series (loadDashboardDetail); until it arrives the label
  // says what kind of series it is instead of a generic "Metric".
  if (series.metric_definition_id) {
    const def = (state.trainingLoad.analysis.metricPicker.definitions || []).find((d) => d.id === series.metric_definition_id);
    return def?.label || "Catalog metric";
  }
  const hint = series.template_metric_key_hints?.[0];
  return hint?.key || "Choose a metric";
}

function displayStatusLabel(status, reasons = []) {
  for (const reason of reasons) if (calculationErrors[reason]) return calculationErrors[reason];
  if (status === "loading") return "Loading...";
  if (status === "unresolved") return "Choose a metric";
  if (status === "ambiguous") return "Ambiguous metric";
  if (status === "multipleGroups") return "Multiple groups — narrow the selection or use a table.";
  if (status === "missing" || status === "empty") return "No data";
  if (status === "unsupported") return "This result is not a single numeric value. Use a table.";
  if (status === "conflict") {
    const names = { conflict: "Conflict", unitConflict: "Unit conflict", typeConflict: "Type conflict", semanticConflict: "Semantic conflict" };
    return reasons.filter(reason => names[reason]).map(reason => names[reason]).join(" / ") || "Conflict";
  }
  // Roles V-6: a per-athlete widget in a workspace without load.view.athlete (the server never queried it).
  if (reasons.includes("namedAthletesRequired")) return "This widget shows each athlete's values, which you can't see here.";
  if (reasons.includes("seriesQueryFailed")) return "This series could not be loaded. Try refreshing the dashboard.";
  if (reasons.includes("duplicateBucket")) return "Multiple values for this group. Use a table.";
  return "Invalid or unavailable result";
}

function renderDisplayStatusHtml(status, reasons) {
  return `<div class="tl-analysis-status is-${status === "error" ? "error" : status === "conflict" ? "conflict" : "unresolved"}" role="status">${escapeHtml(displayStatusLabel(status, reasons))}</div>`;
}

function renderKpiHtml(model) {
  if (!model.series.length) return `<p class="muted">Add a series to show this KPI.</p>`;
  const kpi = model.kpi;
  if (kpi.status !== "value") return renderDisplayStatusHtml(kpi.status, kpi.row?.reasons || kpi.reasons);
  const row = kpi.row;
  return `
    <div class="tl-analysis-kpi">
      <span class="tl-analysis-kpi-value">${escapeHtml(formatValue(row.value, model))}</span>
      <span class="tl-analysis-kpi-label">${escapeHtml(seriesLabel(model.series[0].definition))}${row.identity.unit ? ` · ${escapeHtml(row.identity.unit)}` : ""}</span>
      ${safeAthleteName(row.identity.athleteId) ? `<span class="tl-analysis-kpi-context">${escapeHtml(safeAthleteName(row.identity.athleteId))}</span>` : ""}
      ${kpi.comparison.status === "value" ? `<span class="tl-analysis-kpi-compare">Compare ${escapeHtml(formatValue(kpi.comparison.row.value, model))}</span>` : ""}
      ${["incompatible", "error"].includes(kpi.comparison.status) ? `<span class="tl-analysis-status is-unresolved">Comparison unavailable: results are not unambiguous and compatible.</span>` : ""}
    </div>
  `;
}

const uuidPattern = /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i;
function safeAthleteName(id) {
  if (!id) return "";
  const name = state.trainingLoad.orgPickerData?.athletes?.find(athlete => String(athlete.id).toLowerCase() === String(id).toLowerCase())?.name;
  return name && !uuidPattern.test(name) ? name : "Athlete name unavailable";
}
function safeTableValue(value, model) {
  return value !== null && typeof value === "object" || uuidPattern.test(String(value)) ? "Unavailable" : formatValue(value, model);
}
function renderTableHtml(model, groupLabels = dashboardGroupLabels(model)) {
  if (!model.series.length) return `<p class="muted">Add series to build a table.</p>`;
  return `
    <div class="tl-analysis-table-wrap" role="region" aria-label="${escapeAttr(model.title || "Metric")} values" tabindex="0">
      <table class="tl-analysis-table">
        <caption>Current period values</caption>
        <thead><tr><th scope="col">Series</th><th scope="col">Bucket</th><th scope="col">Value</th><th scope="col">Unit</th><th scope="col">Status</th></tr></thead>
        <tbody>
          ${model.series.map((series) => {
            const reportedLabel = seriesLabel(series.definition);
            const label = uuidPattern.test(reportedLabel) ? "Metric" : reportedLabel;
            if (series.status !== "ready") return `<tr><td>${escapeHtml(label)}</td><td colspan="4">${renderDisplayStatusHtml(series.status, series.reasons)}</td></tr>`;
            const rows = series.current;
            if (!rows.length) return `<tr><td>${escapeHtml(label)}</td><td colspan="4" class="muted">No data</td></tr>`;
            return rows.map((row) => `
              <tr>
                <td>${escapeHtml(label)}</td>
                <td>${escapeHtml([groupLabels.get(row.identity.bucketKey ?? ""), safeAthleteName(row.identity.athleteId)].filter(Boolean).join(" · "))}</td>
                <td>${row.status === "value" ? escapeHtml(safeTableValue(row.value, model)) : "-"}</td>
                <td>${escapeHtml(uuidPattern.test(String(row.identity.unit)) ? "" : row.identity.unit || "")}</td>
                <td>${row.status === "value" ? "" : escapeHtml(displayStatusLabel(row.status, row.reasons))}</td>
              </tr>
            `).join("");
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderChartHtml(model) {
  const groupLabels = dashboardGroupLabels(model);
  if (!model.series.length) return `<p class="muted">Add a series to draw the chart.</p>`;
  const diagnostics = model.series.flatMap(series => series.current.filter(row => row.chartStatus !== "value").map(row => renderDisplayStatusHtml(row.chartStatus, row.reasons)));
  return `
    ${renderDashboardChartPlots(model, seriesLabel, row => safeAthleteName(row.identity.athleteId), groupLabels)}
    ${diagnostics.join("")}
    <details class="tl-analysis-chart-values" data-dashboard-disclosure="values" data-widget-id="${escapeAttr(model.widgetId)}" ${dashboardDisclosureOpen(model.widgetId,'values')?'open':''}>
      <summary>Values and status</summary>
      ${renderTableHtml(model, groupLabels)}
    </details>
  `;
}

function renderWidgetBodyHtml(widget, results, previewPeriod = null) {
  if(widget.presentation_config?.schemaVersion===1&&widget.presentation_config.referenceConfig) return `<div data-reference-island="chart" data-widget-id="${escapeAttr(widget.id)}"></div>`;
  const analysis = state.trainingLoad.analysis;
  const querySkipped = analysis.queryResult === null && (analysis.dashboard?.is_template || analysis.dashboard?.status === "archived");
  const catalog = state.trainingLoad.analysis.metricPicker.definitions ?? [];
  const displayWidget = { ...widget, series: widget.series.map(series => { const definition = catalog.find(d => d.id === series.metric_definition_id); return { ...series, ...(definition ? { calculation: definition.calculation } : {}) }; }) };
  const model = buildDashboardWidgetDisplayModel(displayWidget, results, { loading: !previewPeriod && analysis.queryLoading, querySkipped: !previewPeriod && querySkipped, error: previewPeriod ? null : analysis.queryError, period: previewPeriod ?? analysis.period });
  model.interactionGeneration=analysisChartInteractionGeneration();
  if (model.status === "unsupported") return `<p class="builder-error" role="alert">Unsupported display configuration version.</p>`;
  if (model.config.status !== "ready") return `<p class="builder-error" role="alert">Invalid display configuration.</p>`;
  if (model.status === "loading") return `<p class="muted tl-analysis-loading" aria-live="polite">Loading...</p>`;
  if (model.status === "error") return renderDisplayStatusHtml("error", model.reasons);
  if (model.status === "restricted") return renderDisplayStatusHtml("restricted", model.reasons);
  const definitions = state.trainingLoad.analysis.metricPicker.definitions ?? [];
  const unavailable = widget.series.some(series => definitions.find(d => d.id === series.metric_definition_id)?.calculation?.inputs?.some(input => input.definitionId === null));
  if (unavailable) return '<p role="status">An input you cannot see is needed. Choose another metric.</p>';
  const ratioNotes = model.series.map(series => (series.calculation && !definitions.find(d => d.id === series.definition.metric_definition_id)?.calculated ? renderCalculationFormula({ calculation: series.calculation }) : '') + renderRatioCoverage(series, series.definition.data_scope_level)).join('');
  if (model.series.length === 1 && model.series[0].calculation?.kind === 'ratio' && model.series[0].coverage?.includedOccasions === 0 && !model.series[0].current.length) return ratioNotes + calculatedNoteHtml(widget);
  if (widget.widget_type === "kpi") return renderKpiHtml(model) + calculatedNoteHtml(widget) + ratioNotes;
  if (widget.widget_type === "table") {
    if (model.series.length === 1 && model.series[0].status === "ready" && ["day", "athlete"].includes(model.groupBy)) {
      return renderDashboardMetricTable(model, state.trainingLoad.orgPickerData?.athletes ?? [], seriesLabel(model.series[0].definition)) + calculatedNoteHtml(widget) + ratioNotes;
    }
    const pivot = renderDashboardPivotTable(model, state.trainingLoad.orgPickerData?.athletes ?? [], series => {
      const label = seriesLabel(series);
      const metric = definitions.find(def => def.id === series.metric_definition_id);
      const builtin = BUILT_IN_SERIES.find(def => def.key === series.built_in_series_key);
      const letter = builtin?.icon ?? (metric?.shortLabel || metric?.label || label || "?").slice(0, 1);
      const fallback = `<span class="tl-metric-icon-fallback" aria-hidden="true">${escapeHtml(uuidPattern.test(label) ? "?" : letter)}</span> `;
      const icon = renderMetricIconHtml(metric?.iconUrl, { className: "tl-metric-icon", fallback });
      return { label, icon, unit: metric?.unit ?? builtin?.unit };
    });
    return (pivot ?? renderTableHtml(model)) + calculatedNoteHtml(widget) + ratioNotes;
  }
  return renderChartHtml(model) + calculatedNoteHtml(widget) + ratioNotes;
}

// J21: a widget that shows a calculated variable says from when it has values, so an earlier period with none is never an
// unexplained blank (the Rukovodilac's condition of 2026-11-19). From the catalog's own flag; nothing else changes.
function calculatedNoteHtml(widget) {
  const definitions = state.trainingLoad.analysis.metricPicker.definitions || [];
  const names = (widget.series || [])
    .map((series) => series.metric_definition_id && definitions.find((d) => d.id === series.metric_definition_id && d.calculated === true))
    .filter(Boolean).map((d) => d.label);
  if (!names.length) return "";
  return names.length ? `<p class="muted tl-calculated-note">${escapeHtml([...new Set(names)].join(", "))}: ${escapeHtml(CALCULATED_TEXT.fromNow)}</p>${widget.series.map(series => renderCalculationFormula(definitions.find(d => d.id === series.metric_definition_id))).join('')}` : "";
}

function renderWidgetHtml(widget, position) {
  const layout = layoutFor(widget);
  const results = resultByWidgetId(widget.id);
  const layoutMode = state.trainingLoad.analysis.editMode && canEdit();
  return `
    <article class="panel tl-analysis-widget tl-analysis-widget-${escapeAttr(widget.widget_type)}" data-analysis-widget-id="${escapeAttr(widget.id)}" style="--tl-x:${Number(layout.x || 0)};--tl-y:${Number(layout.y || 0)};--tl-w:${Number(layout.width || 4)};--tl-h:${Number(layout.height || 4)};--tl-mobile:${Number(layout.mobileOrder || 0)}">
      ${layoutMode ? `<button type="button" class="tl-analysis-widget-move" data-analysis-drag-handle="true" aria-label="Move widget" title="Move widget"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M8 7l4-4 4 4M16 17l-4 4-4-4M7 8l-4 4 4 4M17 16l4-4-4-4"/></svg></button>` : ""}
      ${renderWidgetMenuHtml(widget)}
      <header class="tl-analysis-widget-head ${layoutMode ? "is-draggable" : ""} ${canEdit() ? "has-menu" : ""}" data-analysis-drag-handle="${layoutMode ? "true" : "false"}">
        <div>
          <p class="eyebrow">${escapeHtml(widget.presentation_config?.referenceConfig?.mode === "radar" ? "Radar" : widget.widget_type.replace("_", " "))}</p>
          <h3>${escapeHtml(widget.title)}</h3>
        </div>
      </header>
      <div class="tl-analysis-widget-body" role="region" aria-label="${escapeAttr(widget.title || "Metric")} content" tabindex="0">${renderWidgetBodyHtml(widget, results)}</div>
      ${renderWidgetToolbarHtml(widget, layout, position)}
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
      ${canEdit() && !a.editMode ? `
        <div class="tl-analysis-layout-actions">
          <button type="button" class="plain-button compact-button tl-analysis-primary tl-analysis-add-widget-button" data-action="training-load-analysis-add-widget" ${pageBusy() ? "disabled" : ""}><svg class="tl-analysis-button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add widget</span></button>
          ${a.simplePreview&&a.pagesAvailable?`<button type="button" class="plain-button compact-button" data-action="training-load-analysis-add-gallery-widget" ${pageBusy()?"disabled":""}>Add from gallery</button>`:""}
        </div>
      ` : ""}
    </section>
    ${a.dashboard.is_template ? `
      <div class="tl-analysis-template-banner">
        ${!canCreateDashboard()
          ? `<p class="tl-analysis-status is-unresolved">This is a template. It shows data only once someone with editing rights uses it.</p>`
          : `<p class="tl-analysis-status is-unresolved">This is a template. Clone it before querying or editing it.</p>
        <button type="button" class="plain-button compact-button tl-analysis-primary" data-action="training-load-analysis-clone-template" data-template-id="${escapeAttr(a.dashboard.id)}">Use template</button>`}
      </div>
    ` : ""}
    ${a.dashboard.status === "archived" ? `<p class="tl-analysis-status is-unresolved">Archived dashboards are read-only.</p>` : ""}
    ${widgets.length
      ? `<div class="tl-analysis-grid">${widgets.map((w, index) => renderWidgetHtml(w, { index, total: widgets.length })).join("")}</div>`
      : `<section class="panel tl-analysis-empty">
          <h3>No metrics yet</h3>
          <p class="muted">${canEdit() ? "Pick a metric (RPE, sRPE, duration or any catalog metric), choose how to show it, and it appears here." : "This dashboard has no widgets."}</p>
          ${canEdit() ? `<div class="tl-analysis-empty-actions"><button type="button" class="plain-button tl-analysis-primary" data-action="training-load-analysis-add-widget" ${pageBusy() ? "disabled" : ""}>Add your first metric</button></div>` : ""}
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
  const definitions = pickable(picker.definitions, { chosen: [panel.metric?.id] }).filter((d) => !search || `${d.label} ${d.key} ${d.unit || ""} ${d.domainLabel || ""}`.toLowerCase().includes(search));
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
            ${renderMetricIconHtml(d.iconUrl, { fallback: `<span class="tl-metric-icon-fallback">${escapeHtml((d.shortLabel || d.label || "?").slice(0, 1))}</span>` })}
            <span><strong>${escapeHtml(pickerName(d, picker.definitions))}</strong><small>${escapeHtml([d.unit, d.valueType, d.categoryLabel].filter(Boolean).join(" · "))}</small></span>
          </button>`).join("")}
        </div>
      `).join("")}
      ${!builtIns.length && !groups.size && !picker.loading ? `<p class="muted">No metrics match "${escapeHtml(panel.search.trim())}".</p>` : ""}
    </div>
  `;
}

function renderPanelPreviewHtml(panel) {
  const available = state.trainingLoad.analysis.pagesAvailable && state.trainingLoad.analysis.selectedPageId;
  const preview = (panel.galleryDraft || panel.metric) && panel.preview?.body === metricPanelPreviewBody(panel) ? panel.preview : null;
  const reference = preview?.result?.references;
  const radar = reference && referenceChartModel(reference,preview.widget);
  const content = reference ? radar
    ? `<optimove-dashboard-chart data-chart="${escapeAttr(JSON.stringify(radar))}"><div class="tl-analysis-echarts"></div></optimove-dashboard-chart>`
    : `<p role="status">${escapeHtml(referenceReason(reference.axes?.find(axis=>axis.status!=="ready")?.reason??reference.reason))}</p>`
    : preview ? renderWidgetBodyHtml(preview.widget, preview.result, preview.resolvedPeriod) : "";
  return `<div class="tl-metric-panel-preview" aria-label="Widget preview" aria-busy="${Boolean(panel.previewLoading)}">
    <button type="button" class="plain-button compact-button" data-action="training-load-analysis-panel-preview" ${available && metricPanelCanPreview(panel) && !panel.previewLoading ? "" : "disabled"}>Load preview</button>
    ${panel.previewLoading ? '<p role="status">Loading preview…</p>' : ""}
    ${panel.previewError ? `<p role="alert">${escapeHtml(panel.previewError)}</p>` : ""}
    ${content || (!available ? '<p class="muted">Live preview is available on dashboard pages.</p>' : "")}
  </div>`;
}

function renderNewGallerySettings(panel, definitions) {
  const {kind,series,teamId,tableId,anchorKey,additive}=panel.galleryDraft;
  const preset=kind==="radar"&&tableId!==undefined;
  const distribution=["heatmap","boxplot"].includes(kind);
  const metrics=definitions.filter(def=>["numeric","number"].includes(def.valueType)&&!def.hiddenInClub
    && (kind!=="stacked"&&(kind!=="radar"||preset)||!def.calculation)
    && (!preset||!panel.galleryPreset||panel.galleryPreset.columns.some(col=>col.definition_id===def.id)));
  const builtin=kind==="radar"?[]:BUILT_IN_SERIES.filter(def=>def.key!=="last_session_date");
  const field=(name,index)=>`data-action="training-load-analysis-panel-gallery-field" data-field="${name}" data-index="${index}"`;
  const teamOptions=state.trainingLoad.references?.options?.teams??[];
  const tables=(state.trainingLoad.references?.tables??[]).filter(table=>table.published_version_id&&!table.archived);
  const flexible=["area","horizontal_bar","combined","stacked","radar"].includes(kind);
  const minimum=kind==="radar"?3:["stacked","combined"].includes(kind)?2:1;
  return `<fieldset class="tl-metric-panel-gallery-settings" ${panel.saving?"disabled":""}><legend>Measurements</legend>
    ${kind==="radar"?`<label>Reference source<select ${field("referenceMode",0)}>${optionHtml("preset","Published reference table",preset?"preset":"team")}${optionHtml("team","Team average",preset?"preset":"team")}</select></label>
      ${preset?`<label>Reference table<select ${field("tableId",0)}><option value="">Choose a published table</option>${tables.map(table=>optionHtml(table.id,table.name,tableId)).join("")}</select></label>
        ${!tables.length?'<p role="status">Publish a reference table before using it in Radar.</p>':""}
        ${panel.galleryPreset?`<label>100% reference<select ${field("anchorKey",0)}>${panel.galleryPreset.valueKinds.map(kind=>optionHtml(kind.key,kind.name,anchorKey)).join("")}</select></label>`:""}`
      :`<label>Reference team<select ${field("teamId",0)}><option value="">Choose a team</option>${teamOptions.map(team=>optionHtml(team.id,team.name,teamId)).join("")}</select></label>
        ${!teamOptions.length?'<p role="status">Radar requires an active team and access to dashboard references.</p>':""}`}`:""}
    ${series.map((row,index)=>{
      const definition=metrics.find(def=>def.id===row.metricDefinitionId);
      const fixed=BUILT_IN_FIXED_SCOPE[row.builtInSeriesKey];
      const scopes=fixed?[fixed]:definition?.scopeCapabilities?.length?definition.scopeCapabilities:SCOPE_LEVELS;
      return `<div class="tl-analysis-editor-grid">
        <label>${kind==="scatter"?["X axis","Y axis"][index]:`Measurement ${index+1}`}<select ${field("metricDefinitionId",index)}><option value="">Choose a metric</option>${builtin.map(def=>optionHtml(def.key,def.label,row.builtInSeriesKey)).join("")}${metrics.map(def=>optionHtml(def.id,def.label,row.metricDefinitionId)).join("")}</select></label>
        <label>Data level<select ${field("dataScopeLevel",index)}>${scopes.map(scope=>optionHtml(scope,SCOPE_LABELS[scope]??scope,row.dataScopeLevel)).join("")}</select></label>
        ${distribution?"<p>Uses each measurement.</p>":`<label>Calculate<select ${field("analyticalAggregation",index)}>${(definition?.allowedAggregations??AGGREGATIONS).filter(value=>value!=="none"&&(value!=="ratio"||definition?.calculation?.kind==="ratio")).map(value=>optionHtml(value,AGGREGATION_LABELS[value],row.analyticalAggregation)).join("")}</select></label>`}
        ${kind==="combined"?`<label>Mark<select ${field("mark",index)}>${["bar","line"].map(mark=>optionHtml(mark,mark,row.mark)).join("")}</select></label>
          <label>Axis<select ${field("axis",index)}>${["primary","secondary"].map(axis=>optionHtml(axis,AXIS_LABELS[axis],row.axis)).join("")}</select></label>`:""}
        ${flexible&&series.length>minimum?`<button type="button" class="plain-button compact-button" ${field("remove",index)}>Remove measurement ${index+1}</button>`:""}
      </div>`;
    }).join("")}
    ${kind==="stacked"?`<label><input type="checkbox" ${field("additive",0)} ${additive?"checked":""}> Measurements are separate parts of the same total</label>`:""}
    ${flexible&&series.length<8?`<button type="button" class="plain-button compact-button" ${field("append",0)}>Add measurement</button>`:""}
  </fieldset>`;
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
          <section class="tl-metric-panel-step tl-metric-panel-metric">
            <h4><span class="tl-metric-panel-step-no">1</span>Metric</h4>
            ${panel.metric ? `<p class="tl-metric-panel-chosen"><span class="tl-analysis-activity-chip"><strong>${escapeHtml(panel.metric.label)}</strong>${panel.metric.unit ? `<small>${escapeHtml(panel.metric.unit)}</small>` : ""}</span></p>` : ""}
            <label class="search-field"><span>Search metrics</span><input type="search" data-action="training-load-analysis-panel-search" data-tl-analysis-search="metric" value="${escapeAttr(panel.search)}" placeholder="Search metrics" autocomplete="off"></label>
            ${renderPanelMetricListHtml(panel)}
          </section>
          <section class="tl-metric-panel-step">
            <h4><span class="tl-metric-panel-step-no">2</span>View</h4>
            <div class="tl-analysis-widget-type-grid tl-metric-panel-types" aria-label="Widget display">
              ${WIDGET_TYPES.map((type) => {
                const active=!panel.galleryDraft&&panel.widgetType===type.key;
                return `<button type="button" class="plain-button tl-analysis-type-button ${active?"is-selected":""}" aria-pressed="${active}" data-action="training-load-analysis-panel-type" data-widget-type="${type.key}">${chartPickerIllustration(type.key)}<strong>${escapeHtml(type.label)}</strong><small>${escapeHtml(type.hint)}</small></button>`;
              }).join("")}
              ${[...GALLERY_CHOICES.filter(([key]) => key !== "standard"), ["radar", "Radar"]].map(([key, label]) => {
                const supported = !editing ? a.pagesAvailable : (key === "radar"
                  ? state.trainingLoad.analysis.referencesAvailable && ["line_chart", "bar_chart"].includes(panel.widgetType)
                  : state.trainingLoad.analysis.chartShapes);
                const active=panel.galleryDraft?.kind===key;
                return `<button type="button" class="plain-button tl-analysis-type-button ${active?"is-selected":""}" aria-pressed="${active}" data-action="training-load-analysis-panel-chart" data-chart-kind="${escapeAttr(key)}" ${supported ? "" : "disabled"}>${chartPickerIllustration(key)}<strong>${escapeHtml(label)}</strong></button>`;
              }).join("")}
            </div>
            ${editing ? `<div class="tl-metric-panel-advanced"><span class="muted">More chart types, axes, sources and series</span> <button type="button" class="plain-button compact-button" data-action="training-load-analysis-open-advanced" data-widget-id="${escapeAttr(panel.widgetId)}">Advanced settings</button></div>` : ""}
          </section>
          <section class="tl-metric-panel-step">
            <h4><span class="tl-metric-panel-step-no">3</span>Settings</h4>
            <div class="tl-analysis-editor-grid">
              <label>Title<input type="text" data-action="training-load-analysis-panel-title" value="${escapeAttr(panel.title)}" maxlength="200" placeholder="${escapeAttr(panel.metric?.label || "Widget title")}"></label>
              ${panel.galleryDraft?.kind==="radar"?"":`<label>Show<select data-action="training-load-analysis-panel-field" data-field="groupBy">${GROUP_BY.filter(g=>!["heatmap","boxplot"].includes(panel.galleryDraft?.kind)||["day","week"].includes(g)).map((g) => optionHtml(g, GROUP_BY_LABELS[g], panel.groupBy)).join("")}</select></label>`}
              ${panel.galleryDraft?"":`<label>Calculate<select data-action="training-load-analysis-panel-field" data-field="aggregation">${((state.trainingLoad.analysis.metricPicker.definitions ?? []).find(d => d.id === panel.metric?.id)?.allowedAggregations ?? AGGREGATIONS.filter(v => v !== "ratio")).map((v) => optionHtml(v, AGGREGATION_LABELS[v], panel.aggregation)).join("")}</select></label>
              ${renderScopeSelectHtml({ action: "training-load-analysis-panel-field", attrs: 'data-field="scope"', value: panel.scope, metric: panel.metric, label: "Data level" })}`}
            </div>
            ${panel.galleryDraft?renderNewGallerySettings(panel,a.metricPicker.definitions??[]):""}

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

// Dashboards UX H3: a built-in series' data level is fixed by the catalog
// (BUILT_IN_FIXED_SCOPE) - shown, never offered as a choice the server
// would refuse. Shared by the guided panel and the advanced editor.
function renderScopeSelectHtml({ action, attrs = "", value, metric, label }) {
  const fixed = metric?.kind === "builtin" ? BUILT_IN_FIXED_SCOPE[metric.key] : "";
  if (fixed) {
    return `<label>${escapeHtml(label)}<select data-action="${action}" ${attrs} disabled aria-describedby="tl-fixed-scope-note">${optionHtml(fixed, SCOPE_LABELS[fixed] || fixed, fixed)}</select><small class="muted" id="tl-fixed-scope-note">Fixed for this built-in metric.</small></label>`;
  }
  return `<label>${escapeHtml(label)}<select data-action="${action}" ${attrs}>${SCOPE_LEVELS.map((v) => optionHtml(v, SCOPE_LABELS[v], value)).join("")}</select></label>`;
}

function editorMetricLabel(metric, displayLabel = "") {
  if (displayLabel) return displayLabel;
  if (metric?.kind === "builtin") return BUILT_IN_SERIES.find((b) => b.key === metric.key)?.label || metric.key;
  if (metric?.kind === "metric") return (state.trainingLoad.analysis.metricPicker.definitions || []).find((d) => d.id === metric.id)?.label || "Catalog metric";
  return metric?.hints?.[0]?.key || "Choose a metric";
}

function renderMetricPickerHtml(entry, disabled = "") {
  const picker = state.trainingLoad.analysis.metricPicker;
  const search = picker.search.trim().toLowerCase();
  const definitions = pickable(picker.definitions, { chosen: [entry.metric?.kind === "metric" ? entry.metric.id : null] }).filter((d) => !search || `${d.label} ${d.key} ${d.unit || ""} ${d.domainLabel || ""}`.toLowerCase().includes(search));
  const groups = new Map();
  for (const d of definitions) {
    const key = d.domainLabel || d.categoryLabel || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const isBuiltIn = (key) => entry.metric?.kind === "builtin" && entry.metric.key === key;
  const isMetric = (id) => entry.metric?.kind === "metric" && entry.metric.id === id;
  const builtIns = BUILT_IN_SERIES.filter(b => !search || `${b.label} ${b.unit || ""}`.toLowerCase().includes(search));
  return `
    <div class="tl-analysis-metric-picker">
      <h4>${entry.metric ? "Change selected variable" : "Choose a variable"}</h4>
      <label class="search-field"><span>Search metrics</span><input type="search" data-action="training-load-analysis-metric-search" data-tl-analysis-search="advanced" value="${escapeAttr(picker.search)}" placeholder="Metric name or unit" ${disabled}></label>
      <div class="tl-editor-catalog-results">
      ${builtIns.length ? `<div class="tl-analysis-builtins">
        <p class="eyebrow">Built-in series</p>
        ${builtIns.map((b) => `<button type="button" class="plain-button compact-button ${isBuiltIn(b.key) ? "is-active" : ""}" aria-pressed="${isBuiltIn(b.key) ? "true" : "false"}" data-action="training-load-analysis-series-bind-builtin" data-series-key="${escapeAttr(entry.key)}" data-built-in-key="${escapeAttr(b.key)}" ${disabled}><span class="tl-metric-icon-fallback">${escapeHtml(b.icon)}</span>${escapeHtml(b.label)}${b.unit ? ` · ${escapeHtml(b.unit)}` : ""}</button>`).join("")}
      </div>` : ""}
      ${picker.loading ? `<p class="muted tl-analysis-loading" aria-live="polite">Loading metrics...</p>` : ""}
      ${picker.error ? `<p class="builder-error" role="alert">${escapeHtml(picker.error)}</p>` : ""}
      ${[...groups.entries()].map(([group, rows]) => `
        <div class="tl-analysis-metric-group">
          <p class="eyebrow">${escapeHtml(group)}</p>
          ${rows.map((d) => `<button type="button" class="tl-analysis-metric-option ${isMetric(d.id) ? "is-active" : ""}" aria-pressed="${isMetric(d.id) ? "true" : "false"}" data-action="training-load-analysis-series-bind-metric" data-series-key="${escapeAttr(entry.key)}" data-metric-id="${escapeAttr(d.id)}" ${disabled}>
            ${renderMetricIconHtml(d.iconUrl, { fallback: `<span class="tl-metric-icon-fallback">${escapeHtml((d.shortLabel || d.label || "?").slice(0, 1))}</span>` })}
            <span><strong>${escapeHtml(pickerName(d, picker.definitions))}</strong><small>${escapeHtml([d.unit, d.valueType, d.domainLabel, d.categoryLabel, (d.scopeCapabilities || []).join("/")].filter(Boolean).join(" · "))}</small></span>
          </button>`).join("")}
        </div>
      `).join("")}
      ${!builtIns.length && !groups.size && !picker.loading && !picker.error ? '<p class="muted" role="status">No variables match your search.</p>' : ""}
      </div>
    </div>
  `;
}

// Dashboards UX H3: the advanced editor renders editor.draft (staged); a
// state without a draft (not opened through openAnalysisWidgetEditor) shows
// the widget as saved.
function renderEditorHtml() {
  const a = state.trainingLoad.analysis;
  const editor = a.editor;
  if (!editor.open) return "";
  const widget = selectedWidget();
  if (!widget) return "";
  const draft = editor.draft || analysisEditorDraftFromWidget(widget);
  const entries = draft.series;
  const entry = entries.find((item) => item.key === editor.seriesKey) || entries[0] || null;
  const rowsById = new Map((widget.series || []).map((row) => [row.id, row]));
  const dirty = analysisEditorPlan(widget, draft).length > 0;
  const problem = dirty ? analysisEditorProblem(draft) : "";
  const cap = analysisSeriesLimit(draft.widgetType);
  const saving = Boolean(editor.saving);
  const off = saving ? "disabled" : "";
  const override = draft.localFilterOverride || {};
  const key = entry ? `data-series-key="${escapeAttr(entry.key)}"` : "";
  const table = draft.widgetType === "table";
  const typeIcon = chartPickerIllustration(draft.galleryKind && draft.galleryKind !== "standard" ? draft.galleryKind : draft.widgetType);
  const previewBody = analysisEditorPreviewBody(editor);
  const preview = previewBody && editor.preview?.body === previewBody ? editor.preview : null;
  const hasPagePreview = a.pagesAvailable && a.selectedPageId;
  const referenceWidget = Boolean(widget.presentation_config?.referenceConfig);
  const definitionFor = item => item.metric?.kind === "builtin"
    ? BUILT_IN_SERIES.find(metric => metric.key === item.metric.key)
    : a.metricPicker.definitions?.find(metric => metric.id === item.metric?.id);
  const isBuiltIn = entry?.metric?.kind === "builtin";
  // H4: the query engine reads built-in series without these three filters.
  const policyOff = saving || isBuiltIn ? "disabled" : "";
  const sourceChoices = isBuiltIn
    ? ["not_applicable"]
    : SOURCE_POLICIES.filter((v) => v !== "not_applicable" && (v !== "source_connection" || entry?.fields.sourcePolicy === "source_connection"));
  const status = (item) => {
    if (!item.metric) return "Choose a variable";
    const row = rowsById.get(item.id);
    if (row?.resolution_status === "ambiguous" && item.metric.kind === "hints") return "Ambiguous variable";
    return [definitionFor(item)?.unit, AGGREGATION_LABELS[item.fields.analyticalAggregation]].filter(Boolean).join(" · ");
  };
  return `
    <div class="builder-athlete-overlay">
      <button class="builder-athlete-backdrop" type="button" data-action="training-load-analysis-close-editor" aria-label="Close" ${off}></button>
      <section class="panel tl-analysis-modal tl-analysis-editor" role="dialog" aria-modal="true" aria-label="Widget settings">
        <div class="tl-overlay-head">
          <div><strong>Widget settings</strong><p class="muted">Nothing is saved until you choose Save changes.</p></div>
          <button type="button" class="plain-button icon-button" data-action="training-load-analysis-close-editor" aria-label="Close" ${off}>&times;</button>
        </div>
        <div class="tl-analysis-editor-grid">
          <label>Title<input type="text" data-action="training-load-analysis-widget-title" data-tl-editor-field="title" data-widget-id="${escapeAttr(widget.id)}" value="${escapeAttr(draft.title)}" maxlength="200" ${off}></label>
          <label><span class="tl-editor-type-label">${typeIcon} Display type</span><select data-action="training-load-analysis-widget-type" data-widget-id="${escapeAttr(widget.id)}" ${off}>${WIDGET_TYPES.map((t) => optionHtml(t.key, t.label, draft.widgetType)).join("")}</select></label>
          <label>${table ? "Table rows" : "Show per"}<select data-action="training-load-analysis-widget-group" data-widget-id="${escapeAttr(widget.id)}" ${off}>${GROUP_BY.map((g) => optionHtml(g, GROUP_BY_LABELS[g] || g, draft.groupBy)).join("")}</select></label>
          <div class="tl-analysis-control">
            <span>Activity override</span>
            ${override.activityId
              ? `<button type="button" class="plain-button compact-button" value="" data-action="training-load-analysis-widget-activity-filter" data-widget-id="${escapeAttr(widget.id)}" ${off}>Clear activity override</button>`
              : `<span class="muted">Uses dashboard/runtime filter</span>`}
          </div>
          <div class="tl-analysis-control">
            <span>Component override</span>
            ${override.componentId
              ? `<button type="button" class="plain-button compact-button" value="" data-action="training-load-analysis-widget-component-filter" data-widget-id="${escapeAttr(widget.id)}" ${off}>Clear component override</button>`
              : `<span class="muted">Uses dashboard/runtime filter</span>`}
          </div>
        </div>
        ${a.chartShapes&&['line_chart','bar_chart'].includes(draft.widgetType)?`<fieldset class="tl-gallery-editor"><legend>Chart gallery</legend>
          ${renderGalleryPicker(draft.galleryKind??'standard',GALLERY_CHOICES,'training-load-analysis-gallery-kind',saving)}
          ${draft.galleryKind&&draft.galleryKind!=='standard'?`<p>Choose the measurements used by this chart. Scatter uses the first as X and the second as Y.</p>${entries.map((e,i)=>`<label><input type="checkbox" data-action="training-load-analysis-gallery-series" data-series-key="${escapeAttr(e.key)}" ${!draft.galleryKeys||draft.galleryKeys.includes(e.key)?'checked':''} ${off}>${escapeHtml(e.metric?.label??'Measurement '+(i+1))}</label>${draft.galleryKind==='combined'?`<label>Mark<select data-action="training-load-analysis-gallery-mark" data-series-key="${escapeAttr(e.key)}" ${off}>${[['bar','Bar'],['line','Line']].map(([v,l])=>optionHtml(v,l,draft.galleryMarks?.[e.key]??(i===entries.length-1?'line':'bar'))).join('')}</select></label>`:''}`).join('')}`:''}
          ${draft.galleryKind==='stacked'?`<label><input type="checkbox" data-action="training-load-analysis-gallery-additive" ${draft.galleryAdditive?'checked':''} ${off}>These measurements are separate additive components of one total.</label>`:''}
          ${['heatmap','boxplot'].includes(draft.galleryKind)?'<p>Use Each measurement to keep separate athlete values. Conflicting or repeated athlete/date values are left out.</p>':''}
        </fieldset>`:''}
        <div class="tl-editor-variable-workspace">
        <div class="tl-analysis-series-editor">
          <div class="tl-analysis-series-head">
            <h4>${table ? "Table columns" : "Variables"} <small class="muted">${entries.length} / ${cap}</small></h4>
            <button type="button" class="plain-button compact-button" data-action="training-load-analysis-add-series" data-choose-metric="true" data-widget-id="${escapeAttr(widget.id)}" ${saving || entries.length >= cap ? "disabled" : ""}>+ Add variable</button>
          </div>
          <div class="tl-analysis-series-list">
            ${entries.map((item, index) => {
              const label = editorMetricLabel(item.metric, item.fields.displayLabel || "");
              const metric = definitionFor(item);
              const itemKey = `data-series-key="${escapeAttr(item.key)}"`;
              return `<div class="tl-editor-variable-row">
                <button type="button" class="tl-analysis-series-row ${entry?.key === item.key ? "is-active" : ""}" aria-pressed="${entry?.key === item.key}" data-action="training-load-analysis-select-series" ${itemKey} ${off}>
                  ${renderMetricIconHtml(metric?.iconUrl, { fallback: `<span class="tl-metric-icon-fallback" aria-hidden="true">${escapeHtml(metric?.icon || label[0] || "?")}</span>` })}
                  <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(status(item))}</small></span>
                </button>
                <button type="button" class="plain-button icon-button" data-action="training-load-analysis-series-up" ${itemKey} aria-label="Move up: ${escapeAttr(label)}" ${saving || index === 0 ? "disabled" : ""}>&uarr;</button>
                <button type="button" class="plain-button icon-button" data-action="training-load-analysis-series-down" ${itemKey} aria-label="Move down: ${escapeAttr(label)}" ${saving || index === entries.length - 1 ? "disabled" : ""}>&darr;</button>
                <button type="button" class="plain-button icon-button tl-editor-remove-variable" data-action="training-load-analysis-delete-series" ${itemKey} aria-label="Remove variable: ${escapeAttr(label)}" title="Remove variable" ${off}>&times;</button>
              </div>`;
            }).join("") || `<p class="muted">Add a variable to show data.</p>`}
          </div>
          ${entry?.metric ? `
            <div class="tl-analysis-editor-grid">
              <label>${table ? "Column name" : "Label"}<input type="text" data-action="training-load-analysis-series-label" data-tl-editor-field="label" ${key} value="${escapeAttr(entry.fields.displayLabel || "")}" maxlength="200" placeholder="${escapeAttr(editorMetricLabel(entry.metric))}" ${off}></label>
              ${table ? "" : `<label>Axis<select data-action="training-load-analysis-series-axis" ${key} ${off}>${["primary", "secondary"].map((v) => optionHtml(v, AXIS_LABELS[v], entry.fields.axis || "primary")).join("")}</select></label>
              <label>Color<input type="color" data-action="training-load-analysis-series-color" ${key} value="${escapeAttr(entry.fields.color || "#0f766e")}" ${off}></label>`}
              ${saving ? `<label>Data level<select disabled>${optionHtml(entry.fields.dataScopeLevel, SCOPE_LABELS[entry.fields.dataScopeLevel] || entry.fields.dataScopeLevel, entry.fields.dataScopeLevel)}</select></label>` : renderScopeSelectHtml({ action: "training-load-analysis-series-scope", attrs: key, value: entry.fields.dataScopeLevel, metric: entry.metric, label: "Data level" })}
              <label>Calculate<select data-action="training-load-analysis-series-aggregation" ${key} ${off}>${((state.trainingLoad.analysis.metricPicker.definitions ?? []).find(d => d.id === entry.metric?.id)?.allowedAggregations ?? AGGREGATIONS.filter(v => v !== "ratio")).map((v) => optionHtml(v, AGGREGATION_LABELS[v], entry.fields.analyticalAggregation)).join("")}</select></label>
              ${analysisWidgetSupportsComparison(draft.widgetType) ? `<label>Comparison<select data-action="training-load-analysis-series-comparison" ${key} ${off}>${COMPARISONS.map((v) => optionHtml(v, COMPARISON_LABELS[v], entry.fields.comparisonPeriod || "")).join("")}</select></label>` : ""}
            </div>
            <details class="tl-editor-data-options" data-editor-data-options>
              <summary>Source and coverage</summary>
              <div class="tl-analysis-editor-grid">
              <label class="tl-editor-wide">Source<select data-action="training-load-analysis-series-source" ${key} ${policyOff}>${sourceChoices.map((v) => optionHtml(v, SOURCE_LABELS[v], entry.fields.sourcePolicy)).join("")}</select></label>
              <label class="tl-editor-wide">Values included<select data-action="training-load-analysis-series-role" ${key} ${policyOff}>${ROLE_POLICIES.map((v) => optionHtml(v, ROLE_POLICY_LABELS[v], entry.fields.aggregationRolePolicy)).join("")}</select></label>
              <label class="tl-editor-wide">Total coverage<select data-action="training-load-analysis-series-coverage" ${key} ${policyOff}>${COVERAGE_POLICIES.map((v) => optionHtml(v, COVERAGE_LABELS[v], entry.fields.coveragePolicy)).join("")}</select></label>
              <p class="muted tl-editor-help">${isBuiltIn
                ? "Source, values included and total coverage don't apply to built-in metrics."
                : "Direct value: recorded as it is, not a total. Source total: a total reported by the device or system itself. Calculated total: a total computed afterwards from other values. Partial total: some parts are missing, for example after a device dropout. Direct values are kept by every total coverage choice. If two values remain for the same athlete and session, component or day, the widget shows a conflict instead of adding them up. An estimate, a value a coach estimated for an athlete with no recording, is left out of every source except Estimates only."}</p>
            </div>
            </details>
          ` : ""}
        </div>
        ${entry ? renderMetricPickerHtml(entry, off) : ""}
        </div>
        ${hasPagePreview ? `<section class="tl-metric-panel-preview tl-advanced-preview" aria-label="Widget preview" tabindex="-1" aria-busy="${Boolean(editor.previewLoading)}">
          <div class="tl-analysis-series-head">
            <h4>Preview</h4>
            ${referenceWidget ? "" : `<button type="button" class="plain-button compact-button" data-action="training-load-analysis-editor-preview" ${analysisEditorCanPreview(editor) ? "" : "disabled"}>Load preview</button>`}
          </div>
          ${referenceWidget ? '<p class="muted">Preview reference comparisons in References and Radar.</p>' : ""}
          ${editor.previewLoading ? '<p role="status">Loading preview…</p>' : ""}
          ${editor.previewError ? `<p role="alert">${escapeHtml(editor.previewError)}</p>` : ""}
          ${preview ? renderWidgetBodyHtml(preview.widget, preview.result, preview.resolvedPeriod) : ""}
        </section>` : ""}
        <div class="tl-analysis-modal-actions tl-editor-footer">
          ${editor.error ? `<p class="builder-error" role="alert">${escapeHtml(editor.error)}</p>` : problem ? `<p class="builder-error" role="alert">${escapeHtml(problem)}</p>` : ""}
          ${editor.serverChanged ? `<p class="muted tl-editor-server-note">Some changes are already saved - closing keeps them.</p>` : ""}
          <div class="tl-editor-footer-row">
            <span class="tl-editor-status ${dirty ? "is-dirty" : ""}" aria-live="polite">${saving ? "Saving..." : dirty ? "Unsaved changes" : "No changes"}</span>
            <button type="button" class="plain-button compact-button" data-action="training-load-analysis-close-editor" ${off}>${editor.serverChanged ? "Close" : "Cancel"}</button>
            <button type="button" class="plain-button compact-button tl-analysis-primary" data-action="training-load-analysis-editor-save" ${saving || problem ? "disabled" : ""}>${saving ? "Saving..." : "Save changes"}</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

export function renderTrainingLoadAnalysisHtml() {
  const a = state.trainingLoad.analysis;
  return `
    <div class="tl-analysis">
      <div${a.simpleEditor?.open || a.referenceEditorOpen ? ' inert' : ''}>
      ${renderTopBarHtml()}
      ${renderDashboardPages()}
      ${a.simpleWorkspaceRequired ? '<p role="status">This club dashboard is outside your active workspace, so open a platform dashboard to use Simple.</p>' : ""}
      ${a.notice ? `<p class="tl-analysis-status" aria-live="polite">${escapeHtml(a.notice)}</p>` : ""}
      ${a.mutationError ? `<p class="builder-error" role="alert">${escapeHtml(a.mutationError)}</p>` : ""}
      ${a.listError ? `<p class="builder-error" role="alert">${escapeHtml(a.listError)}</p>` : ""}
      ${renderGridHtml()}
      ${renderDashboardFormHtml()}
      ${renderMetricPanelHtml()}
      ${renderEditorHtml()}
      </div>
      <div data-reference-island="binding"></div>
      ${renderSimpleEditorHtml(a.simpleEditor, state.currentUser?.activeWorkspace?.type === "platform")}
    </div>
  `;
}

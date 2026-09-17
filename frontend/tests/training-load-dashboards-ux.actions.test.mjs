// Dashboards UX H1 (feature/training-load-dashboards-ux-h1): the new
// dashboard picker (search + grouped list) replacing the bare <select>, the
// "New dashboard"/"Rename" dialog replacing window.prompt, the popover
// menus (dashboard actions, period presets), and the guided "Add metric"
// panel whose edits are STAGED client-side until Save - Cancel never
// writes, Save chains the EXISTING widget/series endpoints and then the one
// batch query. Layout/series/persistence contracts that predate this slice
// stay covered by training-load-analysis.actions.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

let queried = {};
globalThis.document = {
  querySelector: (sel) => queried[sel] || null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  body: { classList: { contains: () => false } },
};
// window.prompt must never be reached again by the Dashboards flow.
globalThis.window = {
  confirm: () => true,
  prompt: () => { throw new Error("window.prompt must not be used by Dashboards"); },
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  removeEventListener() {},
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

const { closeTrainingLoadAnalysisOverlay, handleTrainingLoadAction, setTrainingLoadAnalysisSearch } = await import("../training-load-actions.js");
const { ANALYSIS_PERIOD_PRESETS, analysisPeriodPresetKey, ensureAnalysisPeriod, loadTrainingLoadAnalysis, metricPanelCanSave } = await import("../training-load-analysis-data.js");
const { dashboardPickerGroups, renderTrainingLoadAnalysisHtml } = await import("../training-load-analysis-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");

const dashboardId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const templateId = "33333333-3333-4333-8333-333333333333";
const archivedId = "44444444-4444-4444-8444-444444444444";
const widgetId = "55555555-5555-4555-8555-555555555555";
const newWidgetId = "66666666-6666-4666-8666-666666666666";
const seriesId = "77777777-7777-4777-8777-777777777777";
const metricId = "88888888-8888-4888-8888-888888888888";

function resetState() {
  clearAllViewCache();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "private_coach", scopeId: "coach-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  state.trainingLoad.section = "analysis";
  state.athletes = [];
  queried = {};
}
function fakeAction(dataset, value = "") { return { dataset, value }; }
function renderTrainingLoad() {}

function dashboard(overrides = {}) {
  return { id: dashboardId, name: "Load board", description: "Team readiness", owner_scope: "user", status: "active", is_template: false, revision: 3, default_filter: null, updated_at: "2026-09-10T10:00:00.000Z", ...overrides };
}
function series(overrides = {}) {
  return { id: seriesId, series_order: 1, built_in_series_key: "rpe", metric_definition_id: null, display_label: null, axis: "primary", data_scope_level: "session", analytical_aggregation: "avg", source_policy: "not_applicable", aggregation_role_policy: "standalone_only", coverage_policy: "complete_only", comparison_period: null, resolution_status: "resolved", ...overrides };
}
function widget(overrides = {}) {
  return { id: widgetId, widget_type: "kpi", title: "Average RPE", widget_order: 1, x: 0, y: 0, width: 3, height: 3, mobile_order: 1, group_by: "day", state: "ready", display_config: { schemaVersion: 1 }, local_filter_override: null, revision: 4, series: [series()], ...overrides };
}
function allDashboards() {
  return [
    dashboard(),
    dashboard({ id: otherId, name: "Sprint board", description: "", owner_scope: "club", updated_at: "2026-09-08T10:00:00.000Z" }),
    dashboard({ id: templateId, name: "Weekly template", is_template: true, owner_scope: "system" }),
    dashboard({ id: archivedId, name: "Old board", status: "archived" }),
  ];
}
function responder({ widgets = [widget()], extra = () => null } = {}) {
  return (call) => {
    const handled = extra(call);
    if (handled) return handled;
    if (call.url.startsWith("/api/training-load/dashboards?")) return { status: 200, body: { dashboards: allDashboards() } };
    if (call.url === "/api/training-load/dashboards/active") return { status: 200, body: { activeDashboard: { dashboard_id: dashboardId } } };
    if (call.url === `/api/training-load/dashboards/${dashboardId}` && call.method === "GET") return { status: 200, body: { dashboard: dashboard(), widgets } };
    if (call.url === `/api/training-load/dashboards/${otherId}` && call.method === "GET") return { status: 200, body: { dashboard: dashboard({ id: otherId, name: "Sprint board" }), widgets: [] } };
    if (call.url.endsWith("/query")) return { status: 200, body: { dashboardRevision: 3, widgets: [] } };
    if (call.url.startsWith("/api/training-load/metrics/definitions")) return { status: 200, body: { rows: [{ id: metricId, key: "jump_height", label: "Jump height", short_label: "JH", unit: "cm", value_type: "number", scope_capabilities: ["session"] }], nextCursor: null } };
    if (call.url.startsWith("/api/training-load/metrics/")) return { status: 200, body: { rows: [] } };
    return { status: 404, body: { error: "notFound" } };
  };
}
function loadedDashboard() {
  const a = state.trainingLoad.analysis;
  a.dashboards = allDashboards();
  a.activeDashboardId = dashboardId;
  a.selectedDashboardId = dashboardId;
  a.dashboard = dashboard();
  a.widgets = [widget()];
  ensureAnalysisPeriod();
}
const writes = () => fetchCalls.filter((c) => c.method !== "GET" && !c.url.endsWith("/query"));

// -------------------- Dashboard picker --------------------

test("the picker replaces the <select>: a named trigger, grouped options with badges, archived dashboards requested and listed, and no old select/prompt actions left", async () => {
  resetState();
  installFetchMock(responder());
  await loadTrainingLoadAnalysis(renderTrainingLoad);
  assert.match(fetchCalls[0].url, /includeArchived=true/, "the list asks for archived dashboards (existing query flag)");

  let html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /data-action="training-load-analysis-open-picker"[^>]*aria-expanded="false"/);
  assert.match(html, /<strong>Load board<\/strong>/, "the trigger names the selected dashboard");
  assert.doesNotMatch(html, /<select data-action="training-load-analysis-select-dashboard"/);
  assert.doesNotMatch(html, /training-load-analysis-create"|training-load-analysis-focus-selector|training-load-analysis-create-widget|training-load-analysis-edit-dashboard/);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-open-picker" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.picker.open, true);
  html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /role="listbox"/);
  assert.match(html, /data-tl-analysis-search="picker"/);
  const groupLabels = [...html.matchAll(/class="tl-dash-picker-group" role="group" aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groupLabels, ["My dashboards", "Club &amp; team", "Templates", "Archived"], "no 'Recent' group with only two live dashboards");
  assert.match(html, /data-dashboard-id="11111111-1111-4111-8111-111111111111"[^>]*>[\s\S]*?Active/);
  assert.match(html, /Old board[\s\S]*?Archived/);
  assert.match(html, /aria-selected="true"[^>]*data-dashboard-id="11111111-1111-4111-8111-111111111111"/);
  assert.match(html, /data-action="training-load-analysis-new-dashboard"/);
});

test("dashboardPickerGroups: 'Recent' is the first three live dashboards and disappears while searching; search matches name or description", () => {
  const many = [1, 2, 3, 4, 5].map((n) => dashboard({ id: `d${n}`, name: `Board ${n}`, description: n === 5 ? "readiness check" : "" }));
  const groups = dashboardPickerGroups([...many, dashboard({ id: templateId, name: "Tpl", is_template: true })], "");
  assert.equal(groups[0].label, "Recent");
  assert.deepEqual(groups[0].rows.map((d) => d.id), ["d1", "d2", "d3"]);
  const searched = dashboardPickerGroups(many, "readiness");
  assert.deepEqual(searched.map((g) => g.label), ["My dashboards"]);
  assert.deepEqual(searched[0].rows.map((d) => d.id), ["d5"]);
  assert.deepEqual(dashboardPickerGroups(many, "nothing-like-this"), []);
});

test("typing in the picker search filters live (per keystroke via setTrainingLoadAnalysisSearch) and picking an option closes the picker, clears the search and loads + queries that dashboard", async () => {
  resetState();
  loadedDashboard();
  installFetchMock(responder());
  state.trainingLoad.analysis.picker.open = true;
  setTrainingLoadAnalysisSearch("picker", "sprint");
  let html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /Sprint board/);
  assert.doesNotMatch(html, /Weekly template/);
  assert.match(html, /value="sprint"/, "the search box keeps what was typed across the re-render");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-select-dashboard", dashboardId: otherId }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.picker.open, false);
  assert.equal(state.trainingLoad.analysis.picker.search, "");
  assert.equal(state.trainingLoad.analysis.selectedDashboardId, otherId);
  assert.equal(state.trainingLoad.analysis.dashboard.name, "Sprint board");
  assert.ok(fetchCalls.some((c) => c.url === `/api/training-load/dashboards/${otherId}/query`));
  html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /<strong>Sprint board<\/strong>/);
});

test("the empty state offers New dashboard + Choose dashboard (the picker), not the old Create/focus actions", () => {
  resetState();
  state.trainingLoad.analysis.dashboards = allDashboards();
  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /No dashboard selected/);
  assert.match(html, /data-action="training-load-analysis-new-dashboard"/);
  assert.match(html, /tl-analysis-empty-actions[\s\S]*data-action="training-load-analysis-open-picker"/);
});

// -------------------- Popover menus --------------------

test("one popover at a time: opening the period menu closes the dashboard menu, the backdrop closes everything; editing actions only for an editable dashboard, Delete permanently for anything but a system template", async () => {
  resetState();
  loadedDashboard();
  installFetchMock(responder());
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-open-menu", menu: "dashboard" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.menu, "dashboard");
  let html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /role="menu" aria-label="Dashboard actions"/);
  const items = [...html.matchAll(/role="menuitem"[^>]*data-action="([^"]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(items, [
    ["training-load-analysis-rename-dashboard", "Rename"],
    ["training-load-analysis-set-active", "Active dashboard"],
    ["training-load-analysis-toggle-edit", "Edit layout"],
    ["training-load-analysis-archive", "Archive"],
    ["training-load-analysis-delete-dashboard", "Delete permanently"],
  ]);
  assert.match(html, /data-action="training-load-analysis-set-active"[^>]*disabled/, "the active dashboard can't be set active again");
  assert.match(html, /training-load-analysis-archive[\s\S]*role="separator"[\s\S]*training-load-analysis-delete-dashboard/, "Delete sits below a separator, after Archive");
  assert.match(html, /class="tl-menu-item is-danger"[^>]*data-action="training-load-analysis-delete-dashboard"/);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-open-menu", menu: "period" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.menu, "period");
  html = renderTrainingLoadAnalysisHtml();
  assert.doesNotMatch(html, /aria-label="Dashboard actions"[\s\S]*role="menu" aria-label="Dashboard actions"/);
  assert.match(html, /role="menu" aria-label="Period presets"/);
  assert.equal((html.match(/class="tl-popover-backdrop"/g) || []).length, 1, "exactly one backdrop for the one open popover");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-close-popovers" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.menu, "");

  // Owner decision (permanent delete): an archived dashboard and a
  // club/team template can still be deleted - the menu then offers ONLY
  // Delete permanently; a system template gets no menu at all.
  const menuActions = () => [...renderTrainingLoadAnalysisHtml().matchAll(/role="menuitem"[^>]*data-action="([^"]+)"/g)].map((m) => m[1]);
  state.trainingLoad.analysis.menu = "dashboard";
  state.trainingLoad.analysis.dashboard = dashboard({ status: "archived" });
  assert.deepEqual(menuActions(), ["training-load-analysis-delete-dashboard"], "archived: Delete only - no Rename/Set active/Edit layout/Archive");
  assert.doesNotMatch(renderTrainingLoadAnalysisHtml(), /role="separator"/, "no separator when Delete is the only item");
  state.trainingLoad.analysis.dashboard = dashboard({ id: templateId, is_template: true, owner_scope: "club" });
  assert.deepEqual(menuActions(), ["training-load-analysis-delete-dashboard"], "club template: Delete only");
  state.trainingLoad.analysis.dashboard = dashboard({ id: templateId, is_template: true, owner_scope: "system" });
  assert.doesNotMatch(renderTrainingLoadAnalysisHtml(), /data-menu="dashboard"/, "system template: no dashboard actions menu at all");
});

test("Escape closes the topmost overlay in order - popover, then dialog, then metric panel - and never a panel whose save is in flight", () => {
  resetState();
  loadedDashboard();
  const a = state.trainingLoad.analysis;
  a.picker.open = true;
  a.dashboardForm = { mode: "create", name: "", description: "", error: "", submitting: false };
  a.metricPanel = { widgetId: "", metric: null, title: "", saving: false };
  assert.equal(closeTrainingLoadAnalysisOverlay(), true);
  assert.equal(a.picker.open, false);
  assert.ok(a.dashboardForm && a.metricPanel, "only the popover closed");
  assert.equal(closeTrainingLoadAnalysisOverlay(), true);
  assert.equal(a.dashboardForm, null);
  assert.ok(a.metricPanel, "the panel is still open");
  a.metricPanel.saving = true;
  assert.equal(closeTrainingLoadAnalysisOverlay(), false, "a saving panel is never closed by Escape");
  a.metricPanel.saving = false;
  assert.equal(closeTrainingLoadAnalysisOverlay(), true);
  assert.equal(a.metricPanel, null);
  assert.equal(closeTrainingLoadAnalysisOverlay(), false);
});

// -------------------- Period presets --------------------

test("the default period is the 28-day preset; choosing a preset rewrites From/To and re-queries; hand-edited dates read as Custom", async () => {
  resetState();
  loadedDashboard();
  installFetchMock(responder());
  assert.equal(analysisPeriodPresetKey(), "28d");
  let html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /<small>Period<\/small><strong>Last 28 days<\/strong>/);

  state.trainingLoad.analysis.menu = "period";
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-period-preset", preset: "7d" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.menu, "", "picking a preset closes the menu");
  assert.equal(analysisPeriodPresetKey(), "7d");
  const { dateFrom, dateTo } = state.trainingLoad.analysis.period;
  assert.equal((new Date(`${dateTo}T00:00:00Z`) - new Date(`${dateFrom}T00:00:00Z`)) / 86400000, 6, "7 days inclusive");
  const query = fetchCalls.filter((c) => c.url.endsWith("/query")).pop();
  assert.deepEqual([query.body.dateFrom, query.body.dateTo], [dateFrom, dateTo]);
  assert.ok(ANALYSIS_PERIOD_PRESETS.every((p) => p.days <= 400), "every preset stays under the route's 400-day cap");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-period-from" }, "2026-01-01"), { renderTrainingLoad });
  assert.equal(analysisPeriodPresetKey(), "custom");
  html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /<small>Period<\/small><strong>Custom<\/strong>/);
  assert.match(html, /training-load-analysis-period-from/, "From/To inputs stay available alongside the presets");
});

// -------------------- New dashboard / Rename dialog --------------------

test("New dashboard is a dialog: an empty name is refused without a request, a valid one POSTs name+description with ownerScope user, closes the dialog and selects the new dashboard", async () => {
  resetState();
  state.trainingLoad.analysis.dashboards = allDashboards();
  installFetchMock(responder({
    extra: (call) => {
      if (call.url === "/api/training-load/dashboards" && call.method === "POST") {
        assert.deepEqual(call.body, { name: "Readiness", description: "Morning check", ownerScope: "user", isTemplate: false });
        return { status: 201, body: { dashboard: dashboard({ id: otherId, name: "Readiness" }) } };
      }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-new-dashboard" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.deepEqual(a.dashboardForm, { mode: "create", name: "", description: "", error: "", submitting: false });
  let html = renderTrainingLoadAnalysisHtml();
  // code-reviewer (HIGH): app.js's click delegation resolves
  // closest("[data-action]") - a data-action on the <form> itself would turn
  // a click on a label / the title / the padding into a submit.
  assert.doesNotMatch(html, /<form[^>]*data-action=/, "a form must never be a click-dispatch target");
  assert.match(html, /<form[^>]*data-tl-analysis-form="dashboard"/);
  assert.match(html, /New dashboard<\/strong>/);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-dashboard-form-submit" }), { renderTrainingLoad });
  assert.equal(a.dashboardForm.error, "Give the dashboard a name.");
  assert.equal(writes().length, 0, "nothing is sent for an empty name");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-dashboard-form-name" }, "  Readiness "), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-dashboard-form-description" }, "Morning check"), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-dashboard-form-submit" }), { renderTrainingLoad });
  assert.equal(a.dashboardForm, null, "the dialog closes on success");
  assert.equal(a.selectedDashboardId, otherId, "the new dashboard is selected");
  assert.equal(a.notice, 'Dashboard "Readiness" created.');
  html = renderTrainingLoadAnalysisHtml();
  assert.doesNotMatch(html, /tl-dash-form/);
});

test("a form submit reads the live inputs (Enter before any change event), and a server error keeps the dialog open with the message", async () => {
  resetState();
  state.trainingLoad.analysis.dashboards = allDashboards();
  installFetchMock(responder({
    extra: (call) => (call.url === "/api/training-load/dashboards" && call.method === "POST" ? { status: 409, body: { error: "conflict", message: "A dashboard with this name already exists." } } : null),
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-new-dashboard" }), { renderTrainingLoad });
  const form = {
    dataset: { action: "training-load-analysis-dashboard-form-submit" },
    querySelector: (sel) => (sel.includes("form-name") ? { value: "Typed then Enter" } : { value: "" }),
  };
  await handleTrainingLoadAction(form, { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.ok(a.dashboardForm, "the dialog stays open");
  assert.equal(a.dashboardForm.name, "Typed then Enter");
  assert.equal(a.dashboardForm.submitting, false);
  // api.js exposes the route's error CODE ("conflict"), never the raw text -
  // the dialog translates it into a coach-readable sentence.
  assert.match(a.dashboardForm.error, /already in use/);
  assert.equal(a.mutationError, "", "the error is shown inside the dialog, not duplicated in the page banner");
  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /role="alert">That name is already in use/);
});

test("Rename from the dashboard menu PATCHes name with expectedRevision and does nothing when the name is unchanged", async () => {
  resetState();
  loadedDashboard();
  installFetchMock(responder({
    extra: (call) => {
      if (call.url === `/api/training-load/dashboards/${dashboardId}` && call.method === "PATCH") {
        assert.deepEqual(call.body, { expectedRevision: 3, name: "Load board v2" });
        return { status: 200, body: { dashboard: dashboard({ name: "Load board v2", revision: 4 }) } };
      }
      return null;
    },
  }));
  state.trainingLoad.analysis.menu = "dashboard";
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-rename-dashboard" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.equal(a.menu, "", "opening the dialog closes the menu");
  assert.equal(a.dashboardForm.mode, "rename");
  assert.equal(a.dashboardForm.name, "Load board");
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-dashboard-form-submit" }), { renderTrainingLoad });
  assert.equal(writes().length, 0, "unchanged name: no request");
  assert.equal(a.dashboardForm, null);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-rename-dashboard" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-dashboard-form-name" }, "Load board v2"), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-dashboard-form-submit" }), { renderTrainingLoad });
  assert.equal(writes().length, 1);
  assert.equal(a.dashboardForm, null);
  assert.equal(a.notice, "Dashboard renamed.");
});

// -------------------- Guided "Add metric" panel --------------------

test("Add metric opens the staged panel; picking a built-in applies its defaults and auto-title; type/fields change locally; Cancel discards everything without a single write", async () => {
  resetState();
  loadedDashboard();
  installFetchMock(responder());
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-add-widget" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.ok(a.metricPanel, "the panel opened");
  assert.equal(a.metricPanel.widgetId, "");
  assert.equal(metricPanelCanSave(a.metricPanel), false, "no metric yet - Save is disabled");
  let html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /aria-labelledby="tl-metric-panel-title"/);
  assert.match(html, /data-action="training-load-analysis-panel-save"[^>]*disabled/);
  assert.match(html, /Nothing is saved until you press Save\./);
  assert.match(html, /Values appear on the dashboard after saving\./, "the preview is explicitly a configuration preview");
  assert.doesNotMatch(html, /tl-analysis-editor"/, "the advanced editor is not what opens");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "srpe" }), { renderTrainingLoad });
  assert.deepEqual(a.metricPanel.metric, { kind: "builtin", key: "srpe", label: "sRPE", unit: "AU" });
  assert.equal(a.metricPanel.aggregation, "sum");
  assert.equal(a.metricPanel.title, "sRPE", "the title follows the metric until the coach edits it");
  assert.equal(metricPanelCanSave(a.metricPanel), true);
  html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /data-built-in-key="srpe"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-built-in-key="srpe"/);
  assert.match(html, /Total sRPE · AU · per day/, "the preview summarises the staged configuration");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-type", widgetType: "bar_chart" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-field", field: "groupBy" }, "week"), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-field", field: "aggregation" }, "max"), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-title" }, "Weekly peak"), { renderTrainingLoad });
  assert.equal(a.metricPanel.widgetType, "bar_chart");
  assert.equal(a.metricPanel.groupBy, "week");
  assert.equal(a.metricPanel.aggregation, "max");
  assert.equal(a.metricPanel.title, "Weekly peak");
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "rpe" }), { renderTrainingLoad });
  assert.equal(a.metricPanel.title, "Weekly peak", "a coach-typed title is never overwritten by a later metric pick");
  html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /data-widget-type="bar_chart"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-widget-type="bar_chart"/);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-close" }), { renderTrainingLoad });
  assert.equal(a.metricPanel, null);
  assert.equal(writes().length, 0, "Cancel: no widget, no series, nothing was ever sent");
  assert.equal(a.widgets.length, 1, "the dashboard is exactly as it was");
});

test("Save for a NEW metric: POST widget (title/type/per + 12-col placement below existing widgets) -> POST series at revision 1 with the staged aggregation/scope -> one batch query; the panel closes with a notice", async () => {
  resetState();
  loadedDashboard();
  const seen = [];
  installFetchMock(responder({
    widgets: [widget(), widget({ id: newWidgetId, title: "Jump height", widget_type: "line_chart", mobile_order: 2, series: [series({ id: "s2", metric_definition_id: metricId, built_in_series_key: null })] })],
    extra: (call) => {
      if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets` && call.method === "POST") {
        seen.push("widget");
        assert.deepEqual(call.body, {
          expectedDashboardRevision: 3, widgetType: "line_chart", title: "Jump height", widgetOrder: 2,
          x: 0, y: 3, width: 6, height: 5, mobileOrder: 2, groupBy: "session", displayConfig: { schemaVersion: 1 },
        });
        return { status: 201, body: { widgetId: newWidgetId, dashboardRevision: 4 } };
      }
      if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${newWidgetId}/series` && call.method === "POST") {
        seen.push("series");
        assert.deepEqual(call.body, { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId: metricId, dataScopeLevel: "session", analyticalAggregation: "max" });
        return { status: 201, body: { seriesId: "s2", widgetRevision: 2 } };
      }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-add-widget" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.equal(a.metricPicker.definitions?.[0]?.label, "Jump height", "opening the panel loads the catalog");
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-metric", metricId }), { renderTrainingLoad });
  assert.deepEqual(a.metricPanel.metric, { kind: "metric", id: metricId, label: "Jump height", unit: "cm" });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-type", widgetType: "line_chart" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-field", field: "groupBy" }, "session"), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-field", field: "aggregation" }, "max"), { renderTrainingLoad });
  assert.equal(writes().length, 0, "still nothing written before Save");

  const before = fetchCalls.length;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.deepEqual(seen, ["widget", "series"], "widget first, then its series - in that order");
  const after = fetchCalls.slice(before);
  assert.equal(after.filter((c) => c.url.endsWith("/query")).length, 1, "exactly one batch query after the save");
  assert.ok(after.some((c) => c.method === "GET" && c.url === `/api/training-load/dashboards/${dashboardId}`), "the detail is reloaded so the new widget shows real data");
  assert.equal(a.metricPanel, null);
  assert.equal(a.notice, "Metric added to the dashboard.");
  assert.equal(a.widgets.length, 2);
});

test("Save reads the title straight off the input when the click beats the change event", async () => {
  resetState();
  loadedDashboard();
  installFetchMock(responder({
    extra: (call) => {
      if (call.url.endsWith("/widgets") && call.method === "POST") {
        assert.equal(call.body.title, "Typed title");
        return { status: 201, body: { widgetId: newWidgetId, dashboardRevision: 4 } };
      }
      if (call.url.endsWith(`/widgets/${newWidgetId}/series`) && call.method === "POST") return { status: 201, body: { seriesId: "s2", widgetRevision: 2 } };
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-add-widget" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "rpe" }), { renderTrainingLoad });
  queried["[data-action='training-load-analysis-panel-title']"] = { value: "Typed title" };
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.metricPanel, null);
  assert.ok(fetchCalls.some((c) => c.url.endsWith("/widgets") && c.method === "POST"));
});

test("widget Settings opens the panel prefilled from the saved widget; Save PATCHes only what changed, threading the widget revision from the PATCH into the series PATCH", async () => {
  resetState();
  loadedDashboard();
  const seen = [];
  installFetchMock(responder({
    extra: (call) => {
      if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}` && call.method === "PATCH") {
        seen.push("widget");
        assert.deepEqual(call.body, { expectedWidgetRevision: 4, title: "RPE trend", widgetType: "line_chart" });
        // code-reviewer note: the REAL route shape - update_widget_content
        // (v17) returns (widget_id, widget_revision, dashboard_id), never a
        // `revision` field; the series step must thread widget_revision.
        return { status: 200, body: { widget: { widget_id: widgetId, widget_revision: 5, dashboard_id: dashboardId } } };
      }
      if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series/${seriesId}` && call.method === "PATCH") {
        seen.push("series");
        assert.deepEqual(call.body, { expectedWidgetRevision: 5, dataScopeLevel: "session", analyticalAggregation: "max" });
        return { status: 200, body: { seriesId, widgetRevision: 6 } };
      }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.equal(a.editor.open, false, "Settings opens the guided panel, not the advanced editor");
  assert.equal(a.metricPanel.widgetId, widgetId);
  assert.equal(a.metricPanel.seriesId, seriesId);
  assert.deepEqual(a.metricPanel.metric, { kind: "builtin", key: "rpe", label: "RPE", unit: "RPE" });
  assert.equal(a.metricPanel.title, "Average RPE");
  assert.equal(a.metricPanel.aggregation, "avg");
  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /Edit metric<\/strong>/);
  assert.match(html, /data-action="training-load-analysis-open-advanced" data-widget-id="55555555-5555-4555-8555-555555555555"/, "Advanced settings link only while editing");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-title" }, "RPE trend"), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-type", widgetType: "line_chart" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-field", field: "aggregation" }, "max"), { renderTrainingLoad });
  assert.equal(writes().length, 0);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.deepEqual(seen, ["widget", "series"]);
  assert.equal(a.metricPanel, null);
  assert.equal(a.notice, "Metric updated.");
});

test("changing the metric of a BELOW-capacity (table) widget replaces its series ADD-FIRST (POST new at the next slot, then DELETE old at the returned revision) - and an unchanged panel saves without any request", async () => {
  resetState();
  loadedDashboard();
  state.trainingLoad.analysis.widgets = [widget({ widget_type: "table", width: 6, height: 4 })];
  const seen = [];
  installFetchMock(responder({
    extra: (call) => {
      if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series` && call.method === "POST") {
        seen.push("add");
        // Owner review: the NEW series is added FIRST (next free order slot),
        // so a failed add can never leave the widget without its metric.
        assert.deepEqual(call.body, { expectedWidgetRevision: 4, seriesOrder: 2, builtInSeriesKey: "duration_minutes", dataScopeLevel: "session", analyticalAggregation: "sum" });
        return { status: 201, body: { seriesId: "s2", widgetRevision: 5 } };
      }
      if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series/${seriesId}` && call.method === "DELETE") {
        seen.push("delete");
        assert.deepEqual(call.body, { expectedWidgetRevision: 5 }, "the delete threads the revision the add returned");
        return { status: 200, body: { widgetRevision: 6 } };
      }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.equal(writes().length, 0, "nothing changed - nothing sent");
  assert.equal(state.trainingLoad.analysis.metricPanel, null, "but the panel still closes");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "duration_minutes" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.metricPanel.title, "Average RPE", "an existing widget keeps its own title when the metric changes");
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.deepEqual(seen, ["add", "delete"]);
  assert.equal(state.trainingLoad.analysis.metricPanel, null);
  assert.ok(!fetchCalls.some((c) => c.url.endsWith("/series/reorder")), "a single-series widget needs no reorder");
});

test("new widget, series fails AND the compensating widget delete fails: the panel re-stages the created widget (Close, not Cancel), a second Save adds the series only - never a second widget", async () => {
  resetState();
  loadedDashboard();
  const seriesPosts = [];
  const widgetDeletes = [];
  installFetchMock(responder({
    // The reloaded detail already contains the widget the first Save created
    // (fresh, revision 1, no series yet) alongside the old one at revision 9.
    widgets: [widget({ revision: 9 }), widget({ id: newWidgetId, title: "RPE", revision: 1, mobile_order: 2, series: [] })],
    extra: (call) => {
      if (call.url.endsWith("/widgets") && call.method === "POST") return { status: 201, body: { widgetId: newWidgetId, dashboardRevision: 4 } };
      if (call.url.endsWith(`/widgets/${newWidgetId}`) && call.method === "DELETE") {
        widgetDeletes.push(call);
        return { status: 409, body: { error: "staleRevision" } }; // compensation refused
      }
      if (call.url.endsWith(`/widgets/${newWidgetId}/series`) && call.method === "POST") {
        seriesPosts.push(call);
        // code-reviewer (MEDIUM): first attempt fails after the widget POST
        // succeeded; the retry must succeed WITHOUT creating another widget.
        return seriesPosts.length === 1 ? { status: 409, body: { error: "staleRevision" } } : { status: 201, body: { seriesId: "s9", widgetRevision: 2 } };
      }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-add-widget" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "rpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.ok(a.metricPanel, "the panel stays open");
  assert.equal(a.metricPanel.saving, false);
  assert.equal(widgetDeletes.length, 1, "the empty widget's removal was attempted first");
  assert.deepEqual(widgetDeletes[0].body, { expectedWidgetRevision: 1 });
  assert.match(a.metricPanel.error, /removing the empty widget failed too/);
  assert.equal(a.metricPanel.serverChanged, true);
  assert.ok(fetchCalls.some((c) => c.method === "GET" && c.url === `/api/training-load/dashboards/${dashboardId}`), "the detail was reloaded");
  assert.equal(a.widgets[0].revision, 9, "state now reflects the server's current revision");
  assert.equal(a.metricPanel.widgetId, newWidgetId, "the panel now edits the widget that was actually created");
  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /role="alert">The widget was created but its metric could not be added/);
  assert.match(html, /data-action="training-load-analysis-panel-close"[^>]*>Close</, "an honest Close instead of Cancel once the server differs");
  assert.match(html, /Closing keeps what is already saved/);
  assert.doesNotMatch(html, /Nothing is saved until you press Save/, "the subtitle must not contradict the alert");
  assert.match(html, /Part of this change is already on the dashboard/);
  assert.match(html, /Add metric<\/strong>/, "still 'Add metric' - the coach is adding, not editing");
  assert.doesNotMatch(html, /training-load-analysis-open-advanced/, "no Advanced settings for a widget that has no series yet");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.equal(fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith("/widgets")).length, 1, "the widget is created exactly once");
  assert.equal(seriesPosts.length, 2);
  assert.equal(seriesPosts[1].body.expectedWidgetRevision, 1, "the retry targets the created widget's real revision");
  assert.equal(seriesPosts[1].body.builtInSeriesKey, "rpe");
  assert.equal(a.metricPanel, null, "the retry succeeded and closed the panel");
  assert.equal(a.notice, "Metric added to the dashboard.");
});

test("the Add metric button and the empty-state CTA exist only for an editable dashboard; the header no longer carries Metadata/Archive/Set active buttons (they moved into the menu)", () => {
  resetState();
  loadedDashboard();
  state.trainingLoad.analysis.widgets = [];
  let html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /No metrics yet/);
  assert.equal((html.match(/data-action="training-load-analysis-add-widget"/g) || []).length, 2, "header button + empty-state CTA");
  assert.doesNotMatch(html, />Metadata<|>Archive<\/button>|>Set active</);
  state.trainingLoad.analysis.editMode = true;
  html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /Save layout/);
  assert.match(html, /data-action="training-load-analysis-toggle-edit">Done</);
  state.trainingLoad.analysis.dashboard = dashboard({ status: "archived" });
  html = renderTrainingLoadAnalysisHtml();
  assert.doesNotMatch(html, /data-action="training-load-analysis-add-widget"/);
  assert.match(html, /This dashboard has no widgets\./);
});

// -------------------- Owner review of PR #89: no metric-less widget left behind --------------------

test("new widget: when the series POST fails, the just-created empty widget is DELETEd again (compensation) - nothing is left on the dashboard, the panel says so and Cancel is honest", async () => {
  resetState();
  loadedDashboard();
  const log = [];
  installFetchMock(responder({
    extra: (call) => {
      if (call.url.endsWith("/widgets") && call.method === "POST") { log.push("create"); return { status: 201, body: { widgetId: newWidgetId, dashboardRevision: 4 } }; }
      if (call.url.endsWith(`/widgets/${newWidgetId}/series`) && call.method === "POST") { log.push("series"); return { status: 400, body: { error: "invalidRequest", message: "Unknown or inactive builtInSeriesKey." } }; }
      if (call.url.endsWith(`/widgets/${newWidgetId}`) && call.method === "DELETE") { log.push("rollback"); assert.deepEqual(call.body, { expectedWidgetRevision: 1 }); return { status: 200, body: { dashboard: dashboard({ revision: 5 }) } }; }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-add-widget" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "rpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.deepEqual(log, ["create", "series", "rollback"]);
  assert.ok(a.metricPanel, "the panel stays open");
  assert.equal(a.metricPanel.widgetId, "", "staged as a NEW widget again - the created one is gone");
  assert.equal(a.metricPanel.createdInFlight, false);
  assert.equal(a.metricPanel.serverChanged, false);
  assert.match(a.metricPanel.error, /nothing was saved/);
  assert.equal(a.widgets.length, 1, "the reloaded dashboard has only the pre-existing widget");
  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /data-action="training-load-analysis-panel-close"[^>]*>Cancel</, "Cancel is truthful: the dashboard is as it was");
  const before = fetchCalls.length;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-close" }), { renderTrainingLoad });
  assert.equal(fetchCalls.length, before, "Cancel sends nothing");
  assert.equal(a.metricPanel, null);
});

test("existing widget, metric change: when the NEW series POST fails nothing else is sent - the previous metric is untouched and Cancel is honest", async () => {
  resetState();
  loadedDashboard();
  state.trainingLoad.analysis.widgets = [widget({ widget_type: "table", width: 6, height: 4 })];
  const log = [];
  installFetchMock(responder({
    extra: (call) => {
      if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series` && call.method === "POST") { log.push("add"); return { status: 400, body: { error: "invalidRequest" } }; }
      if (call.method === "DELETE") { log.push("DELETE " + call.url); return { status: 200, body: { widgetRevision: 99 } }; }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "srpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.deepEqual(log, ["add"], "the old series is never deleted when the add failed");
  assert.ok(a.metricPanel);
  assert.equal(a.metricPanel.serverChanged, false);
  assert.equal(a.widgets[0].series[0].id, seriesId, "the previous metric is still on the widget");
  assert.match(renderTrainingLoadAnalysisHtml(), /training-load-analysis-panel-close"[^>]*>Cancel</);
  const writesBefore = fetchCalls.filter((c) => c.method !== "GET").length;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-close" }), { renderTrainingLoad });
  assert.equal(fetchCalls.filter((c) => c.method !== "GET").length, writesBefore, "Cancel writes nothing");
});

test("existing widget, metric change: when the OLD series DELETE fails, the new series is removed again (compensation) so the widget shows exactly the previous metric", async () => {
  resetState();
  loadedDashboard();
  state.trainingLoad.analysis.widgets = [widget({ widget_type: "table", width: 6, height: 4 })];
  const log = [];
  installFetchMock(responder({
    extra: (call) => {
      const seriesUrl = `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series`;
      if (call.url === seriesUrl && call.method === "POST") { log.push("add"); return { status: 201, body: { seriesId: "s-new", widgetRevision: 5 } }; }
      if (call.url === `${seriesUrl}/${seriesId}` && call.method === "DELETE") { log.push("delete-old"); return { status: 500, body: { error: "internal" } }; }
      if (call.url === `${seriesUrl}/s-new` && call.method === "DELETE") { log.push("rollback-new"); assert.deepEqual(call.body, { expectedWidgetRevision: 5 }); return { status: 200, body: { widgetRevision: 6 } }; }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "srpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.deepEqual(log, ["add", "delete-old", "rollback-new"]);
  assert.ok(a.metricPanel);
  assert.match(a.metricPanel.error, /previous metric is unchanged/);
  assert.equal(a.metricPanel.serverChanged, false);
  assert.equal(a.metricPanel.staleSeriesId, "");
  assert.match(renderTrainingLoadAnalysisHtml(), /training-load-analysis-panel-close"[^>]*>Cancel</);
});

test("existing widget, metric change: when both the DELETE and its compensation fail, the panel tells the coach both metrics are on the widget, offers Close, and a retry only removes the old series", async () => {
  resetState();
  loadedDashboard();
  const log = [];
  let oldDeleteAttempts = 0;
  const reloaded = widget({ widget_type: "table", series: [series(), series({ id: "s-new", series_order: 2, built_in_series_key: "srpe", analytical_aggregation: "sum" })], revision: 5 });
  state.trainingLoad.analysis.widgets = [reloaded];
  installFetchMock(responder({
    widgets: [reloaded],
    extra: (call) => {
      const seriesUrl = `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series`;
      if (call.url === seriesUrl && call.method === "POST") { log.push("add"); return { status: 201, body: { seriesId: "s-new", widgetRevision: 5 } }; }
      if (call.url === `${seriesUrl}/${seriesId}` && call.method === "DELETE") {
        oldDeleteAttempts += 1;
        log.push("delete-old");
        return oldDeleteAttempts === 1 ? { status: 500, body: { error: "internal" } } : { status: 200, body: { widgetRevision: 6 } };
      }
      if (call.url === `${seriesUrl}/s-new` && call.method === "DELETE") { log.push("rollback-new"); return { status: 500, body: { error: "internal" } }; }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "srpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.deepEqual(log, ["add", "delete-old", "rollback-new"]);
  assert.ok(a.metricPanel);
  assert.equal(a.metricPanel.serverChanged, true);
  assert.equal(a.metricPanel.staleSeriesId, seriesId);
  assert.equal(a.metricPanel.seriesId, "s-new");
  assert.match(a.metricPanel.error, /shows both for now/);
  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /training-load-analysis-panel-close"[^>]*>Close</);
  assert.match(html, /Closing keeps what is already saved/);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.deepEqual(log, ["add", "delete-old", "rollback-new", "delete-old"], "the retry removes the old series only - no second add");
  assert.equal(a.metricPanel, null);
  assert.equal(a.notice, "Metric updated.");
});

test("new widget: the series POST response is LOST (network), compensation 409s, and the retry adopts the series the reload shows - never a second series", async () => {
  resetState();
  loadedDashboard();
  const seriesPosts = [];
  installFetchMock(responder({
    widgets: [widget(), widget({ id: newWidgetId, title: "RPE", revision: 2, mobile_order: 2, series: [series({ id: "s-lost", built_in_series_key: "rpe" })] })],
    extra: (call) => {
      if (call.url.endsWith("/widgets") && call.method === "POST") return { status: 201, body: { widgetId: newWidgetId, dashboardRevision: 4 } };
      if (call.url.endsWith(`/widgets/${newWidgetId}/series`) && call.method === "POST") { seriesPosts.push(call); throw new TypeError("fetch failed"); }
      if (call.url.endsWith(`/widgets/${newWidgetId}`) && call.method === "DELETE") return { status: 409, body: { error: "staleRevision" } };
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-add-widget" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "rpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.ok(a.metricPanel);
  assert.equal(a.metricPanel.widgetId, newWidgetId);
  assert.equal(seriesPosts.length, 1);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.equal(seriesPosts.length, 1, "the retry adopted s-lost instead of posting again");
  assert.equal(a.metricPanel, null);
  assert.equal(a.notice, "Metric added to the dashboard.");
});

test("existing widget: the series POST itself fails without a status (network) - the dashboard is reloaded so the grid shows the server's truth", async () => {
  resetState();
  loadedDashboard();
  state.trainingLoad.analysis.widgets = [widget({ widget_type: "table", width: 6, height: 4 })];
  installFetchMock(responder({
    extra: (call) => {
      if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series` && call.method === "POST") throw new TypeError("fetch failed");
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "srpe" }), { renderTrainingLoad });
  const before = fetchCalls.length;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.ok(fetchCalls.slice(before).some((c) => c.method === "GET" && c.url === `/api/training-load/dashboards/${dashboardId}`), "reloaded after an unknown outcome");
  const a = state.trainingLoad.analysis;
  assert.ok(a.metricPanel);
  assert.equal(a.metricPanel.serverChanged, false, "the reload showed the add never landed - Cancel stays truthful");
  assert.equal(a.metricPanel.pendingAddMetric, null);
  assert.match(renderTrainingLoadAnalysisHtml(), /training-load-analysis-panel-close"[^>]*>Cancel</);
});

test("existing widget: a persisted title PATCH followed by a failed series POST turns the footer into Close", async () => {
  resetState();
  loadedDashboard();
  state.trainingLoad.analysis.widgets = [widget({ widget_type: "table", width: 6, height: 4 })];
  installFetchMock(responder({
    extra: (call) => {
      if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}` && call.method === "PATCH") return { status: 200, body: { widget: { widget_id: widgetId, widget_revision: 5, dashboard_id: dashboardId } } };
      if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series` && call.method === "POST") return { status: 400, body: { error: "invalidRequest" } };
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-title" }, "New title"), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "srpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.ok(a.metricPanel);
  assert.equal(a.metricPanel.serverChanged, true);
  assert.match(renderTrainingLoadAnalysisHtml(), /training-load-analysis-panel-close"[^>]*>Close</);
});

test("retry with a staleSeriesId and a DIFFERENT metric on a multi-series widget: the reorder never names the stale series removed in the same save", async () => {
  resetState();
  loadedDashboard();
  const reloaded = widget({ widget_type: "table", revision: 5, series: [
    series(),
    series({ id: "s-new", series_order: 2, built_in_series_key: "srpe", analytical_aggregation: "sum" }),
    series({ id: "s-other", series_order: 3, built_in_series_key: "session_count", analytical_aggregation: "sum" }),
  ] });
  state.trainingLoad.analysis.widgets = [reloaded];
  let reorderBody = null;
  installFetchMock(responder({
    widgets: [reloaded],
    extra: (call) => {
      const seriesUrl = `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series`;
      if (call.url === `${seriesUrl}/${seriesId}` && call.method === "DELETE") return { status: 200, body: { widgetRevision: 6 } };
      if (call.url === seriesUrl && call.method === "POST") return { status: 201, body: { seriesId: "s-third", widgetRevision: 7 } };
      if (call.url === `${seriesUrl}/s-new` && call.method === "DELETE") return { status: 200, body: { widgetRevision: 8 } };
      if (call.url === `${seriesUrl}/reorder` && call.method === "PUT") { reorderBody = call.body; return { status: 200, body: { widgetRevision: 9 } }; }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  const panel = state.trainingLoad.analysis.metricPanel;
  panel.seriesId = "s-new";
  panel.seriesOrder = 2;
  panel.originalMetric = { kind: "builtin", key: "srpe", label: "sRPE", unit: "AU" };
  panel.staleSeriesId = seriesId;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "duration_minutes" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.ok(reorderBody, "a multi-series widget reorders after the replace");
  assert.deepEqual(reorderBody, { expectedWidgetRevision: 8, order: [{ seriesId: "s-third", seriesOrder: 1 }, { seriesId: "s-other", seriesOrder: 2 }] });
  assert.equal(state.trainingLoad.analysis.metricPanel, null);
});

// -------------------- At capacity (KPI, max_series = 1): delete-first with restore --------------------

test("KPI at capacity: replacing the metric DELETEs the old series first, then POSTs the new one into the same slot at the returned revision", async () => {
  resetState();
  loadedDashboard();
  const log = [];
  installFetchMock(responder({
    widgets: [widget({ series: [series({ id: "s2", built_in_series_key: "srpe", analytical_aggregation: "sum" })], revision: 6 })],
    extra: (call) => {
      const seriesUrl = `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series`;
      if (call.url === `${seriesUrl}/${seriesId}` && call.method === "DELETE") { log.push("delete-old"); assert.deepEqual(call.body, { expectedWidgetRevision: 4 }); return { status: 200, body: { widgetRevision: 5 } }; }
      if (call.url === seriesUrl && call.method === "POST") { log.push("add"); assert.deepEqual(call.body, { expectedWidgetRevision: 5, seriesOrder: 1, builtInSeriesKey: "srpe", dataScopeLevel: "session", analyticalAggregation: "sum" }); return { status: 201, body: { seriesId: "s2", widgetRevision: 6 } }; }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "srpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.deepEqual(log, ["delete-old", "add"]);
  assert.equal(state.trainingLoad.analysis.metricPanel, null);
  assert.equal(state.trainingLoad.analysis.notice, "Metric updated.");
});

test("KPI at capacity: when the new series POST fails, the previous series is POSTed back exactly as it was (restore) - the widget keeps its metric and Cancel is honest", async () => {
  resetState();
  loadedDashboard();
  const log = [];
  let posts = 0;
  installFetchMock(responder({
    extra: (call) => {
      const seriesUrl = `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series`;
      if (call.url === `${seriesUrl}/${seriesId}` && call.method === "DELETE") { log.push("delete-old"); return { status: 200, body: { widgetRevision: 5 } }; }
      if (call.url === seriesUrl && call.method === "POST") {
        posts += 1;
        if (posts === 1) { log.push("add"); assert.equal(call.body.builtInSeriesKey, "srpe"); return { status: 400, body: { error: "invalidRequest" } }; }
        log.push("restore");
        assert.deepEqual(call.body, { expectedWidgetRevision: 5, seriesOrder: 1, axis: "primary", dataScopeLevel: "session", analyticalAggregation: "avg", aggregationRolePolicy: "standalone_only", coveragePolicy: "complete_only", sourcePolicy: "not_applicable", builtInSeriesKey: "rpe" }, "the restore recreates the original series row, not the panel's defaults");
        return { status: 201, body: { seriesId: "s-restored", widgetRevision: 6 } };
      }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "srpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.deepEqual(log, ["delete-old", "add", "restore"]);
  assert.ok(a.metricPanel);
  assert.match(a.metricPanel.error, /previous metric was put back unchanged/);
  assert.equal(a.metricPanel.serverChanged, false);
  assert.match(renderTrainingLoadAnalysisHtml(), /training-load-analysis-panel-close"[^>]*>Cancel</);
});

test("KPI at capacity: when the new POST AND the restore both fail, the panel says the widget has no metric, offers Close, and a retry only adds", async () => {
  resetState();
  loadedDashboard();
  const log = [];
  let posts = 0;
  installFetchMock(responder({
    widgets: [widget({ series: [], revision: 5 })],
    extra: (call) => {
      const seriesUrl = `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series`;
      if (call.url === `${seriesUrl}/${seriesId}` && call.method === "DELETE") { log.push("delete-old"); return { status: 200, body: { widgetRevision: 5 } }; }
      if (call.url === seriesUrl && call.method === "POST") {
        posts += 1;
        log.push(posts === 2 ? "restore" : "add");
        return posts <= 2 ? { status: 500, body: { error: "internal" } } : { status: 201, body: { seriesId: "s3", widgetRevision: 6 } };
      }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "srpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.deepEqual(log, ["delete-old", "add", "restore"]);
  assert.ok(a.metricPanel);
  assert.equal(a.metricPanel.serverChanged, true);
  assert.match(a.metricPanel.error, /putting the previous one back failed too/);
  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /training-load-analysis-panel-close"[^>]*>Close</);
  assert.match(html, /Part of this change is already on the dashboard/);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.deepEqual(log, ["delete-old", "add", "restore", "add"], "the retry adds once - no further delete");
  assert.equal(a.metricPanel, null);
});

test("KPI at capacity: after a successful restore, Save again replaces the RESTORED series (delete-first again) - never an add into a full KPI", async () => {
  resetState();
  loadedDashboard();
  const log = [];
  let posts = 0;
  installFetchMock(responder({
    widgets: [widget({ series: [series({ id: "s-restored" })], revision: 6 })],
    extra: (call) => {
      const seriesUrl = `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series`;
      if (call.url === `${seriesUrl}/${seriesId}` && call.method === "DELETE") { log.push("delete-old"); return { status: 200, body: { widgetRevision: 5 } }; }
      if (call.url === `${seriesUrl}/s-restored` && call.method === "DELETE") { log.push("delete-restored"); assert.deepEqual(call.body, { expectedWidgetRevision: 6 }); return { status: 200, body: { widgetRevision: 7 } }; }
      if (call.url === seriesUrl && call.method === "POST") {
        posts += 1;
        if (posts === 1) { log.push("add"); return { status: 500, body: { error: "internal" } }; }
        if (posts === 2) { log.push("restore"); return { status: 201, body: { seriesId: "s-restored", widgetRevision: 6 } }; }
        log.push("add");
        assert.equal(call.body.seriesOrder, 1, "into the freed slot, never a second slot on a KPI");
        assert.equal(call.body.expectedWidgetRevision, 7);
        return { status: 201, body: { seriesId: "s-final", widgetRevision: 8 } };
      }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "srpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.deepEqual(log, ["delete-old", "add", "restore"]);
  assert.equal(a.metricPanel.seriesId, "s-restored", "the panel now points at the restored row");
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.deepEqual(log, ["delete-old", "add", "restore", "delete-restored", "add"]);
  assert.equal(a.metricPanel, null);
  assert.equal(a.notice, "Metric updated.");
});

test("KPI at capacity: a LOST response on the new POST plus a 409 restore reports an unknown outcome (never 'could not be added'); the retry adopts the series the reload shows without writing", async () => {
  resetState();
  loadedDashboard();
  let posts = 0;
  installFetchMock(responder({
    widgets: [widget({ series: [series({ id: "s2", built_in_series_key: "srpe", analytical_aggregation: "sum" })], revision: 6 })],
    extra: (call) => {
      const seriesUrl = `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series`;
      if (call.url === `${seriesUrl}/${seriesId}` && call.method === "DELETE") return { status: 200, body: { widgetRevision: 5 } };
      if (call.url === seriesUrl && call.method === "POST") {
        posts += 1;
        if (posts === 1) throw new TypeError("fetch failed");
        return { status: 409, body: { error: "staleRevision" } };
      }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "srpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.ok(a.metricPanel);
  assert.match(a.metricPanel.error, /Could not confirm whether the new metric was added/);
  assert.doesNotMatch(a.metricPanel.error, /could not be added, and/);
  const writes = () => fetchCalls.filter((c) => c.method !== "GET" && !c.url.endsWith("/query")).length;
  const writesBefore = writes();
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.equal(writes(), writesBefore, "the retry writes nothing");
  assert.equal(posts, 2, "the retry adopted the series the reload shows - no third POST");
  assert.equal(a.metricPanel, null);
  assert.equal(a.notice, "Metric updated.");
});

test("table (below capacity): the add-first POST is written on the server but its response is LOST - the reload shows old + new, the footer says Close, and Save again only deletes the old series (never a second copy)", async () => {
  resetState();
  loadedDashboard();
  state.trainingLoad.analysis.widgets = [widget({ widget_type: "table", width: 6, height: 4 })];
  const log = [];
  let posts = 0;
  installFetchMock(responder({
    // What the server really has after the lost POST: the old rpe series AND the new srpe one.
    widgets: [widget({ widget_type: "table", revision: 5, series: [series(), series({ id: "s-landed", series_order: 2, built_in_series_key: "srpe", analytical_aggregation: "sum" })] })],
    extra: (call) => {
      const seriesUrl = `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series`;
      if (call.url === seriesUrl && call.method === "POST") { posts += 1; log.push("add"); throw new TypeError("fetch failed"); }
      if (call.url === `${seriesUrl}/${seriesId}` && call.method === "DELETE") { log.push("delete-old"); assert.deepEqual(call.body, { expectedWidgetRevision: 5 }, "at the reloaded widget revision"); return { status: 200, body: { widgetRevision: 6 } }; }
      if (call.url === `${seriesUrl}/reorder`) { log.push("reorder"); return { status: 200, body: { widgetRevision: 7 } }; }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "srpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.deepEqual(log, ["add"]);
  assert.ok(a.metricPanel);
  assert.equal(a.metricPanel.serverChanged, true, "the reload showed the add landed - the server differs");
  assert.match(a.metricPanel.error, /previous one is still on the widget/);
  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /training-load-analysis-panel-close"[^>]*>Close</);
  assert.match(html, /Closing keeps what is already saved/);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.equal(posts, 1, "the retry never POSTs the new series again");
  assert.deepEqual(log, ["add", "delete-old"], "single-series widget after the replace - no reorder");
  assert.equal(a.metricPanel, null);
  assert.equal(a.notice, "Metric updated.");
});

test("table (below capacity): a lost add-first response where the add did NOT land keeps Cancel and the retry adds exactly once, then deletes the old series", async () => {
  resetState();
  loadedDashboard();
  state.trainingLoad.analysis.widgets = [widget({ widget_type: "table", width: 6, height: 4 })];
  const log = [];
  let posts = 0;
  installFetchMock(responder({
    widgets: [widget({ widget_type: "table" })],
    extra: (call) => {
      const seriesUrl = `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series`;
      if (call.url === seriesUrl && call.method === "POST") { posts += 1; log.push("add"); if (posts === 1) throw new TypeError("fetch failed"); return { status: 201, body: { seriesId: "s-new", widgetRevision: 5 } }; }
      if (call.url === `${seriesUrl}/${seriesId}` && call.method === "DELETE") { log.push("delete-old"); return { status: 200, body: { widgetRevision: 6 } }; }
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-edit-widget", widgetId }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-pick-builtin", builtInKey: "srpe" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.equal(a.metricPanel.serverChanged, false);
  assert.match(renderTrainingLoadAnalysisHtml(), /training-load-analysis-panel-close"[^>]*>Cancel</);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-panel-save" }), { renderTrainingLoad });
  assert.deepEqual(log, ["add", "add", "delete-old"]);
  assert.equal(a.metricPanel, null);
});

// -------------------- Permanent delete --------------------

test("Delete permanently asks for a confirmation that names the dashboard, its widgets and settings, and points to Archive; declining sends nothing", async () => {
  resetState();
  loadedDashboard();
  installFetchMock(responder());
  let asked = "";
  globalThis.window.confirm = (message) => { asked = message; return false; };
  try {
    state.trainingLoad.analysis.menu = "dashboard";
    await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-delete-dashboard" }), { renderTrainingLoad });
  } finally {
    globalThis.window.confirm = () => true;
  }
  assert.match(asked, /Permanently delete "Load board"\?/);
  assert.match(asked, /This also deletes its 1 widget and every setting/);

  // Browser QA: the copy must read naturally for 0 and for several widgets too.
  const confirmFor = async (widgets) => {
    state.trainingLoad.analysis.widgets = widgets;
    let text = "";
    globalThis.window.confirm = (m) => { text = m; return false; };
    try {
      await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-delete-dashboard" }), { renderTrainingLoad });
    } finally {
      globalThis.window.confirm = () => true;
    }
    return text;
  };
  const none = await confirmFor([]);
  assert.match(none, /It has no widgets yet; its settings \(layout, filters\) are deleted too\. It cannot be undone\./);
  assert.doesNotMatch(none, /all 0/);
  assert.match(await confirmFor([widget(), widget({ id: newWidgetId })]), /This also deletes all 2 of its widgets and every setting/);
  state.trainingLoad.analysis.widgets = [widget()];
  assert.match(asked, /every setting/);
  assert.match(asked, /cannot be undone/);
  assert.match(asked, /Archive/, "the confirmation points to Archive as the keep-it option");
  assert.equal(state.trainingLoad.analysis.menu, "", "the menu closes");
  assert.equal(writes().length, 0, "declining sends nothing");
  assert.equal(state.trainingLoad.analysis.dashboard.id, dashboardId, "the dashboard is still open");
});

test("confirming DELETEs the open dashboard with its revision; when it was the ACTIVE one the selection is cleared and the empty state shows", async () => {
  resetState();
  loadedDashboard();
  let deleted = false;
  installFetchMock(responder({
    extra: (call) => {
      if (call.url === `/api/training-load/dashboards/${dashboardId}` && call.method === "DELETE") {
        assert.deepEqual(call.body, { expectedRevision: 3 });
        deleted = true;
        return { status: 200, body: { deleted: true, dashboardId } };
      }
      // After the delete the server has no active selection and no longer lists it.
      if (deleted && call.url === "/api/training-load/dashboards/active") return { status: 200, body: { activeDashboard: null } };
      if (deleted && call.url.startsWith("/api/training-load/dashboards?")) return { status: 200, body: { dashboards: allDashboards().filter((d) => d.id !== dashboardId) } };
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-delete-dashboard" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.equal(deleted, true);
  assert.equal(a.dashboard, null);
  assert.equal(a.selectedDashboardId, "");
  assert.equal(a.activeDashboardId, "", "the active selection is gone");
  assert.equal(a.widgets.length, 0);
  assert.ok(!a.dashboards.some((d) => d.id === dashboardId), "the picker list no longer contains it");
  assert.equal(a.notice, 'Dashboard "Load board" was permanently deleted.');
  assert.ok(!fetchCalls.some((c) => c.method === "GET" && c.url === `/api/training-load/dashboards/${dashboardId}`), "never tries to reload the deleted dashboard");
  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /No dashboard selected/);
  assert.match(html, /was permanently deleted/);
});

test("deleting an open dashboard that was NOT the active one lands on the remaining active dashboard", async () => {
  resetState();
  loadedDashboard();
  const a = state.trainingLoad.analysis;
  // Open "Sprint board" while "Load board" stays the active dashboard.
  a.selectedDashboardId = otherId;
  a.dashboard = dashboard({ id: otherId, name: "Sprint board", owner_scope: "club", revision: 2 });
  a.widgets = [];
  let deleted = false;
  installFetchMock(responder({
    extra: (call) => {
      if (call.url === `/api/training-load/dashboards/${otherId}` && call.method === "DELETE") { deleted = true; return { status: 200, body: { deleted: true, dashboardId: otherId } }; }
      if (deleted && call.url.startsWith("/api/training-load/dashboards?")) return { status: 200, body: { dashboards: allDashboards().filter((d) => d.id !== otherId) } };
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-delete-dashboard" }), { renderTrainingLoad });
  assert.equal(deleted, true);
  assert.equal(a.activeDashboardId, dashboardId, "the untouched active selection survives");
  assert.equal(a.selectedDashboardId, dashboardId, "falls back to the remaining active dashboard");
  assert.equal(a.dashboard.name, "Load board");
  assert.ok(fetchCalls.some((c) => c.url === `/api/training-load/dashboards/${dashboardId}/query`), "and queries it");
  assert.match(renderTrainingLoadAnalysisHtml(), /<h3>Load board<\/h3>/);
});

test("a refused delete keeps the dashboard open and explains why: has clones (points to Archive), system template, forbidden; a stale revision reloads it", async () => {
  const cases = [
    { status: 409, body: { error: "dashboardHasClones" }, expect: /cloned into other dashboards[\s\S]*Archive it instead/ },
    { status: 409, body: { error: "systemTemplateProtected" }, expect: /System templates cannot be permanently deleted/ },
    { status: 403, body: { error: "forbidden" }, expect: /can't delete this dashboard/ },
  ];
  for (const c of cases) {
    resetState();
    loadedDashboard();
    installFetchMock(responder({ extra: (call) => (call.method === "DELETE" ? c : null) }));
    await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-delete-dashboard" }), { renderTrainingLoad });
    const a = state.trainingLoad.analysis;
    assert.equal(a.dashboard.id, dashboardId, `${c.body.error}: still open`);
    assert.equal(a.selectedDashboardId, dashboardId);
    assert.equal(a.saving, false);
    assert.match(a.mutationError, c.expect, c.body.error);
    assert.match(renderTrainingLoadAnalysisHtml(), /role="alert"/);
  }

  resetState();
  loadedDashboard();
  installFetchMock(responder({
    extra: (call) => (call.method === "DELETE" ? { status: 409, body: { error: "staleRevision" } } : null),
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-delete-dashboard" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.equal(a.dashboard.id, dashboardId);
  assert.match(a.notice, /changed on the server[\s\S]*review it before deleting/);
  assert.ok(fetchCalls.some((call) => call.method === "GET" && call.url === `/api/training-load/dashboards/${dashboardId}`), "reloaded the latest version");
  assert.equal(writes().length, 1, "exactly the one refused DELETE - nothing retried automatically");
});

test("a dashboard picked while the DELETE is still in flight stays open - the delete never overwrites the newer choice", async () => {
  resetState();
  loadedDashboard();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let deleted = false;
  installFetchMock(responder({
    extra: (call) => {
      if (call.method === "DELETE" && call.url === `/api/training-load/dashboards/${dashboardId}`) {
        return gate.then(() => { deleted = true; return { status: 200, body: { deleted: true, dashboardId } }; });
      }
      if (deleted && call.url === "/api/training-load/dashboards/active") return { status: 200, body: { activeDashboard: null } };
      if (deleted && call.url.startsWith("/api/training-load/dashboards?")) return { status: 200, body: { dashboards: allDashboards().filter((d) => d.id !== dashboardId) } };
      return null;
    },
  }));
  const pending = handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-delete-dashboard" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-select-dashboard", dashboardId: otherId }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.equal(a.selectedDashboardId, otherId, "sanity: the coach switched while the DELETE waited");
  release();
  await pending;
  assert.equal(deleted, true);
  assert.equal(a.selectedDashboardId, otherId, "the newer choice survives");
  assert.equal(a.dashboard?.id, otherId, "and is loaded, not left blank");
  assert.equal(a.detailLoading, false, "no stuck loading state after the cache invalidation");
  assert.equal(a.activeDashboardId, "", "the deleted dashboard's active selection is gone");
  assert.ok(!a.dashboards.some((d) => d.id === dashboardId));
  assert.match(a.notice, /"Load board" was permanently deleted/);
});

test("a 404 on delete means the dashboard is already gone: the same cleanup as a success (never a phantom open dashboard), with its own message", async () => {
  resetState();
  loadedDashboard();
  installFetchMock(responder({
    extra: (call) => {
      if (call.method === "DELETE") return { status: 404, body: { error: "notFound" } };
      if (call.url === "/api/training-load/dashboards/active") return { status: 200, body: { activeDashboard: null } };
      if (call.url.startsWith("/api/training-load/dashboards?")) return { status: 200, body: { dashboards: allDashboards().filter((d) => d.id !== dashboardId) } };
      return null;
    },
  }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-delete-dashboard" }), { renderTrainingLoad });
  const a = state.trainingLoad.analysis;
  assert.equal(a.dashboard, null);
  assert.equal(a.selectedDashboardId, "");
  assert.equal(a.activeDashboardId, "");
  assert.equal(a.mutationError, "", "not reported as a failure");
  assert.equal(a.notice, 'Dashboard "Load board" no longer exists.');
  assert.ok(!a.dashboards.some((d) => d.id === dashboardId));
  assert.match(renderTrainingLoadAnalysisHtml(), /No dashboard selected/);
});

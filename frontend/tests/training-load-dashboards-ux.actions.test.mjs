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

test("one popover at a time: opening the period menu closes the dashboard menu, the backdrop closes everything, and the dashboard menu only exists for an editable dashboard", async () => {
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
  ]);
  assert.match(html, /data-action="training-load-analysis-set-active"[^>]*disabled/, "the active dashboard can't be set active again");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-open-menu", menu: "period" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.menu, "period");
  html = renderTrainingLoadAnalysisHtml();
  assert.doesNotMatch(html, /aria-label="Dashboard actions"[\s\S]*role="menu" aria-label="Dashboard actions"/);
  assert.match(html, /role="menu" aria-label="Period presets"/);
  assert.equal((html.match(/class="tl-popover-backdrop"/g) || []).length, 1, "exactly one backdrop for the one open popover");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-close-popovers" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.menu, "");

  state.trainingLoad.analysis.dashboard = dashboard({ status: "archived" });
  html = renderTrainingLoadAnalysisHtml();
  assert.doesNotMatch(html, /data-menu="dashboard"/, "archived: no dashboard actions menu");
  state.trainingLoad.analysis.dashboard = dashboard({ id: templateId, is_template: true });
  html = renderTrainingLoadAnalysisHtml();
  assert.doesNotMatch(html, /data-menu="dashboard"/, "template: no dashboard actions menu");
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

test("changing the metric of an existing widget replaces its series (DELETE then POST at the returned revision) - and an unchanged panel saves without any request", async () => {
  resetState();
  loadedDashboard();
  const seen = [];
  installFetchMock(responder({
    extra: (call) => {
      if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series/${seriesId}` && call.method === "DELETE") {
        seen.push("delete");
        assert.deepEqual(call.body, { expectedWidgetRevision: 4 });
        return { status: 200, body: { widgetRevision: 5 } };
      }
      if (call.url === `/api/training-load/dashboards/${dashboardId}/widgets/${widgetId}/series` && call.method === "POST") {
        seen.push("add");
        assert.deepEqual(call.body, { expectedWidgetRevision: 5, seriesOrder: 1, builtInSeriesKey: "duration_minutes", dataScopeLevel: "session", analyticalAggregation: "sum" });
        return { status: 201, body: { seriesId: "s2", widgetRevision: 6 } };
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
  assert.deepEqual(seen, ["delete", "add"]);
  assert.equal(state.trainingLoad.analysis.metricPanel, null);
});

test("a stale revision during Save keeps the panel open with the message and reloads the dashboard; a second Save continues from the already-created widget (series only) - never a second widget", async () => {
  resetState();
  loadedDashboard();
  const seriesPosts = [];
  installFetchMock(responder({
    // The reloaded detail already contains the widget the first Save created
    // (fresh, revision 1, no series yet) alongside the old one at revision 9.
    widgets: [widget({ revision: 9 }), widget({ id: newWidgetId, title: "RPE", revision: 1, mobile_order: 2, series: [] })],
    extra: (call) => {
      if (call.url.endsWith("/widgets") && call.method === "POST") return { status: 201, body: { widgetId: newWidgetId, dashboardRevision: 4 } };
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
  assert.match(a.metricPanel.error, /changed on the server/);
  assert.ok(fetchCalls.some((c) => c.method === "GET" && c.url === `/api/training-load/dashboards/${dashboardId}`), "the detail was reloaded");
  assert.equal(a.widgets[0].revision, 9, "state now reflects the server's current revision");
  assert.equal(a.metricPanel.widgetId, newWidgetId, "the panel now edits the widget that was actually created");
  const html = renderTrainingLoadAnalysisHtml();
  assert.match(html, /role="alert">Dashboard changed on the server/);
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

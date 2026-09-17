// Dashboards UX H4 (feature/training-load-dashboards-ux-h4):
// 1. The remaining exits that dropped an unsaved Dashboards layout or widget
//    draft without asking - notification rows that open another screen and a
//    workspace switch - now ask confirmLeaveTrainingLoad first (the REAL
//    function, never a stub, except where noted). Declined changes nothing:
//    no request, the panel/menu stays as it was, the draft survives.
// 2. The advanced editor shows readable labels for its stored values (source,
//    values included, total coverage, aggregation, axis, comparison) - the
//    stored values themselves never change - and disables the three source
//    filters for built-in metrics, which the query engine does not apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  body: { classList: { contains: () => false, toggle() {} } },
};
globalThis.window = {
  confirm: () => true,
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  removeEventListener() {},
  location: { assign() { throw new Error("no page navigation expected"); } },
};

const { confirmLeaveTrainingLoad, discardTrainingLoadLeaveDrafts, handleTrainingLoadAction, resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
const { handleNotificationAction } = await import("../notifications.js");
const { handleWorkspaceAction } = await import("../workspace-actions.js");
const { renderTrainingLoadAnalysisHtml } = await import("../training-load-analysis-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");

const dashboardId = "11111111-1111-4111-8111-111111111111";
const widgetId = "55555555-5555-4555-8555-555555555555";
const seriesA = "77777777-7777-4777-8777-777777777777";
const metricId = "99999999-9999-4999-8999-999999999999";

let calls;
let failing = () => false;
function installFetch() {
  calls = [];
  failing = () => false;
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const failure = failing(call);
    if (failure) return { ok: false, status: failure.status, statusText: "", json: async () => ({ error: failure.error }) };
    let body = {};
    if (url.startsWith("/api/training-load/metrics/definitions")) {
      body = { rows: [{ id: metricId, key: "distance", label: "Distance", unit: "m", value_type: "number", scope_capabilities: ["session", "component"] }], nextCursor: null };
    } else if (url.startsWith("/api/training-load/metrics/")) body = { rows: [] };
    else if (url === "/api/auth/workspace") body = { activeWorkspace: { type: "club", scopeId: "club-1" }, availableWorkspaces: [] };
    return { ok: true, status: 200, statusText: "", json: async () => body };
  };
}
const writes = () => calls.filter((c) => c.method !== "GET");

function dashboard() {
  return { id: dashboardId, name: "Load board", owner_scope: "user", status: "active", is_template: false, revision: 3, default_filter: null };
}
function row(overrides = {}) {
  return {
    id: seriesA, series_order: 1, built_in_series_key: "rpe", metric_definition_id: null, template_metric_key_hints: null,
    resolution_status: "resolved", display_label: null, axis: "primary", color: null, source_policy: "not_applicable",
    source_connection_id: null, data_scope_level: "session", analytical_aggregation: "avg",
    aggregation_role_policy: "standalone_and_source_rollup", coverage_policy: "complete_and_partial", comparison_period: null,
    ...overrides,
  };
}
function widget(overrides = {}) {
  return { id: widgetId, widget_type: "table", title: "Load", group_by: "day", local_filter_override: null, x: 0, y: 0, width: 6, height: 4, mobile_order: 1, revision: 4, series: [row()], ...overrides };
}

function renderTrainingLoad() {}
const act = (action, dataset = {}, value = "") => handleTrainingLoadAction({ dataset: { action: `training-load-analysis-${action}`, ...dataset }, value }, { renderTrainingLoad });

function onDashboards(initialWidget = widget()) {
  clearAllViewCache();
  installFetch();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "private_coach", scopeId: null }, availableWorkspaces: [] };
  state.trainingLoad = emptyTrainingLoadState();
  state.trainingLoad.section = "analysis";
  state.activeTab = "training-load";
  state.notifications = { open: true, rows: [], unreadCount: 1, loading: false, error: "" };
  state.workspaceSwitcher = { open: true, pending: false, error: "" };
  const a = state.trainingLoad.analysis;
  a.dashboards = [dashboard()];
  a.selectedDashboardId = dashboardId;
  a.dashboard = dashboard();
  a.widgets = [structuredClone(initialWidget)];
  a.period = { dateFrom: "2026-09-01", dateTo: "2026-09-17" };
  return a;
}
async function withMovedWidget() {
  const a = onDashboards(widget({ width: 6 }));
  a.widgets.push({ ...widget({ width: 6 }), id: "66666666-6666-4666-8666-666666666666", title: "Second", y: 4, mobile_order: 2 });
  await act("toggle-edit");
  await act("widget-down", { widgetId });
  assert.ok(a.editMode && a.layoutDraft, "setup: a widget was moved and not saved");
  return a;
}
async function withUnsavedWidgetChange(initialWidget = widget()) {
  const a = onDashboards(initialWidget);
  await act("open-advanced", { widgetId });
  await act("widget-title", { widgetId }, "Unsaved title");
  assert.equal(a.editor.draft.title, "Unsaved title", "setup: the editor has an unsaved change");
  calls.length = 0;
  return a;
}
function answering(answer) {
  const prompts = [];
  window.confirm = (message) => { prompts.push(message); return answer; };
  return prompts;
}

const NAVIGATING = [
  ["notification-open-program-requests", {}, "openProgramRequests"],
  ["notification-open-test-assignment", { assignmentId: "asg-1" }, "openTestAssignment"],
  ["notification-open-training-load-assignment", { assignmentId: "asg-2" }, "openTrainingLoadAssignment"],
  ["notification-open-training-load-results", { scheduledDate: "2026-09-15" }, "openTrainingLoadResults"],
  ["notification-open-tests-today", {}, "openTestsToday"],
  ["notification-open-tests-results", { scheduleId: "sch-1" }, "openTestsResults"],
  ["notification-open-weekly-plan", { weekStart: "2026-09-14" }, "openWeeklyPlanFromNotification"],
  ["notification-open-specific-program", { planId: "plan-1" }, "openSpecificProgramFromNotification"],
];
// The same wiring as app.js: ask only, discard right before navigating.
const askLeave = () => confirmLeaveTrainingLoad(null, { discard: false });
function notificationHandlers(opened) {
  const handlers = { confirmLeave: askLeave, discardLeave: discardTrainingLoadLeaveDrafts };
  for (const [, , name] of NAVIGATING) handlers[name] = async (arg) => { opened.push([name, arg]); };
  return handlers;
}

// -------------------- 1. remaining exits --------------------

test("H4: every notification that opens another screen asks before it marks the row read, closes the panel or navigates - declined changes nothing and keeps the moved layout", async () => {
  try {
    for (const [type, extra, handlerName] of NAVIGATING) {
      const a = await withMovedWidget();
      const draft = a.layoutDraft;
      calls.length = 0;
      const prompts = answering(false);
      const opened = [];
      const handled = await handleNotificationAction({ dataset: { action: type, notificationId: "n1", ...extra } }, notificationHandlers(opened));
      assert.equal(handled, true, `${type}: handled`);
      assert.deepEqual(prompts, ["Discard your unsaved layout changes?"], `${type}: asks`);
      assert.deepEqual(opened, [], `${type}: declined - ${handlerName} is not called`);
      assert.equal(calls.length, 0, `${type}: declined - the row is not marked read`);
      assert.equal(state.notifications.open, true, `${type}: declined - the panel stays open`);
      assert.equal(a.layoutDraft, draft, `${type}: declined - the moved layout is kept`);
      assert.equal(a.editMode, true);
    }

    const a = await withMovedWidget();
    calls.length = 0;
    const prompts = answering(true);
    const opened = [];
    await handleNotificationAction({ dataset: { action: "notification-open-tests-today", notificationId: "n1" } }, notificationHandlers(opened));
    assert.equal(prompts.length, 1);
    assert.deepEqual(opened, [["openTestsToday", undefined]], "accepted: the notification opens its screen");
    assert.deepEqual([a.editMode, a.layoutDraft], [false, null], "accepted: the draft is discarded first");
    assert.equal(state.notifications.open, false);
    assert.deepEqual(writes().map((c) => c.url), ["/api/notifications/n1/read"]);
  } finally {
    window.confirm = () => true;
  }
});

test("H4: an unsaved Advanced settings change is protected the same way when a notification opens Training Load results", async () => {
  try {
    const a = await withUnsavedWidgetChange();
    const prompts = answering(false);
    const opened = [];
    await handleNotificationAction({ dataset: { action: "notification-open-training-load-results", notificationId: "n1", scheduledDate: "2026-09-15" } }, notificationHandlers(opened));
    assert.deepEqual(prompts, ["Discard your unsaved widget changes?"]);
    assert.deepEqual(opened, []);
    assert.equal(a.editor.open, true);
    assert.equal(a.editor.draft.title, "Unsaved title");
    assert.deepEqual(writes(), [], "declined: the row is not marked read");

    answering(true);
    await handleNotificationAction({ dataset: { action: "notification-open-training-load-results", notificationId: "n1", scheduledDate: "2026-09-15" } }, notificationHandlers(opened));
    assert.deepEqual(opened, [["openTrainingLoadResults", "2026-09-15"]]);
    assert.equal(a.editor.open, false, "accepted: the editor draft is discarded");
  } finally {
    window.confirm = () => true;
  }
});

test("H4: notification actions that stay on the current screen (toggle, mark read, read all, open a conversation) never ask", async () => {
  try {
    const a = await withMovedWidget();
    const draft = a.layoutDraft;
    const prompts = answering(false);
    const handlers = notificationHandlers([]);
    await handleNotificationAction({ dataset: { action: "notification-read", notificationId: "n1" } }, handlers);
    await handleNotificationAction({ dataset: { action: "notifications-read-all" } }, handlers);
    await handleNotificationAction({ dataset: { action: "notification-open-conversation", notificationId: "n1", conversationId: "conv-1" } }, handlers);
    await handleNotificationAction({ dataset: { action: "notifications-toggle" } }, handlers);
    assert.deepEqual(prompts, []);
    assert.equal(a.layoutDraft, draft, "the moved layout is untouched");
  } finally {
    window.confirm = () => true;
  }
});

test("H4: a workspace switch asks BEFORE the request - declined keeps the current workspace, sends nothing and keeps the draft; accepted switches; re-selecting the active workspace never asks", async () => {
  try {
    const a = await withMovedWidget();
    const draft = a.layoutDraft;
    calls.length = 0;
    let changed = 0;
    const handlers = { onWorkspaceChanged: async () => { changed += 1; resetTrainingLoadForWorkspaceChange(); }, confirmLeave: askLeave };
    const clubAction = { dataset: { action: "workspace-select", workspaceType: "club", workspaceScopeId: "club-1" } };

    let prompts = answering(false);
    assert.equal(await handleWorkspaceAction({ dataset: { action: "workspace-select", workspaceType: "private_coach", workspaceScopeId: "" } }, handlers), true);
    assert.deepEqual(prompts, [], "the already active workspace: nothing happens, nothing to ask");

    assert.equal(await handleWorkspaceAction(clubAction, handlers), true);
    assert.deepEqual(prompts, ["Discard your unsaved layout changes?"]);
    assert.equal(calls.length, 0, "declined: no PUT /api/auth/workspace");
    assert.equal(changed, 0);
    assert.equal(state.workspaceSwitcher.pending, false);
    assert.equal(state.currentUser.activeWorkspace.type, "private_coach");
    assert.equal(a.layoutDraft, draft, "declined: the moved layout is kept");

    prompts = answering(true);
    await handleWorkspaceAction(clubAction, handlers);
    assert.equal(prompts.length, 1);
    assert.deepEqual(writes().map((c) => [c.method, c.url]), [["PUT", "/api/auth/workspace"]]);
    assert.equal(changed, 1);
    assert.equal(state.currentUser.activeWorkspace.type, "club");
    assert.equal(state.trainingLoad.analysis.layoutDraft, null, "switched: Training Load starts over for the new workspace");
  } finally {
    window.confirm = () => true;
  }
});

test("H4: an unsaved Advanced settings change is protected from a workspace switch too", async () => {
  try {
    const a = await withUnsavedWidgetChange();
    const prompts = answering(false);
    await handleWorkspaceAction({ dataset: { action: "workspace-select", workspaceType: "club", workspaceScopeId: "club-1" } }, { onWorkspaceChanged: async () => {}, confirmLeave: askLeave });
    assert.deepEqual(prompts, ["Discard your unsaved widget changes?"]);
    assert.deepEqual(writes(), [], "declined: no PUT /api/auth/workspace");
    assert.equal(a.editor.draft.title, "Unsaved title");
  } finally {
    window.confirm = () => true;
  }
});

test("H4 (review LOW): accepting the question but failing the request loses nothing - a refused workspace switch and a notification whose mark-read fails keep the draft", async () => {
  try {
    let a = await withMovedWidget();
    const draft = a.layoutDraft;
    calls.length = 0;
    failing = (call) => (call.url === "/api/auth/workspace" ? { status: 404, error: "WORKSPACE_NOT_AVAILABLE" } : null);
    let prompts = answering(true);
    let changed = 0;
    await handleWorkspaceAction({ dataset: { action: "workspace-select", workspaceType: "club", workspaceScopeId: "club-1" } }, { onWorkspaceChanged: async () => { changed += 1; }, confirmLeave: askLeave });
    assert.equal(prompts.length, 1);
    assert.equal(changed, 0);
    assert.equal(state.currentUser.activeWorkspace.type, "private_coach");
    assert.equal(state.workspaceSwitcher.error, "That workspace is no longer available.");
    assert.equal(a.layoutDraft, draft, "the switch failed: the moved layout is still there");
    assert.equal(a.editMode, true);

    a = await withUnsavedWidgetChange();
    failing = (call) => (call.url === "/api/notifications/n1/read" ? { status: 500, error: "serverError" } : null);
    prompts = answering(true);
    const opened = [];
    await assert.rejects(handleNotificationAction({ dataset: { action: "notification-open-tests-today", notificationId: "n1" } }, notificationHandlers(opened)));
    assert.equal(prompts.length, 1);
    assert.deepEqual(opened, [], "nothing opened");
    assert.equal(a.editor.open, true, "mark-read failed: the widget draft is still there");
    assert.equal(a.editor.draft.title, "Unsaved title");
  } finally {
    window.confirm = () => true;
  }
});

test("H4: app.js hands the ask-only question to both handlers and the discard to the notifications", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(app, /const askLeaveTrainingLoad = \(\) => confirmLeaveTrainingLoad\(null, \{ discard: false \}\);/);
  assert.match(app, /handleWorkspaceAction\(action, \{[^}]*confirmLeave: askLeaveTrainingLoad[^}]*\}\)/);
  assert.match(app, /handleNotificationAction\(action, \{[^}]*confirmLeave: askLeaveTrainingLoad, discardLeave: discardTrainingLoadLeaveDrafts[^}]*\}\)/);
});

// -------------------- 2. readable labels --------------------

function optionsOf(html, action) {
  const select = html.match(new RegExp(`<select data-action="training-load-analysis-${action}"[^>]*>([\\s\\S]*?)</select>`));
  assert.ok(select, `${action} select is rendered`);
  return [...select[1].matchAll(/<option value="([^"]*)" (selected)?\s*>([^<]*)<\/option>/g)].map((m) => [m[1], m[3], Boolean(m[2])]);
}
function selectTag(html, action) {
  return html.match(new RegExp(`<select data-action="training-load-analysis-${action}"[^>]*>`))[0];
}

test("H4: a catalog metric's source, values included and total coverage show readable labels; the stored values stay the same and a choice stores the raw value", async () => {
  const a = await withUnsavedWidgetChange(widget({ series: [row({ built_in_series_key: null, metric_definition_id: metricId, source_policy: "manual", aggregation_role_policy: "standalone_only", coverage_policy: "any", analytical_aggregation: "sum" })] }));
  const html = renderTrainingLoadAnalysisHtml();
  assert.deepEqual(optionsOf(html, "series-source"), [
    ["all_with_conflicts", "All sources", false],
    ["manual", "Manual entry only", true],
    ["api_import", "API import only", false],
    ["csv_import", "CSV import only", false],
    ["derived", "Calculated values only", false],
  ]);
  assert.deepEqual(optionsOf(html, "series-role"), [
    ["standalone_only", "Direct values only", true],
    ["standalone_and_source_rollup", "Direct values and source totals", false],
    ["all_including_derived", "Direct values, source totals and calculated totals", false],
  ]);
  assert.deepEqual(optionsOf(html, "series-coverage"), [
    ["complete_only", "Complete totals only", false],
    ["complete_and_partial", "Complete and partial totals", false],
    ["any", "All totals, also unknown coverage", true],
  ]);
  assert.deepEqual(optionsOf(html, "series-aggregation").map((o) => o[1]), ["Total", "Average", "Maximum", "Latest value", "Raw values"]);
  assert.deepEqual(optionsOf(html, "series-axis").map((o) => o[1]), ["Primary", "Secondary"]);
  assert.match(html, /<small>Primary axis<\/small>/);
  for (const action of ["series-source", "series-role", "series-coverage"]) assert.doesNotMatch(selectTag(html, action), /disabled/, `${action} is editable for a catalog metric`);
  assert.match(html, /Direct value: recorded as it is, not a total\./);
  assert.match(html, /shows a conflict instead of adding them up/);
  assert.match(html, /Direct values are kept by every total coverage choice\./, "review LOW: coverage never filters direct values - said out loud");
  assert.doesNotMatch(html, />(all_with_conflicts|standalone_and_source_rollup|complete_and_partial|previous_period)</, "no raw stored value is shown as a label");

  const key = a.editor.draft.series[0].key;
  await act("series-role", { seriesKey: key }, "all_including_derived");
  await act("series-coverage", { seriesKey: key }, "complete_only");
  await act("series-source", { seriesKey: key }, "derived");
  assert.deepEqual(
    [a.editor.draft.series[0].fields.aggregationRolePolicy, a.editor.draft.series[0].fields.coveragePolicy, a.editor.draft.series[0].fields.sourcePolicy],
    ["all_including_derived", "complete_only", "derived"],
  );
});

test("H4: for a built-in metric the three source filters are shown but disabled, with a note - the query engine does not apply them", async () => {
  await withUnsavedWidgetChange();
  const html = renderTrainingLoadAnalysisHtml();
  for (const action of ["series-source", "series-role", "series-coverage"]) assert.match(selectTag(html, action), /disabled/, `${action} is disabled for a built-in`);
  assert.deepEqual(optionsOf(html, "series-source"), [["not_applicable", "Not used for built-in metrics", true]]);
  assert.match(html, /Source, values included and total coverage don&#39;t apply to built-in metrics\.|Source, values included and total coverage don't apply to built-in metrics\./);
  assert.doesNotMatch(html, /Direct value: recorded as it is/);
});

test("H4: the KPI comparison shows readable period labels", async () => {
  await withUnsavedWidgetChange(widget({ widget_type: "kpi", series: [row({ comparison_period: "previous_year" })] }));
  const html = renderTrainingLoadAnalysisHtml();
  assert.deepEqual(optionsOf(html, "series-comparison"), [
    ["", "None", false],
    ["previous_period", "Previous period of the same length", false],
    ["previous_year", "Same dates last year", true],
  ]);
});

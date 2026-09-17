// Dashboards UX H3 (feature/training-load-dashboards-ux-h3): the advanced
// per-series editor ("Advanced settings") is STAGED - every control only
// changes editor.draft, "Save changes" applies the difference through the
// existing widget/series endpoints in a trigger-safe order, and a failed or
// half-finished save never loses or duplicates anything (the draft is
// rebased on the reloaded widget). The requests go to a small in-memory
// fake of the dashboard widget/series API that enforces the same revision,
// series-cap, built-in-scope, one-unit-per-axis (line/bar), text-aggregation,
// comparison-only-on-KPI and type-change rules as the v16/v17 triggers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  body: { classList: { contains: () => false } },
};
globalThis.window = {
  confirm: () => true,
  prompt: () => { throw new Error("window.prompt must not be used by Dashboards"); },
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  removeEventListener() {},
};

const { closeTrainingLoadAnalysisOverlay, confirmLeaveTrainingLoad, handleTrainingLoadAction, setTrainingLoadAnalysisEditorText } = await import("../training-load-actions.js");
const { BUILT_IN_FIXED_SCOPE, analysisEditorPlan, analysisEditorProblem } = await import("../training-load-analysis-data.js");
const { renderTrainingLoadAnalysisHtml } = await import("../training-load-analysis-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");

const dashboardId = "11111111-1111-4111-8111-111111111111";
const widgetId = "55555555-5555-4555-8555-555555555555";
const seriesA = "77777777-7777-4777-8777-777777777777";
const seriesB = "88888888-8888-4888-8888-888888888888";
const metricId = "99999999-9999-4999-8999-999999999999";
const BASE = `/api/training-load/dashboards/${dashboardId}`;
const WIDGET_URL = `${BASE}/widgets/${widgetId}`;
const CAPS = { kpi: 1, table: 12, line_chart: 8, bar_chart: 8 };
const SHARED_AXIS = new Set(["line_chart", "bar_chart"]);
const UNITS = { rpe: null, srpe: "AU", duration_minutes: "min", session_count: null, last_session_date: null };
const unitOf = (s) => (s.built_in_series_key ? UNITS[s.built_in_series_key] : s.metric_definition_id ? "cm" : undefined);
const axisConflict = (type, candidate, others) => SHARED_AXIS.has(type) && unitOf(candidate) !== undefined
  && others.some((o) => o.id !== candidate.id && o.axis === candidate.axis && unitOf(o) !== undefined && unitOf(o) !== unitOf(candidate));
const seriesRefused = (type, candidate, others) => axisConflict(type, candidate, others)
  || (candidate.built_in_series_key === "last_session_date" && !["last", "none"].includes(candidate.analytical_aggregation))
  || (candidate.comparison_period && type !== "kpi");

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

// In-memory widget/series API. `onCall(call)` may return a response to inject
// ({ status, body }) or "network" (the request fails before reaching the
// server); `loseResponse(call)` makes a request COMMIT and then fail without
// a status (a lost response).
let calls;
function installServer(initial, { onCall = () => null, loseResponse = () => false } = {}) {
  const w = structuredClone(initial);
  let nextId = 1;
  calls = [];
  const ok = (body, status = 200) => ({ status, body });
  const refuse = (status, error) => ({ status, body: { error } });
  const handle = (call) => {
    if (call.url.startsWith("/api/training-load/dashboards?")) return ok({ dashboards: [dashboard()] });
    if (call.url === "/api/training-load/dashboards/active") return ok({ activeDashboard: { dashboard_id: dashboardId } });
    if (call.url === BASE && call.method === "GET") return ok({ dashboard: dashboard(), widgets: [structuredClone(w)] });
    if (call.url === `${BASE}/query`) return ok({ dashboardRevision: 3, widgets: [] });
    if (call.url.startsWith("/api/training-load/metrics/definitions")) return ok({ rows: [{ id: metricId, key: "jump_height", label: "Jump height", unit: "cm", value_type: "number", scope_capabilities: ["session"] }], nextCursor: null });
    if (call.url.startsWith("/api/training-load/metrics/")) return ok({ rows: [] });
    const body = call.body || {};
    const stale = () => body.expectedWidgetRevision !== w.revision;
    if (call.url === WIDGET_URL && call.method === "PATCH") {
      if (stale()) return refuse(409, "staleRevision");
      const type = body.widgetType ?? w.widget_type;
      if (w.series.length > CAPS[type]) return refuse(400, "invalidRequest");
      if (type !== "kpi" && w.series.some((s) => s.comparison_period)) return refuse(400, "invalidRequest");
      if (w.series.some((s) => axisConflict(type, s, w.series))) return refuse(400, "invalidRequest");
      if (body.title !== undefined) w.title = body.title;
      w.widget_type = type;
      if (body.groupBy !== undefined) w.group_by = body.groupBy;
      if (body.localFilterOverride !== undefined) w.local_filter_override = body.localFilterOverride;
      w.revision += 1;
      return ok({ widget: { widget_id: w.id, widget_revision: w.revision } });
    }
    if (call.url === `${WIDGET_URL}/series` && call.method === "POST") {
      if (stale()) return refuse(409, "staleRevision");
      if (w.series.length >= CAPS[w.widget_type]) return refuse(400, "invalidRequest");
      const scope = body.dataScopeLevel ?? "session";
      if (body.builtInSeriesKey && BUILT_IN_FIXED_SCOPE[body.builtInSeriesKey] !== scope) return refuse(400, "invalidRequest");
      const id = `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
      const candidate = row({
        id, series_order: body.seriesOrder, built_in_series_key: body.builtInSeriesKey ?? null, metric_definition_id: body.metricDefinitionId ?? null,
        template_metric_key_hints: body.templateMetricKeyHints ?? null,
        resolution_status: body.builtInSeriesKey || body.metricDefinitionId ? "resolved" : "unresolved",
        display_label: body.displayLabel ?? null, axis: body.axis ?? "primary", color: body.color ?? null,
        source_policy: body.sourcePolicy ?? (body.builtInSeriesKey ? "not_applicable" : "all_with_conflicts"),
        data_scope_level: scope, analytical_aggregation: body.analyticalAggregation ?? "sum",
        aggregation_role_policy: body.aggregationRolePolicy ?? "standalone_and_source_rollup", coverage_policy: body.coveragePolicy ?? "complete_and_partial",
        comparison_period: body.comparisonPeriod ?? null,
      });
      if (seriesRefused(w.widget_type, candidate, w.series)) return refuse(400, "invalidRequest");
      nextId += 1;
      w.series.push(candidate);
      w.revision += 1;
      return ok({ seriesId: id, widgetRevision: w.revision }, 201);
    }
    if (call.url === `${WIDGET_URL}/series/reorder` && call.method === "PUT") {
      if (stale()) return refuse(409, "staleRevision");
      for (const entry of body.order) {
        const s = w.series.find((item) => item.id === entry.seriesId);
        if (!s) return refuse(400, "invalidRequest");
        s.series_order = entry.seriesOrder;
      }
      w.revision += 1;
      return ok({ widgetRevision: w.revision });
    }
    const match = call.url.match(new RegExp(`^${WIDGET_URL}/series/([^/]+)(/resolve)?$`));
    if (match) {
      const s = w.series.find((item) => item.id === match[1]);
      if (!s) return refuse(400, "invalidRequest");
      if (stale()) return refuse(409, "staleRevision");
      if (match[2]) {
        if (s.resolution_status === "resolved") return refuse(400, "invalidRequest");
        const candidate = { ...s, metric_definition_id: body.metricDefinitionId, resolution_status: "resolved" };
        if (seriesRefused(w.widget_type, candidate, w.series)) return refuse(400, "invalidRequest");
        Object.assign(s, candidate);
      } else if (call.method === "DELETE") {
        w.series = w.series.filter((item) => item !== s);
      } else if (call.method === "PATCH") {
        const columns = { displayLabel: "display_label", axis: "axis", color: "color", dataScopeLevel: "data_scope_level", analyticalAggregation: "analytical_aggregation", sourcePolicy: "source_policy", aggregationRolePolicy: "aggregation_role_policy", coveragePolicy: "coverage_policy", comparisonPeriod: "comparison_period" };
        const candidate = { ...s };
        for (const [key, value] of Object.entries(body)) if (columns[key]) candidate[columns[key]] = value;
        if (seriesRefused(w.widget_type, candidate, w.series)) return refuse(400, "invalidRequest");
        Object.assign(s, candidate);
      }
      w.revision += 1;
      return ok({ seriesId: s.id, widgetRevision: w.revision });
    }
    return refuse(404, "notFound");
  };
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const injected = onCall(call);
    if (injected === "network") throw new TypeError("Failed to fetch");
    const result = injected || handle(call);
    if (!injected && loseResponse(call)) throw new TypeError("Failed to fetch");
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
  return w;
}

const writes = () => calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/query"));
function fakeAction(dataset, value = "") { return { dataset, value }; }
let renders = 0;
function renderTrainingLoad() { renders += 1; }
const act = (action, dataset = {}, value = "") => handleTrainingLoadAction(fakeAction({ action: `training-load-analysis-${action}`, ...dataset }, value), { renderTrainingLoad });

async function openEditor(initial, options) {
  clearAllViewCache();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "private_coach", scopeId: "coach-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  state.trainingLoad.section = "analysis";
  state.activeTab = "training-load";
  const server = installServer(initial, options);
  const a = state.trainingLoad.analysis;
  a.dashboards = [dashboard()];
  a.selectedDashboardId = dashboardId;
  a.dashboard = dashboard();
  a.widgets = [structuredClone(initial)];
  a.period = { dateFrom: "2026-09-01", dateTo: "2026-09-17" };
  await act("open-advanced", { widgetId });
  calls.length = 0;
  return { a, server, editor: () => a.editor, draft: () => a.editor.draft };
}
const entryAt = (draft, index) => draft.series[index];

// -------------------- staging --------------------

test("H3: every editor control only changes the draft - no request until Save; Cancel with changes asks, a clean Cancel does not", async () => {
  const { a, editor, draft } = await openEditor(widget({ series: [row(), row({ id: seriesB, series_order: 2, built_in_series_key: "srpe", analytical_aggregation: "sum" })] }));
  assert.equal(editor().open, true);
  const keyA = entryAt(draft(), 0).key;
  await act("widget-title", { widgetId }, "Readiness");
  await act("widget-type", { widgetId }, "line_chart");
  await act("widget-group", { widgetId }, "week");
  await act("series-aggregation", { seriesKey: keyA }, "max");
  await act("series-label", { seriesKey: keyA }, "  My RPE  ");
  assert.equal(entryAt(draft(), 0).fields.displayLabel, "My RPE", "labels are trimmed");
  await act("series-bind-builtin", { seriesKey: keyA, builtInKey: "duration_minutes" });
  await act("add-series", { widgetId });
  await act("series-up", { seriesKey: entryAt(draft(), 2).key });
  await act("delete-series", { seriesKey: entryAt(draft(), 0).key });
  assert.equal(writes().length, 0, "nothing is sent while editing");
  assert.equal(draft().title, "Readiness");
  assert.deepEqual(draft().removedIds, [seriesA], "a removed saved series is remembered for Save");
  assert.match(renderTrainingLoadAnalysisHtml(), /Unsaved changes/);

  const prompts = [];
  try {
    window.confirm = (message) => { prompts.push(message); return false; };
    await act("close-editor");
    assert.deepEqual(prompts, ["Discard your unsaved widget changes?"]);
    assert.equal(editor().open, true, "declined: still editing");
    window.confirm = (message) => { prompts.push(message); return true; };
    await act("close-editor");
    assert.equal(editor().open, false);
    assert.equal(writes().length, 0);

    await act("open-advanced", { widgetId });
    await act("close-editor");
    assert.equal(prompts.length, 2, "a clean editor closes without a question");
    assert.equal(a.editor.open, false);
  } finally {
    window.confirm = () => true;
  }
});

test("H3: Title and Label typed per keystroke go into the draft without a re-render, and the change on blur does not re-render either (so the Save click is never lost)", async () => {
  const { draft } = await openEditor(widget());
  const key = entryAt(draft(), 0).key;
  renders = 0;
  setTrainingLoadAnalysisEditorText({ value: "Weekly load", dataset: { tlEditorField: "title" } });
  setTrainingLoadAnalysisEditorText({ value: " Team RPE ", dataset: { tlEditorField: "label", seriesKey: key } });
  assert.equal(draft().title, "Weekly load");
  assert.equal(entryAt(draft(), 0).fields.displayLabel, "Team RPE");
  await act("widget-title", { widgetId }, "Weekly load");
  await act("series-label", { seriesKey: key }, " Team RPE ");
  assert.equal(renders, 0, "blur after typing: no re-render");
  await act("widget-title", { widgetId }, "Other");
  assert.equal(renders, 1, "a genuinely different value still renders");

  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const inputBranch = app.indexOf("if (trainingLoadInput.dataset.tlEditorField) {");
  const genericReturn = app.indexOf('if (trainingLoadInput.dataset.action.startsWith("training-load-analysis-")) return;');
  assert.ok(inputBranch > 0 && inputBranch < genericReturn, "app.js routes editor text fields per keystroke before the generic 'apply on change' return");
  assert.match(renderTrainingLoadAnalysisHtml(), /data-action="training-load-analysis-editor-save" >Save changes</, "Save is enabled (it validates itself) so a click after typing is never swallowed by a disabled button");
});

// -------------------- saving --------------------

test("H3: Save applies the difference in a trigger-safe order with the returned widget revision threaded through, then ONE reload + query, and closes", async () => {
  const { a, server, editor, draft } = await openEditor(widget({ series: [row(), row({ id: seriesB, series_order: 2, built_in_series_key: "srpe", analytical_aggregation: "sum" })] }));
  const keyA = entryAt(draft(), 0).key;
  await act("delete-series", { seriesKey: entryAt(draft(), 1).key });
  await act("series-aggregation", { seriesKey: keyA }, "max");
  await act("widget-title", { widgetId }, "Readiness");
  const newKey = (await act("add-series", { widgetId }), draft().series[1].key);
  await act("series-bind-builtin", { seriesKey: newKey, builtInKey: "duration_minutes" });
  await act("series-up", { seriesKey: newKey });

  await act("editor-save");
  const steps = writes().map((c) => `${c.method} ${c.url.replace(WIDGET_URL, "W")} rev${c.body.expectedWidgetRevision}`);
  // series changes before the widget PATCH (the type-change trigger checks
  // the series present at that moment), new series after it
  assert.deepEqual(steps, [
    `DELETE W/series/${seriesB} rev4`,
    `PATCH W/series/${seriesA} rev5`,
    "PATCH W rev6",
    "POST W/series rev7",
    "PUT W/series/reorder rev8",
  ]);
  const post = writes()[3].body;
  assert.equal(post.builtInSeriesKey, "duration_minutes");
  assert.equal(post.sourcePolicy, "not_applicable");
  assert.equal(post.seriesOrder, 3, "appended after the highest existing slot");
  assert.deepEqual(writes()[1].body, { expectedWidgetRevision: 5, analyticalAggregation: "max" }, "only the changed field");
  assert.deepEqual(writes()[4].body.order.map((o) => o.seriesId), [server.series.find((s) => s.built_in_series_key === "duration_minutes").id, seriesA]);
  assert.equal(calls.filter((c) => c.url.endsWith("/query")).length, 1);
  assert.equal(editor().open, false);
  assert.equal(a.notice, "Widget settings saved.");
  assert.equal(server.title, "Readiness");
  assert.deepEqual(server.series.sort((l, r) => l.series_order - r.series_order).map((s) => s.built_in_series_key), ["duration_minutes", "rpe"]);
});

test("H3: changing a series' metric below the type's cap ADDS the new series first and removes the previous one afterwards, keeping its slot", async () => {
  const { server, draft } = await openEditor(widget({ series: [row(), row({ id: seriesB, series_order: 2, built_in_series_key: "srpe" })] }));
  await act("series-bind-builtin", { seriesKey: entryAt(draft(), 0).key, builtInKey: "session_count" });
  await act("editor-save");
  const steps = writes().map((c) => `${c.method} ${c.url.replace(WIDGET_URL, "W")}`);
  assert.deepEqual(steps, ["POST W/series", `DELETE W/series/${seriesA}`, "PUT W/series/reorder"]);
  assert.equal(writes()[0].body.dataScopeLevel, "day", "a built-in is posted at its catalog-fixed level");
  assert.deepEqual(server.series.sort((l, r) => l.series_order - r.series_order).map((s) => s.built_in_series_key), ["session_count", "srpe"]);
});

test("H3: at the cap (a KPI's single series) the previous series is DELETEd first; if the new one is refused it is put back exactly as it was - the editor stays open, says so, and keeps the change for a retry", async () => {
  const { server, editor, draft } = await openEditor(widget({ widget_type: "kpi", series: [row({ color: "#123456", display_label: "Team RPE" })] }), {
    onCall: (call) => (call.method === "POST" && call.body?.metricDefinitionId ? { status: 400, body: { error: "invalidRequest" } } : null),
  });
  await act("series-bind-metric", { seriesKey: entryAt(draft(), 0).key, metricId });
  await act("editor-save");
  const steps = writes().map((c) => `${c.method} ${c.url.replace(WIDGET_URL, "W")}`);
  assert.deepEqual(steps, [`DELETE W/series/${seriesA}`, "POST W/series", "POST W/series"]);
  const restore = writes()[2].body;
  assert.equal(restore.builtInSeriesKey, "rpe");
  assert.equal(restore.color, "#123456");
  assert.equal(restore.displayLabel, "Team RPE");
  assert.equal(server.series.length, 1, "the widget keeps a metric");
  assert.equal(server.series[0].built_in_series_key, "rpe");
  assert.equal(editor().open, true);
  assert.match(editor().error, /previous one was put back unchanged/);
  assert.equal(entryAt(draft(), 0).id, server.series[0].id, "the draft points at the restored row");
  assert.equal(entryAt(draft(), 0).metric.kind, "metric", "the wanted change is still staged");
  assert.match(renderTrainingLoadAnalysisHtml(), /data-action="training-load-analysis-close-editor" >Close</, "something was written: Cancel reads Close");
});

test("H3: an add whose response is LOST is recognised after the reload - Save again never posts a second copy", async () => {
  let lose = true;
  const { server, editor, draft } = await openEditor(widget(), {
    loseResponse: (call) => call.method === "POST" && call.url.endsWith("/series") && lose,
  });
  await act("add-series", { widgetId });
  await act("series-bind-builtin", { seriesKey: entryAt(draft(), 1).key, builtInKey: "srpe" });
  await act("editor-save");
  assert.equal(server.series.length, 2, "the POST committed");
  assert.equal(editor().open, true);
  assert.match(editor().error, /Could not confirm whether the last change was saved/);
  assert.equal(entryAt(draft(), 1).id, server.series[1].id, "the reload adopted the landed series");
  lose = false;
  calls.length = 0;
  await act("editor-save");
  assert.equal(writes().filter((c) => c.method === "POST").length, 0, "no second POST");
  assert.equal(server.series.length, 2);
  assert.equal(editor().open, false, "nothing is left to save - the editor closes");
});

test("H3: a refusal half-way keeps what was saved, rebases the rest and offers Save again - which finishes without repeating the saved steps", async () => {
  let refuse = true;
  const { server, editor, draft } = await openEditor(widget({ series: [row(), row({ id: seriesB, series_order: 2, built_in_series_key: "srpe" })] }), {
    onCall: (call) => (refuse && call.method === "PATCH" && call.url === WIDGET_URL ? { status: 400, body: { error: "invalidRequest" } } : null),
  });
  await act("delete-series", { seriesKey: entryAt(draft(), 1).key });
  await act("widget-title", { widgetId }, "Readiness");
  await act("series-coverage", { seriesKey: entryAt(draft(), 0).key }, "any");
  await act("editor-save");
  assert.deepEqual(writes().map((c) => `${c.method} ${c.url.replace(WIDGET_URL, "W")}`), [`DELETE W/series/${seriesB}`, `PATCH W/series/${seriesA}`, "PATCH W"]);
  assert.equal(server.series.length, 1);
  assert.equal(server.series[0].coverage_policy, "any", "the series change before the refusal is kept");
  assert.equal(server.title, "Load", "the refused widget PATCH changed nothing");
  assert.equal(editor().open, true);
  assert.match(editor().error, /refused one of the changes/);
  assert.deepEqual(draft().removedIds, [], "the removal is done - nothing left to remove");
  const remaining = analysisEditorPlan(state.trainingLoad.analysis.widgets[0], draft());
  assert.deepEqual(remaining.map((op) => op.type), ["patchWidget"], "only the refused change is still pending");

  refuse = false;
  calls.length = 0;
  await act("editor-save");
  assert.deepEqual(writes().map((c) => `${c.method} ${c.url.replace(WIDGET_URL, "W")}`), ["PATCH W"]);
  assert.equal(server.title, "Readiness");
  assert.equal(editor().open, false);
});

test("H3: a catalog metric for an unresolved template series is bound with resolve (same row), not replaced", async () => {
  const template = row({ built_in_series_key: null, source_policy: "all_with_conflicts", resolution_status: "unresolved", template_metric_key_hints: [{ key: "jump_height" }] });
  const { server, draft } = await openEditor(widget({ series: [template] }));
  await act("series-bind-metric", { seriesKey: entryAt(draft(), 0).key, metricId });
  await act("editor-save");
  assert.deepEqual(writes().map((c) => `${c.method} ${c.url.replace(WIDGET_URL, "W")}`), [`POST W/series/${seriesA}/resolve`]);
  assert.equal(server.series[0].id, seriesA);
  assert.equal(server.series[0].metric_definition_id, metricId);
});

test("H3: moving a KPI with a comparison to a chart clears the comparison BEFORE the type change (the DB refuses it otherwise)", async () => {
  const { server, draft } = await openEditor(widget({ widget_type: "kpi", series: [row({ comparison_period: "previous_period" })] }));
  await act("widget-type", { widgetId }, "bar_chart");
  assert.equal(entryAt(draft(), 0).fields.comparisonPeriod, null, "the draft drops the comparison with the type");
  assert.doesNotMatch(renderTrainingLoadAnalysisHtml(), /training-load-analysis-series-comparison/, "no comparison control for a chart");
  await act("editor-save");
  assert.deepEqual(writes().map((c) => `${c.method} ${c.url.replace(WIDGET_URL, "W")}`), [`PATCH W/series/${seriesA}`, "PATCH W"]);
  assert.equal(server.widget_type, "bar_chart");
});

// -------------------- validation --------------------

test("H3: problems are caught before any request - too many series for the type, an empty title; a built-in's data level is shown fixed", async () => {
  const { editor, draft } = await openEditor(widget({ series: [row(), row({ id: seriesB, series_order: 2, built_in_series_key: "srpe" })] }));
  await act("widget-type", { widgetId }, "kpi");
  assert.match(analysisEditorProblem(draft()), /A KPI widget holds at most 1 series - remove 1/);
  await act("editor-save");
  assert.equal(writes().length, 0);
  assert.match(editor().error, /holds at most 1 series/);
  await act("widget-type", { widgetId }, "table");
  setTrainingLoadAnalysisEditorText({ value: "   ", dataset: { tlEditorField: "title" } });
  await act("editor-save");
  assert.equal(writes().length, 0);
  assert.equal(editor().error, "Give the widget a title.");
  assert.match(renderTrainingLoadAnalysisHtml(), /data-action="training-load-analysis-series-scope"[^>]*disabled[^>]*>[\s\S]*?Fixed for this built-in metric/);
});

test("H3 (H1 fix): the guided panel posts Session count at its catalog-fixed DAY level - it used to send 'session' and the server refused it", async () => {
  const { a } = await openEditor(widget());
  await act("close-editor");
  calls.length = 0;
  await act("add-widget");
  await act("panel-pick-builtin", { builtInKey: "session_count" });
  assert.equal(a.metricPanel.scope, "day");
  await act("panel-field", { field: "scope" }, "session");
  assert.equal(a.metricPanel.scope, "day", "a built-in's data level can't be changed in the panel either");
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (call.method === "POST" && call.url === `${BASE}/widgets`) return { ok: true, status: 201, json: async () => ({ widgetId: "w-new" }) };
    if (call.method === "POST") return { ok: true, status: 201, json: async () => ({ seriesId: "s-new", widgetRevision: 2 }) };
    return { ok: true, status: 200, json: async () => ({ dashboards: [], dashboard: dashboard(), widgets: [], rows: [] }) };
  };
  await act("panel-save");
  const seriesPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/series"));
  assert.equal(seriesPost.body.builtInSeriesKey, "session_count");
  assert.equal(seriesPost.body.dataScopeLevel, "day");
});

// -------------------- protection --------------------

test("H3: unsaved widget changes are protected like an unsaved layout - Escape and leaving Training Load ask first; declined keeps the editor and its draft", async () => {
  const { editor, draft } = await openEditor(widget());
  await act("series-aggregation", { seriesKey: entryAt(draft(), 0).key }, "max");
  const prompts = [];
  try {
    window.confirm = (message) => { prompts.push(message); return false; };
    assert.equal(closeTrainingLoadAnalysisOverlay(), false, "Escape declined: nothing closed");
    assert.equal(confirmLeaveTrainingLoad("tests"), false, "leaving declined");
    assert.equal(editor().open, true);
    assert.equal(entryAt(draft(), 0).fields.analyticalAggregation, "max");
    assert.deepEqual(prompts, ["Discard your unsaved widget changes?", "Discard your unsaved widget changes?"]);
    window.confirm = (message) => { prompts.push(message); return true; };
    assert.equal(confirmLeaveTrainingLoad("tests"), true);
    assert.equal(editor().open, false);
    assert.equal(writes().length, 0);
  } finally {
    window.confirm = () => true;
  }
});

// -------------------- code-reviewer round 1 (H3) --------------------

test("H3 (review HIGH): changing a series' metric to another unit on a bar chart is saved - delete first, since the axis may hold one unit only", async () => {
  const { a, server, editor, draft } = await openEditor(widget({ widget_type: "bar_chart", series: [row()] }));
  await act("series-bind-builtin", { seriesKey: entryAt(draft(), 0).key, builtInKey: "srpe" });
  await act("editor-save");
  assert.deepEqual(writes().map((c) => `${c.method} ${c.url.replace(WIDGET_URL, "W")}`), [`DELETE W/series/${seriesA}`, "POST W/series"]);
  assert.deepEqual(server.series.map((s) => s.built_in_series_key), ["srpe"]);
  assert.equal(editor().open, false);
  assert.equal(a.notice, "Widget settings saved.");
});

test("H3 (review HIGH, H1 panel too): the guided panel's metric change on a line chart deletes first as well", async () => {
  const { a, server } = await openEditor(widget({ widget_type: "line_chart", title: "Load", series: [row()] }));
  await act("close-editor");
  calls.length = 0;
  await act("edit-widget", { widgetId });
  await act("panel-pick-builtin", { builtInKey: "srpe" });
  await act("panel-save");
  assert.deepEqual(writes().map((c) => `${c.method} ${c.url.replace(WIDGET_URL, "W")}`), [`DELETE W/series/${seriesA}`, "POST W/series"]);
  assert.deepEqual(server.series.map((s) => s.built_in_series_key), ["srpe"]);
  assert.equal(a.metricPanel, null);
});

test("H3 (review HIGH): a retry after a stale revision never reverts what someone else changed - only the coach's own edits are sent, and a series deleted elsewhere is not brought back", async () => {
  const { server, editor, draft } = await openEditor(widget({ series: [row(), row({ id: seriesB, series_order: 2, built_in_series_key: "srpe" })] }));
  // another tab: rename, change B's coverage, then delete B
  server.title = "Team load";
  server.series[0].color = "#abcdef";
  server.series = server.series.filter((s) => s.id !== seriesB);
  server.revision += 3;
  await act("series-aggregation", { seriesKey: entryAt(draft(), 0).key }, "max");
  await act("editor-save");
  assert.match(editor().error, /changed on the server/);
  assert.equal(draft().title, "Team load", "an untouched title follows the server");
  assert.equal(entryAt(draft(), 0).fields.color, "#abcdef", "an untouched setting follows the server");
  assert.equal(entryAt(draft(), 0).fields.analyticalAggregation, "max", "the coach's own change stays");
  assert.deepEqual(draft().series.map((e) => e.id), [seriesA], "the untouched series deleted elsewhere is not re-added");
  calls.length = 0;
  await act("editor-save");
  assert.deepEqual(writes().map((c) => `${c.method} ${c.url.replace(WIDGET_URL, "W")}`), [`PATCH W/series/${seriesA}`]);
  assert.deepEqual(writes()[0].body, { expectedWidgetRevision: 7, analyticalAggregation: "max" });
  assert.equal(server.title, "Team load");
  assert.equal(server.series[0].color, "#abcdef");
  assert.equal(editor().open, false);
});

test("H3 (review MEDIUM): KPI with a comparison -> bar chart with a new metric saves in one go; table -> line chart with a unit-changing replace too", async () => {
  let ctx = await openEditor(widget({ widget_type: "kpi", series: [row({ comparison_period: "previous_period" })] }));
  await act("widget-type", { widgetId }, "bar_chart");
  await act("series-bind-builtin", { seriesKey: entryAt(ctx.draft(), 0).key, builtInKey: "srpe" });
  await act("editor-save");
  assert.equal(ctx.editor().open, false, ctx.editor().error);
  assert.equal(ctx.server.widget_type, "bar_chart");
  assert.deepEqual(ctx.server.series.map((s) => [s.built_in_series_key, s.comparison_period]), [["srpe", null]]);

  ctx = await openEditor(widget({ series: [row(), row({ id: seriesB, series_order: 2, built_in_series_key: "srpe" })] }));
  await act("widget-type", { widgetId }, "line_chart");
  await act("series-bind-builtin", { seriesKey: entryAt(ctx.draft(), 1).key, builtInKey: "session_count" });
  await act("editor-save");
  assert.equal(ctx.editor().open, false, ctx.editor().error);
  assert.equal(ctx.server.widget_type, "line_chart");
  assert.deepEqual(ctx.server.series.sort((l, r) => l.series_order - r.series_order).map((s) => s.built_in_series_key), ["rpe", "session_count"]);
});

test("H3 (review MEDIUM): turning a comparison on while changing the type to KPI is applied after the type change", async () => {
  const { server, editor, draft } = await openEditor(widget({ widget_type: "table", series: [row()] }));
  await act("widget-type", { widgetId }, "kpi");
  await act("series-comparison", { seriesKey: entryAt(draft(), 0).key }, "previous_period");
  await act("editor-save");
  assert.equal(editor().open, false, editor().error);
  assert.deepEqual(writes().map((c) => `${c.method} ${c.url.replace(WIDGET_URL, "W")}`), ["PATCH W", `PATCH W/series/${seriesA}`]);
  assert.equal(server.series[0].comparison_period, "previous_period");
});

test("H3 (review MEDIUM): a text metric (Last session) is set to an aggregation it supports, and a mismatch is explained before any request", async () => {
  const { server, editor, draft } = await openEditor(widget());
  await act("add-series", { widgetId });
  const key = entryAt(draft(), 1).key;
  await act("series-bind-builtin", { seriesKey: key, builtInKey: "last_session_date" });
  assert.equal(entryAt(draft(), 1).fields.analyticalAggregation, "last");
  assert.equal(entryAt(draft(), 1).fields.dataScopeLevel, "day");
  await act("series-aggregation", { seriesKey: key }, "avg");
  assert.match(analysisEditorProblem(draft()), /Last session date can only show the latest value or raw values/);
  await act("editor-save");
  assert.equal(writes().length, 0);
  await act("series-aggregation", { seriesKey: key }, "last");
  await act("editor-save");
  assert.equal(editor().open, false, editor().error);
  assert.equal(server.series.find((s) => s.built_in_series_key === "last_session_date").analytical_aggregation, "last");
});

test("H3 (review): one unit per axis on a chart is checked before any request - moving the series to the other axis makes it valid", async () => {
  const { server, editor, draft } = await openEditor(widget({ widget_type: "line_chart", series: [row()] }));
  await act("add-series", { widgetId });
  const key = entryAt(draft(), 1).key;
  await act("series-bind-builtin", { seriesKey: key, builtInKey: "duration_minutes" });
  assert.match(analysisEditorProblem(draft()), /Series on the primary axis must share one unit - move Duration to the other axis/);
  await act("editor-save");
  assert.equal(writes().length, 0);
  await act("series-axis", { seriesKey: key }, "secondary");
  assert.equal(analysisEditorProblem(draft()), "");
  await act("editor-save");
  assert.equal(editor().open, false, editor().error);
  assert.deepEqual(server.series.map((s) => [s.built_in_series_key, s.axis]), [["rpe", "primary"], ["duration_minutes", "secondary"]]);
});

test("H3 (review LOW): saving a widget that was deleted elsewhere reloads and says so", async () => {
  let gone = false;
  const { editor, draft } = await openEditor(widget(), {
    onCall: (call) => {
      if (call.method === "PATCH") { gone = true; return { status: 404, body: { error: "notFound" } }; }
      if (gone && call.method === "GET" && call.url === BASE) return { status: 200, body: { dashboard: dashboard(), widgets: [] } };
      return null;
    },
  });
  await act("series-aggregation", { seriesKey: entryAt(draft(), 0).key }, "max");
  await act("editor-save");
  const patchAt = calls.findIndex((c) => c.method === "PATCH");
  assert.ok(calls.slice(patchAt).some((c) => c.method === "GET" && c.url === BASE), "the dashboard was reloaded after the 404");
  assert.equal(editor().error, "This widget no longer exists - close the editor.");
});

test("H3 (re-review MEDIUM): line chart -> table with a unit-changing replace saves in one go - the type changes first when it leaves the shared axis", async () => {
  const { server, editor, draft } = await openEditor(widget({ widget_type: "line_chart", series: [row(), row({ id: seriesB, series_order: 2, built_in_series_key: "session_count", data_scope_level: "day", analytical_aggregation: "sum" })] }));
  await act("widget-type", { widgetId }, "table");
  await act("series-bind-builtin", { seriesKey: entryAt(draft(), 0).key, builtInKey: "srpe" });
  await act("editor-save");
  assert.equal(editor().open, false, editor().error);
  assert.equal(server.widget_type, "table");
  assert.deepEqual(server.series.map((s) => s.built_in_series_key).sort(), ["session_count", "srpe"]);
  assert.equal(writes().filter((c) => c.method === "POST").length, 1, "no refused add and no restore");
  assert.equal(writes()[0].method === "PATCH" && writes()[0].url === WIDGET_URL, true, "the type change comes first");
});

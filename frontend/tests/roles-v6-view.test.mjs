// Roles V-6 (docs/ai/roles-v-steps-plan.md sections 2.7 and 13): what a view workspace (club_view / team_view) shows of
// Dashboards - Training Load -> Data & Analysis -> Dashboards only, read only, never a write control, and a per-athlete
// widget the server restricted as one sentence. Every route still decides again (backend/tests/roles-v-sweep.test.mjs
// test 8). Invented names only.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let state;
let renderTrainingLoadCoachHtml;
let renderTrainingLoadAnalysisHtml;
let buildDashboardWidgetDisplayModel;

const CLUB = "11111111-0000-4000-8000-0000000000c1";
const DASH = "33333333-0000-4000-8000-000000000001";
const WIDGET = "44444444-0000-4000-8000-000000000001";
const SERIES = "55555555-0000-4000-8000-000000000001";
const CLUB_VIEW = { type: "club_view", scopeId: CLUB, label: "Test Club", role: "role_holder" };
const CLUB_WS = { type: "club", scopeId: CLUB, label: "Test Club" };
const as = (activeWorkspace, permissions) => {
  state.currentUser = { id: "u1", name: "Viewer A", activeWorkspace, availableWorkspaces: [activeWorkspace], clubs: [], teams: [], permissions };
};
const render = (fn) => {
  const box = document.createElement("div");
  box.innerHTML = fn();
  return box;
};
const actions = (box) => [...box.querySelectorAll("[data-action]")].map((el) => el.getAttribute("data-action"));
const WRITE_ACTIONS = ["training-load-analysis-new-dashboard", "training-load-analysis-clone-template", "training-load-analysis-add-widget",
  "training-load-analysis-rename-dashboard", "training-load-analysis-set-active", "training-load-analysis-toggle-edit",
  "training-load-analysis-archive", "training-load-analysis-delete-dashboard"];

const widget = { id: WIDGET, widget_type: "table", title: "Load per athlete", widget_order: 1, x: 0, y: 0, width: 6, height: 4, mobile_order: 1,
  group_by: "athlete", state: "active", display_config: null, presentation_config: null, local_filter_override: null, revision: 1,
  series: [{ id: SERIES, widget_id: WIDGET, series_order: 1, metric_definition_id: null, built_in_series_key: "rpe", resolution_status: "resolved",
    axis: "primary", color: null, display_label: null, source_policy: "all_with_conflicts", source_connection_id: null, data_scope_level: "session",
    analytical_aggregation: "avg", aggregation_role_policy: "standalone_and_source_rollup", coverage_policy: "any", comparison_period: null }] };
const dashboard = (extra = {}) => ({ id: DASH, name: "Alpha board", description: "", owner_scope: "club", owner_club_id: CLUB, data_workspace_type: "club",
  data_workspace_scope_id: CLUB, is_template: false, status: "active", revision: 3, ...extra });
const restricted = { widgets: [{ widgetId: WIDGET, series: [{ widgetId: WIDGET, seriesId: SERIES, status: "restricted", error: "namedAthletesRequired", data: null }] }] };

before(async () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "MutationObserver", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  ({ state } = await import("../state.js"));
  ({ renderTrainingLoadCoachHtml } = await import("../training-load-view.js"));
  ({ renderTrainingLoadAnalysisHtml } = await import("../training-load-analysis-view.js"));
  ({ buildDashboardWidgetDisplayModel } = await import("../training-load-analysis-display-model.js"));
});

test("1. Training Load in a view workspace with dashboards.view: the Data & Analysis space with Dashboards only, no Schedule and no Filter; with variables.view too, Data configuration as well", () => {
  as(CLUB_VIEW, ["org.view", "dashboards.view"]);
  state.trainingLoad.section = "analysis";
  let box = render(renderTrainingLoadCoachHtml);
  assert.deepEqual([...box.querySelectorAll(".training-load-tab")].map((b) => b.textContent.trim()), ["Data & Analysis"]);
  assert.equal(box.querySelector(".training-load-tab").getAttribute("data-section"), "analysis");
  assert.deepEqual([...box.querySelectorAll(".training-load-subnav-tab")].map((b) => b.textContent.trim()), ["Dashboards"]);
  assert.equal(box.querySelector(".training-load-filter-button"), null);
  as(CLUB_VIEW, ["org.view", "dashboards.view", "variables.view"]);
  box = render(renderTrainingLoadCoachHtml);
  assert.deepEqual([...box.querySelectorAll(".training-load-tab")].map((b) => b.textContent.trim()), ["Data & Analysis", "Data configuration"]);
  // Without the word, the V-1 picture (no Data & Analysis).
  as(CLUB_VIEW, ["org.view", "variables.view"]);
  state.trainingLoad.section = "variables";
  box = render(renderTrainingLoadCoachHtml);
  assert.deepEqual([...box.querySelectorAll(".training-load-tab")].map((b) => b.textContent.trim()), ["Data configuration"]);
  // A coach workspace keeps every space and view.
  as(CLUB_WS, ["dashboards.view", "variables.view"]);
  state.trainingLoad.section = "analysis";
  box = render(renderTrainingLoadCoachHtml);
  assert.deepEqual([...box.querySelectorAll(".training-load-subnav-tab")].map((b) => b.textContent.trim()), ["Overview", "Activities", "Athletes", "Dashboards", "Imports"]);
});

test("2. the Dashboards view of a view workspace offers no write: no New dashboard, no template copy, no Add widget, no Rename, Set as active, Edit layout, Archive or Delete; a coach workspace keeps them", () => {
  const a = state.trainingLoad.analysis;
  const show = (ws, words, extra = {}) => {
    as(ws, words);
    Object.assign(a, { dashboards: [dashboard()], dashboard: dashboard(extra), selectedDashboardId: DASH, widgets: [widget], queryResult: restricted,
      picker: { ...a.picker, open: true, search: "" }, menu: "dashboard", editMode: false, pagesAvailable: false, listLoading: false });
    return actions(render(renderTrainingLoadAnalysisHtml));
  };
  const view = show(CLUB_VIEW, ["org.view", "dashboards.view"]);
  for (const action of WRITE_ACTIONS) assert.ok(!view.includes(action), `view: ${action}`);
  assert.ok(view.includes("training-load-analysis-print"), "the dashboard can still be exported");
  const template = show(CLUB_VIEW, ["org.view", "dashboards.view"], { is_template: true, owner_scope: "system", data_workspace_type: null });
  assert.ok(!template.includes("training-load-analysis-clone-template"), "a template is never copied from a view workspace");
  const coach = show(CLUB_WS, ["dashboards.view"]);
  for (const action of ["training-load-analysis-new-dashboard", "training-load-analysis-rename-dashboard", "training-load-analysis-set-active", "training-load-analysis-add-widget"]) {
    assert.ok(coach.includes(action), `coach: ${action}`);
  }
  // The empty state: Choose dashboard only.
  as(CLUB_VIEW, ["org.view", "dashboards.view"]);
  Object.assign(a, { dashboard: null, selectedDashboardId: "", widgets: [], queryResult: null, menu: "", picker: { ...a.picker, open: false } });
  const empty = actions(render(renderTrainingLoadAnalysisHtml));
  assert.ok(empty.includes("training-load-analysis-open-picker") && !empty.includes("training-load-analysis-new-dashboard"));
});

test("3. a widget the server restricted (namedAthletesRequired) reads as one sentence, never an empty table", () => {
  const model = buildDashboardWidgetDisplayModel(widget, restricted.widgets[0], {});
  assert.equal(model.status, "restricted");
  assert.deepEqual(model.reasons, ["namedAthletesRequired"]);
  const a = state.trainingLoad.analysis;
  as(CLUB_VIEW, ["org.view", "dashboards.view"]);
  Object.assign(a, { dashboard: dashboard(), selectedDashboardId: DASH, widgets: [widget], queryResult: restricted, menu: "", queryLoading: false, queryError: "",
    picker: { ...a.picker, open: false } });
  const box = render(renderTrainingLoadAnalysisHtml);
  const status = box.querySelector(`[data-analysis-widget-id="${WIDGET}"] [role="status"]`);
  assert.ok(status, "a status line");
  assert.equal(status.textContent.trim(), "This widget shows each athlete's values, which you can't see here.");
  assert.equal(box.querySelector(`[data-analysis-widget-id="${WIDGET}"] table`), null, "no table");
});

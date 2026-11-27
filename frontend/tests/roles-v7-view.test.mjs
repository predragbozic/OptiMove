// Roles V-7 (docs/ai/roles-v-steps-plan.md, "V-7 design"): what a view workspace (club_view / team_view) shows of
// Programs and Exercises - the Program Library (public templates, read only), an athlete's plan pages (with athletes.view
// too), and the system exercise library, read only. Never the Builder, never a write control. Every route still decides
// again (backend/tests/roles-v-sweep.test.mjs test 9). Invented names only.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let state;
let vm;
let renderAthleteListHtml;
let renderPlanMoreMenu;
let renderTemplatePreviewModalViewHtml;
let renderExerciseLibraryHtml;
let renderWeeklySwitcherHtml;

const CLUB = "11111111-0000-4000-8000-0000000000c1";
const CLUB_VIEW = { type: "club_view", scopeId: CLUB, label: "Test Club", role: "role_holder" };
const CLUB_WS = { type: "club", scopeId: CLUB, label: "Test Club", role: "club_admin" };
const ALL = ["org.view", "athletes.view", "programs.view", "exercises.use"];
const as = (activeWorkspace, permissions) => {
  state.currentUser = { id: "u1", name: "Viewer A", accessScope: "club", activeWorkspace, availableWorkspaces: [activeWorkspace], clubs: [], teams: [], permissions };
};
const WRITE_ACTIONS = /data-action="(template-assign|template-settings-toggle|template-use|template-review-toggle|template-access-bulk|builder-edit-plan|builder-duplicate-plan|builder-delete-source-plan|weekly-create-plan|exercise-add-open|exercise-edit-open|exercise-copy-open|exercise-delete|exercise-toggle-favorite|exercise-toggle-mark|exercise-tags|exercise-classification|exercise-hide|exercise-blocks-open|exercise-select-mode|exercise-archive|exercise-restore)"/;

before(async () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "MutationObserver", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  ({ state } = await import("../state.js"));
  vm = await import("../view-modules.js");
  ({ renderAthleteListHtml } = await import("../athlete-view.js"));
  ({ renderPlanMoreMenu } = await import("../plan-actions-view.js"));
  ({ renderTemplatePreviewModalViewHtml } = await import("../program-library-view.js"));
  ({ renderExerciseLibraryHtml } = await import("../exercise-library.js"));
  ({ renderWeeklySwitcherHtml } = await import("../weekly-k6.js"));
});

test("1. the places: programs.view opens the Program Library and an athlete's two plan pages, never the Builder; exercises.use opens the Exercise Library", () => {
  as(CLUB_VIEW, ["org.view", "programs.view"]);
  const hidden = vm.viewHiddenMenuSelectors();
  assert.equal(hidden.includes('[data-sidebar-submenu="program-library"]'), false, "the Program Library opens");
  assert.ok(hidden.includes('[data-library-tab="builder"]'), "the Builder stays hidden");
  assert.ok(hidden.includes('[data-library-tab="exercises"]'), "the Exercise Library needs its own word");
  for (const tab of ["templates", "weekly", "programs"]) assert.ok(vm.viewWorkspaceTabs().includes(tab), tab);
  assert.equal(vm.viewWorkspaceTabs().includes("builder"), false);
  as(CLUB_VIEW, ["org.view", "exercises.use"]);
  assert.equal(vm.viewHiddenMenuSelectors().includes('[data-library-tab="exercises"]'), false);
  assert.ok(vm.viewWorkspaceTabs().includes("exercises"));
  assert.ok(vm.viewHiddenMenuSelectors().includes('[data-sidebar-submenu="program-library"]'), "without programs.view no library");
  as(CLUB_VIEW, ["org.view"]);
  assert.ok(vm.viewHiddenMenuSelectors().includes('[data-library-tab="builder"]'));
});

test("2. an athlete opens its plan pages only with Programs open, and the row carries no plan counts", () => {
  const rows = [{ athlete_uuid: "a1", athlete_id: "17", athlete: "Mira Testova", athlete_image_url: "", weekly_plan_count: null, program_count: null }];
  const clickable = renderAthleteListHtml(rows, null, { noCounts: true });
  assert.ok(/<button class="athlete-button/.test(clickable), "a button to the athlete's plans");
  assert.equal(clickable.includes("athlete-counts"), false, "no counts");
  const coach = renderAthleteListHtml([{ ...rows[0], weekly_plan_count: 2, program_count: 1 }], null, {});
  assert.ok(coach.includes("2 weekly"), "a coach keeps the counts");
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /readOnly: isViewWorkspace\(\) && !viewModuleOpen\("programs"\), noCounts: isViewWorkspace\(\)/);
});

test("3. no plan or template menu (Edit, Copy, Delete) and no Plan it in the Builder in a view workspace; a coach keeps them", () => {
  as(CLUB_VIEW, ALL);
  for (const kind of ["template", "weekly", "program"]) assert.equal(renderPlanMoreMenu("p1", kind), "", kind);
  const flow = { origin: "calendar", listLabel: "" };
  const items = [{ key: "a", name: "Mira Testova" }, { key: "b", name: "Lena Probna" }];
  assert.equal(WRITE_ACTIONS.test(renderWeeklySwitcherHtml({ flow, items, currentKey: "a", noPlan: true })), false, "no Builder entry");
  as(CLUB_WS, ALL);
  assert.ok(renderPlanMoreMenu("p1", "weekly").includes("builder-edit-plan"));
  assert.ok(renderWeeklySwitcherHtml({ flow, items, currentKey: "a", noPlan: true }).includes("weekly-create-plan"));
});

const previewData = (overrides = {}) => ({
  currentUserRole: "club_admin",
  detail: {}, groups: [], isMicrocycle: false, athletes: [], programTagEditor: {}, templateOptions: {},
  renderNodeButton: () => "", renderProgramDayCard: () => "",
  selected: { plan_id: "t1", plan_name: "Vseven public template", creator_name: "Coach", can_assign_to_athlete: true, template_kind: "blocks" },
  preview: { open: true, loading: false, settingsOpen: true, assignOpen: true, reviews: [{ id: "r1", rating: 5, reviewer_name: "Coach" }], reviewsOpen: false },
  ...overrides,
});

test("4. a public template's preview is read only: no assign, library settings, editing menu, access requests or use; its reviews can be read", () => {
  as(CLUB_VIEW, ALL);
  const html = renderTemplatePreviewModalViewHtml(previewData());
  assert.ok(html.includes("Vseven public template"));
  assert.equal(WRITE_ACTIONS.test(html), false, html.match(WRITE_ACTIONS)?.[0]);
  assert.equal(html.includes("data-template-review-form"), false);
  assert.ok(html.includes('data-action="template-reviews-toggle"') && html.includes("Reviews (1)"), "the reviews can be opened");
  as(CLUB_WS, ALL);
  const coach = renderTemplatePreviewModalViewHtml(previewData());
  assert.ok(coach.includes('data-action="template-assign"') && coach.includes('data-action="template-settings-toggle"'), "a coach keeps them");
});

const libraryData = () => ({
  exercises: [{ id: "e1", name: "Vseven system squat", owner_scope: "system", is_active: true, can_edit: false, can_copy: false, is_favorite: false, is_hidden: false, tags: [] }],
  itemIds: new Map([["e1", "e1"]]), markedExerciseIds: new Set(), tagEditor: { open: false, tags: [] },
  search: { canManageCollections: false, view: "details", filters: {}, options: {}, lockedPreviews: [], term: "" },
});

test("5. the exercise library is read only: no add, edit, copy, favourite, mark, tag, classification, hide or block control; a coach keeps them", () => {
  as(CLUB_VIEW, ALL);
  for (const view of ["details", "tile", "big", "list"]) {
    const data = libraryData();
    data.search.view = view;
    const html = renderExerciseLibraryHtml(data);
    assert.ok(html.includes("Vseven system squat"), view);
    assert.equal(WRITE_ACTIONS.test(html), false, `${view}: ${html.match(WRITE_ACTIONS)?.[0]}`);
  }
  const empty = libraryData();
  empty.exercises = [];
  assert.equal(WRITE_ACTIONS.test(renderExerciseLibraryHtml(empty)), false, "the empty state offers no Add");
  as(CLUB_WS, [...ALL, "exercises.add", "exercises.remove"]);
  const coach = renderExerciseLibraryHtml(libraryData());
  assert.ok(coach.includes('data-action="exercise-add-open"') && coach.includes('data-action="exercise-toggle-favorite"'));
});

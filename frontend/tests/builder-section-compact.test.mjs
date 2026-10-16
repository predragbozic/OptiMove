import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The section editor on phones and landscape phones: one row for search,
// Tile / Big / List and Filters; the filters folded behind the Filters
// button (its badge counts every active filter); a "+ Add custom exercise"
// link; Sets / Reps / Load always in view; 44 px buttons on the exercise
// cards; 16 px fields on touch screens.

// #content is a fake whose section editor exists only while a test opens it.
const editor = { open: false, panel: null, toggle: null };
const fakeContent = { querySelector: (selector) => (selector === ".builder-section-panel" && editor.open ? editor.panel : null) };
globalThis.document = { querySelector: (selector) => (selector === "#content" ? fakeContent : null), querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { renderBuilderSectionOverlay, renderBuilderFiltersToggle, builderFiltersToggleState } = await import("../builder-section.js");
const { renderBuilderFiltersChange } = await import("../builder-view.js");
const { handleBuilderWorkspaceAction } = await import("../builder-actions.js");
const { state, emptyExerciseFilters } = await import("../state.js");

const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const node = { id: "s1", type: "section", name: "Mobility", note: "", items: [{ id: "i1", exerciseId: "e1", title: "Squat", sets: "3", reps: "8", load: "", description: "" }, { id: "i2", exerciseId: "e2", title: "Lunge", sets: "", reps: "", load: "", description: "" }] };

function fakeToggle() {
  const attributes = {};
  return { className: "", innerHTML: "", setAttribute: (name, value) => { attributes[name] = value; }, getAttribute: (name) => attributes[name] };
}

// The @media blocks whose query is exactly `query`, joined.
function mediaBlock(query) {
  const blocks = [];
  for (let start = css.indexOf(`@media ${query} {`); start !== -1; start = css.indexOf(`@media ${query} {`, start + 1)) {
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { blocks.push(css.slice(start, i + 1)); break; }
    }
  }
  assert.ok(blocks.length, `no @media ${query} block`);
  return blocks.join("\n");
}

beforeEach(() => {
  state.builder.exerciseFilters = emptyExerciseFilters();
  state.builder.exerciseFiltersOpen = false;
  state.builder.exercises = [];
  state.builder.mobileMode = "add";
  editor.open = false;
});

test("1. search, view and Filters share one row; the filters sit in their own panel; the link and Sets / Reps / Load are there", () => {
  const html = renderBuilderSectionOverlay(state, node);
  const toolbar = html.slice(html.indexOf('<div class="builder-library-toolbar">'), html.indexOf('<div class="builder-filters-panel"'));
  assert.match(toolbar, /data-builder-exercise-search/);
  assert.match(toolbar, /class="exercise-view-switcher"/);
  assert.match(toolbar, /data-action="builder-toggle-exercise-filters" aria-expanded="false" aria-controls="builder-exercise-filters-panel"/);
  assert.match(html, /<div class="builder-filters-panel" id="builder-exercise-filters-panel">[\s\S]*data-builder-exercise-filter="favorite"[\s\S]*builder-custom-exercise-button/);
  assert.match(html, /data-filters-open="false"/);
  assert.match(html, /<button class="text-action builder-custom-exercise-link" type="button" data-action="builder-open-custom-exercise">\+ Add custom exercise<\/button>/);
  const controls = html.slice(html.indexOf('<div class="builder-library-controls">'), html.indexOf("builder-exercise-results"));
  assert.match(controls, /data-builder-new-dose name="sets" placeholder="e\.g\. 3"/, "Sets / Reps / Load stay with the pinned controls, never folded");
  state.builder.exerciseFiltersOpen = true;
  assert.match(renderBuilderSectionOverlay(state, node), /data-filters-open="true"[\s\S]*aria-expanded="true"/);
});

test("2. the Filters badge counts every active filter - Purpose, Tag, Favorites, Marked and the more filters", () => {
  assert.doesNotMatch(renderBuilderFiltersToggle(emptyExerciseFilters(), false), /filter-count-badge|has-active-filters/);
  const filters = { ...emptyExerciseFilters(), purpose: "Mobility", tag: "warm-up", favorite: true, marked: true, bodyPart: "Hip" };
  const html = renderBuilderFiltersToggle(filters, false);
  assert.match(html, /class="plain-button builder-filters-toggle has-active-filters"/);
  assert.match(html, /aria-label="Filters \(5 active\)"/);
  assert.match(html, /<span class="filter-count-badge">5<\/span>/);
});

test("3. the Filters button folds and unfolds the panel without a full repaint, and falls back to one outside the editor", async () => {
  const calls = [];
  const handlers = { renderBuilder: () => calls.push("renderBuilder"), renderBuilderFiltersChange: () => { calls.push("filters"); return true; } };
  const action = { dataset: { action: "builder-toggle-exercise-filters" } };
  assert.equal(await handleBuilderWorkspaceAction(action, handlers), true);
  assert.equal(state.builder.exerciseFiltersOpen, true);
  await handleBuilderWorkspaceAction(action, handlers);
  assert.equal(state.builder.exerciseFiltersOpen, false);
  assert.deepEqual(calls, ["filters", "filters"]);
  await handleBuilderWorkspaceAction(action, { renderBuilder: () => calls.push("renderBuilder"), renderBuilderFiltersChange: () => false });
  assert.equal(calls.at(-1), "renderBuilder");
});

test("4. the repaint patches the same Filters button (focus stays on it) and the panel's open mark", () => {
  assert.equal(renderBuilderFiltersChange(), false, "no section editor open");
  const toggle = fakeToggle();
  editor.panel = { dataset: { filtersOpen: "false" }, querySelector: (selector) => (selector === ".builder-filters-toggle" ? toggle : null) };
  editor.open = true;
  state.builder.exerciseFiltersOpen = true;
  state.builder.exerciseFilters = { ...emptyExerciseFilters(), favorite: true };
  assert.equal(renderBuilderFiltersChange(), true);
  const expected = builderFiltersToggleState(state.builder.exerciseFilters, true);
  assert.equal(editor.panel.dataset.filtersOpen, "true");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.getAttribute("aria-label"), "Filters (1 active)");
  assert.equal(toggle.className, expected.className);
  assert.equal(toggle.innerHTML, expected.inner);
});

test("5. a changed filter updates the Filters badge at once (app.js), before the results reload", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /builderFilter\.type === "checkbox" \? builderFilter\.checked : builderFilter\.value;\s*renderBuilderFiltersChange\(\);\s*debounceBuilderSearch\(\);/);
  assert.match(app, /handleBuilderWorkspaceAction\(action, \{[^}]*renderBuilderFiltersChange[^}]*\}\)/);
});

test("6. phones and landscape phones: the folded panel, the link, and a search that widens over the row without moving anything below", () => {
  const compact = mediaBlock("(max-width: 560px), (max-height: 520px)");
  assert.match(compact, /\.builder-section-panel\[data-filters-open="false"\] \.builder-filters-panel \{ display: none; \}/);
  assert.match(compact, /\.builder-custom-exercise-link \{ display: inline-flex;/);
  assert.match(compact, /\.builder-section-library \.builder-custom-exercise-button \{ display: none; \}/);
  // Laid over the row (absolute), never a change of the row's height: the
  // earlier focus-driven reflow made the first tap on Add miss.
  // Filters (48 px + the 6 px gap) stays visible, pinned to the row's end.
  assert.match(compact, /\.builder-library-toolbar \.builder-exercise-search:focus-within \{ position: absolute; inset: 0 54px 0 0; z-index: 3; \}/);
  assert.match(compact, /\.builder-filters-toggle \{[^}]*margin-left: auto;/);
  assert.match(compact, /\.builder-library-toolbar \{ position: relative;/);
  assert.match(compact, /\.builder-filters-toggle \{[^}]*width: 48px; height: 48px;/);
  // The panel is the only way to filter on a phone: its moved controls get 44 px too.
  assert.match(compact, /\.builder-filters-panel \.exercise-filter-toggle \{ min-height: 44px; \}/);
  assert.match(compact, /\.builder-filters-panel \.exercise-filter-toggle-icon \{ width: 44px; min-height: 44px; \}/);
  assert.match(compact, /\.builder-filters-panel \.exercise-filter-field input,\s*\.builder-filters-panel \.exercise-filter-field select \{ height: 44px; min-height: 44px; \}/);
  assert.match(css, /\.builder-filters-toggle, \.builder-custom-exercise-link \{ display: none; \}/, "hidden on a large screen");
  const landscape = mediaBlock("(min-width: 561px) and (max-height: 520px)");
  assert.match(landscape, /\.builder-library-controls \{ position: sticky;/);
  // An open filter panel would make the pinned block taller than the editor.
  assert.match(landscape, /\.builder-section-panel\[data-filters-open="true"\] \.builder-library-controls \{ position: static; \}/);
});

test("6b. the header rules reach only the section editor - other dialogs share .builder-section-panel-head", () => {
  assert.match(css, /\.builder-section-modal \.builder-section-panel-head > div:first-child > \.eyebrow \{ display: none; \}/);
  assert.match(css, /\.builder-section-modal \.builder-section-panel-head > div:first-child \{ padding-right: 52px; \}/);
  assert.match(css, /\.builder-section-modal \.builder-section-panel-head \.muted \{ display: none; \}/);
  assert.doesNotMatch(css, /^\s*\.builder-section-panel-head > div:first-child > \.eyebrow/m);
  assert.doesNotMatch(css, /^\s*\.builder-section-panel-head > div:first-child \{ padding-right/m);
  assert.doesNotMatch(css, /^\s*\.builder-section-panel-head \.muted \{ display: none; \}/m);
});

test("6c. Enter in the search (the keyboard's Search key) only puts the field away", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /els\.content\.addEventListener\("keydown", handleBuilderSearchKeydown\);/);
  assert.match(app, /function handleBuilderSearchKeydown\(event\) \{\s*if \(event\.key !== "Enter" \|\| !event\.target\.matches\?\.\("\[data-builder-exercise-search\]"\)\) return;\s*event\.preventDefault\(\);\s*event\.target\.blur\(\);\s*\}/);
  assert.match(renderBuilderSectionOverlay(state, node), /data-builder-exercise-search type="search" enterkeyhint="search"/);
});

test("7. touch screens: 44 px buttons on the phone card and the section header, 16 px Sets / Reps / Load and Instruction", () => {
  const touch = mediaBlock("(max-width: 760px), (pointer: coarse)");
  assert.match(touch, /\.builder-section-panel \.builder-dose-inputs input \{ font-size: 16px; min-height: 44px; \}/);
  assert.match(touch, /\.builder-section-modal \.builder-section-panel-head \.builder-icon-action, \.builder-section-close-button \{ width: 44px; height: 44px; min-width: 44px; \}/);
  assert.match(touch, /\.builder-section-panel input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\), \.builder-section-panel select, \.builder-section-panel textarea \{ font-size: 16px; \}/, "every field of the editor, not only some");
  assert.match(touch, /\.builder-section-cancel-button, \.builder-section-finish-button \{ min-height: 44px; \}/);
  assert.match(touch, /\.builder-mobile-sticky-bar \.text-action, \.builder-add-confirmation \.text-action \{[^}]*min-width: 44px; min-height: 44px;/);
  assert.match(css, /@media \(max-width: 760px\), \(pointer: coarse\) \{\s*textarea\[data-autogrow\] \{ font-size: 16px; \}/);
  assert.match(css, /\.builder-added-card \.builder-icon-action \{\s*width: 44px;\s*height: 44px;/);
  assert.match(css, /\.builder-added-card-dose-inputs input \{\s*padding: 6px 7px;\s*font-size: 16px;/);
  assert.match(css, /\.builder-added-card\.builder-item > \.builder-added-card-top \{\s*display: contents;/, "beats the generic .builder-item > div:first-child flex head");
});

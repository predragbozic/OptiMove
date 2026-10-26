import { after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// The Exercise Library's typed filter fields (Purpose, Tag and the ones under
// More filters) render into the view toolbar (#viewToolbar), outside #content
// where app.js listens for typing. Typing or picking a suggestion there must
// still set the filter and read the list again - the same way the Builder's
// fields inside #content do.

const dom = new JSDOM(`<!doctype html><body><section id="viewToolbar"></section><section id="content"></section></body>`);
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.Event = dom.window.Event;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const searches = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const address = new URL(String(url), "http://app.test");
  if (address.pathname === "/api/exercises/options") {
    return { ok: true, status: 200, json: async () => ({ purposes: ["Strength", "Speed"], qualities: [], groups: ["Upper body"], bodyParts: [], movementPatterns: [], startingPositions: [], places: [], complexities: [], attractors: [], tags: ["Warm-up"] }) };
  }
  if (address.pathname === "/api/exercises") {
    searches.push(Object.fromEntries(address.searchParams));
    return { ok: true, status: 200, json: async () => ({ exercises: [], hasMore: false }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
after(() => { globalThis.fetch = originalFetch; });

const { readFileSync } = await import("node:fs");
const { loadExercises } = await import("../exercise-actions.js");
const { renderExerciseFilterControls, renderExerciseQuickFilters, syncExerciseFilterSearch } = await import("../exercise-library.js");
const { state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
// Every time the list is shown again - read from the server or, for a filter
// set seen before, from the view cache.
let renders = 0;
const handlers = { setLoading: () => {}, renderExercises: () => { renders += 1; } };

function typedField(key) {
  const hidden = document.querySelector(`#viewToolbar [data-exercise-filter="${key}"]`);
  assert.ok(hidden, `the ${key} filter is in the toolbar`);
  return { hidden, field: hidden.closest(".exercise-filter-field").querySelector("[data-exercise-filter-search]") };
}

async function type(field, text) {
  field.value = text;
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  await settle();
  await settle();
}

async function openLibrary() {
  clearAllViewCache();
  searches.length = 0;
  for (const key of Object.keys(state.exerciseSearch.filters)) state.exerciseSearch.filters[key] = typeof state.exerciseSearch.filters[key] === "boolean" ? false : "";
  await loadExercises(handlers);
  await settle();
  assert.equal(searches.length, 1, "the library's first read");
}

test("typing an option's name into a toolbar filter field sets the filter and reads the list with it", async () => {
  await openLibrary();
  const { hidden, field } = typedField("purpose");
  await type(field, "Strength");
  assert.equal(hidden.value, "Strength");
  assert.equal(state.exerciseSearch.filters.purpose, "Strength");
  assert.equal(searches.at(-1)?.purpose, "Strength", "the list is read with the filter");
});

test("the typed name matches an option whatever its case and spaces, and the option's own spelling is sent", async () => {
  await openLibrary();
  const { field } = typedField("purpose");
  await type(field, "  strength ");
  assert.equal(state.exerciseSearch.filters.purpose, "Strength");
  assert.equal(searches.at(-1)?.purpose, "Strength");
});

test("a filter under More filters (Exercise group) and the Tag field work the same way", async () => {
  await openLibrary();
  await type(typedField("group").field, "upper body");
  assert.equal(state.exerciseSearch.filters.group, "Upper body");
  assert.equal(searches.at(-1)?.group, "Upper body");
  await type(typedField("tag").field, "Warm-up");
  assert.equal(state.exerciseSearch.filters.tag, "Warm-up");
  assert.equal(searches.at(-1)?.tag, "Warm-up");
});

test("text that names no option clears the filter once, and further typing shows the list no more", async () => {
  await openLibrary();
  const { field } = typedField("purpose");
  await type(field, "Strength");
  const afterPick = renders;
  await type(field, "Strengt");
  assert.equal(state.exerciseSearch.filters.purpose, "", "no option named: no filter");
  assert.equal(renders, afterPick + 1, "the list is shown once without the filter");
  await type(field, "Streng");
  await type(field, "");
  assert.equal(renders, afterPick + 1, "nothing more while the filter stays empty");
});

test("syncExerciseFilterSearch leaves a field without its hidden twin alone", () => {
  const holder = document.createElement("label");
  holder.className = "exercise-filter-field";
  holder.innerHTML = `<input type="search" data-exercise-filter-search value="x">`;
  assert.doesNotThrow(() => syncExerciseFilterSearch(holder.querySelector("input")));
});

test("a filter whose value is no longer offered stays on the hidden twin and is cleared by the first keystroke naming no option", async () => {
  clearAllViewCache();
  for (const key of Object.keys(state.exerciseSearch.filters)) state.exerciseSearch.filters[key] = typeof state.exerciseSearch.filters[key] === "boolean" ? false : "";
  state.exerciseSearch.filters.tag = "Gone";
  await loadExercises(handlers);
  await settle();
  const { hidden, field } = typedField("tag");
  assert.equal(field.value, "", "the text shows no option");
  assert.equal(hidden.value, "Gone", "the applied filter is kept");
  await type(field, "w");
  assert.equal(state.exerciseSearch.filters.tag, "", "the stale filter is gone");
});

// The Builder renders the same fields inside #content, where app.js's
// handleContentInput hands typing to syncExerciseFilterSearch and
// handleContentChange writes the hidden twin's value into
// state.builder.exerciseFilters. app.js runs the whole app when imported, so
// its two branches are read from its source and the same wiring is attached
// here to the Builder's own markup.
const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
function branch(marker, length = 400) {
  const start = appSource.indexOf(marker);
  assert.ok(start >= 0, `app.js has ${marker}`);
  return appSource.slice(start, start + length);
}

test("Builder: app.js hands typing to syncExerciseFilterSearch and writes the hidden twin's change into the Builder's filters", () => {
  assert.match(branch('event.target.closest("[data-exercise-filter-search]")', 200), /syncExerciseFilterSearch\(exerciseFilterSearch\);\s*return;/);
  assert.match(branch('event.target.closest("[data-builder-exercise-filter]")', 300), /state\.builder\.exerciseFilters\[builderFilter\.dataset\.builderExerciseFilter\] =\s*builderFilter\.type === "checkbox" \? builderFilter\.checked : builderFilter\.value;/);
  const contentListener = appSource.indexOf('els.content.addEventListener("input", handleContentInput)');
  assert.ok(contentListener >= 0 && appSource.indexOf('els.content.addEventListener("change", handleContentChange)') >= 0, "both are delegated on #content");
});

test("Builder: typing in its Purpose field sets the filter once; typing on without naming an option sends one clearing change only", () => {
  const content = document.querySelector("#content");
  const options = { purposes: ["Strength", "Speed"], qualities: [], groups: ["Upper body"], bodyParts: [], movementPatterns: [], startingPositions: [], places: [], complexities: [], attractors: [], tags: ["Warm-up"] };
  const builderFilters = { purpose: "", group: "", tag: "", favorite: false, marked: false };
  content.innerHTML = renderExerciseQuickFilters(builderFilters, options, "data-builder-exercise-filter", renderExerciseFilterControls(builderFilters, options, "builder-selects"));
  const changes = [];
  const onInput = (event) => {
    const field = event.target.closest("[data-exercise-filter-search]");
    if (field) syncExerciseFilterSearch(field);
  };
  const onChange = (event) => {
    const control = event.target.closest("[data-builder-exercise-filter]");
    if (!control) return;
    builderFilters[control.dataset.builderExerciseFilter] = control.type === "checkbox" ? control.checked : control.value;
    changes.push(control.value);
  };
  content.addEventListener("input", onInput);
  content.addEventListener("change", onChange);
  try {
    const field = content.querySelector('[data-builder-exercise-filter="purpose"]').closest(".exercise-filter-field").querySelector("[data-exercise-filter-search]");
    for (const text of [" strength ", "strength"]) {
      field.value = text;
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    assert.equal(builderFilters.purpose, "Strength");
    assert.deepEqual(changes, ["Strength"], "one change for the option, none for the same option again");
    for (const text of ["x", "xy", ""]) {
      field.value = text;
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    assert.equal(builderFilters.purpose, "");
    assert.deepEqual(changes, ["Strength", ""], "one clearing change while no option is named");
    const group = content.querySelector('[data-builder-exercise-filter="group"]').closest(".exercise-filter-field").querySelector("[data-exercise-filter-search]");
    group.value = "UPPER BODY";
    group.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(builderFilters.group, "Upper body", "a More filters field of the Builder");
  } finally {
    content.removeEventListener("input", onInput);
    content.removeEventListener("change", onChange);
    content.innerHTML = "";
  }
});

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const results = { innerHTML: "", scrollTop: 0 };
const button = { disabled: false };
globalThis.document = {
  querySelector: (selector) => selector === ".builder-exercise-results" ? results : button,
  querySelectorAll: () => [],
};
const { state, emptyBuilderState } = await import("../state.js");
const { loadBuilderExercises } = await import("../builder-data.js");
const { handleBuilderWorkspaceAction } = await import("../builder-actions.js");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

const exercises = Array.from({ length: 40 }, (_, index) => ({ id: `ex-${index}`, name: `Squat variation ${index}` }));
let calls;
const response = (data) => ({ ok: true, json: async () => data });
beforeEach(() => {
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ exerciseQuery: "Squat" });
  state.exerciseSearch.options.purposes = ["Strength"];
  state.markedExerciseIds = new Set();
  results.innerHTML = "";
  results.scrollTop = 0;
  calls = [];
  globalThis.fetch = async (path) => {
    const url = new URL(path, "http://localhost");
    if (url.pathname === "/api/exercises/visible-marked") return response({ ids: [...state.markedExercises.keys()] });
    calls.push(url);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    const matches = exercises.filter((exercise) => exercise.name.includes(url.searchParams.get("search")));
    return response({ exercises: matches.slice(offset, offset + limit), hasMore: offset + limit < matches.length });
  };
});

test("all matches beyond the first 18 are reachable and keep search/filter context", async () => {
  state.builder.exerciseFilters.purpose = "Strength";
  await loadBuilderExercises();
  assert.equal(state.builder.exercises.length, 18);
  assert.match(results.innerHTML, /builder-load-more-exercises/);
  results.scrollTop = 250;
  await handleBuilderWorkspaceAction({ dataset: { action: "builder-load-more-exercises" } }, { loadBuilderExercises });
  assert.equal(state.builder.exercises.length, 36);
  assert.equal(results.scrollTop, 250);
  await loadBuilderExercises({ append: true });
  assert.deepEqual(state.builder.exercises, exercises);
  assert.equal(state.builder.exerciseHasMore, false);
  assert.doesNotMatch(results.innerHTML, /builder-load-more-exercises/);
  assert.deepEqual(calls.map((url) => url.searchParams.get("offset")), ["0", "18", "36"]);
  assert.ok(calls.every((url) => url.searchParams.get("search") === "Squat" && url.searchParams.get("purpose") === "Strength"));
});

test("changing the search replaces previous pages and starts at offset zero", async () => {
  await loadBuilderExercises();
  await loadBuilderExercises({ append: true });
  state.builder.exerciseQuery = "Squat variation 39";
  await loadBuilderExercises();
  assert.deepEqual(state.builder.exercises, [exercises[39]]);
  assert.equal(calls.at(-1).searchParams.get("offset"), "0");
  assert.equal(state.builder.exerciseHasMore, false);
});

test("changing a filter starts a new page and prevents appending old results", async () => {
  await loadBuilderExercises();
  state.builder.exerciseFilters.purpose = "Strength";
  await loadBuilderExercises({ append: true });
  assert.equal(calls.length, 1);
  await loadBuilderExercises();
  assert.equal(calls.at(-1).searchParams.get("offset"), "0");
  assert.equal(calls.at(-1).searchParams.get("purpose"), "Strength");
  assert.equal(state.builder.exercises.length, 18);
});

test("marked-only local results do not repeat with server pagination", async () => {
  state.builder.exerciseFilters.marked = true;
  state.markedExercises = new Map([[exercises[39].id, exercises[39]]]);
  await loadBuilderExercises();
  assert.deepEqual(state.builder.exercises, [exercises[39]]);
  assert.equal(state.builder.exerciseHasMore, false);
  await loadBuilderExercises({ append: true });
  assert.equal(calls.length, 1);
});

test("late page response cannot overwrite a newer query", async () => {
  await loadBuilderExercises();
  let resolvePage;
  const searchFetch = globalThis.fetch;
  globalThis.fetch = (path) => new URL(path, "http://localhost").searchParams.get("offset") === "18"
    ? new Promise((resolve) => { resolvePage = resolve; }) : searchFetch(path);
  const pending = loadBuilderExercises({ append: true });
  await Promise.resolve();
  state.builder.exerciseQuery = "Squat variation 39";
  await loadBuilderExercises();
  resolvePage(response({ exercises: exercises.slice(18, 36), hasMore: true }));
  await pending;
  assert.deepEqual(state.builder.exercises, [exercises[39]]);
  assert.equal(state.builder.exerciseLoading, false);
});

test("double clicks do not fetch the same page twice; failed pages can be retried", async () => {
  await loadBuilderExercises();
  let rejectPage;
  const searchFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve, reject) => { rejectPage = reject; });
  const pending = loadBuilderExercises({ append: true });
  await Promise.resolve();
  await loadBuilderExercises({ append: true });
  rejectPage(new Error("Network error"));
  await assert.rejects(pending, /Network error/);
  assert.equal(state.builder.exerciseOffset, 18);
  assert.equal(button.disabled, false);
  globalThis.fetch = searchFetch;
  await loadBuilderExercises({ append: true });
  assert.equal(state.builder.exercises.length, 36);
});

test("new searches abort the previous fetch without surfacing a cancellation error", async () => {
  let previousSignal;
  const searchFetch = globalThis.fetch;
  globalThis.fetch = (path, options) => {
    if (new URL(path, "http://localhost").searchParams.get("search") === "Squat") {
      previousSignal = options.signal;
      return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Canceled", "AbortError")), { once: true }));
    }
    return searchFetch(path);
  };
  const oldSearch = loadBuilderExercises();
  state.builder.exerciseQuery = "Squat variation 39";
  await loadBuilderExercises();
  await oldSearch;
  assert.equal(previousSignal.aborted, true);
  assert.deepEqual(state.builder.exercises, [exercises[39]]);
  assert.equal(state.builder.exerciseLoading, false);
});

test("search starts without waiting for filter options", async () => {
  state.exerciseSearch.options.purposes = [];
  let resolveOptions;
  const searchFetch = globalThis.fetch;
  let searchStarted = false;
  globalThis.fetch = (path) => {
    if (path === "/api/exercises/options") return new Promise((resolve) => { resolveOptions = resolve; });
    searchStarted = true;
    return searchFetch(path);
  };
  const loading = loadBuilderExercises();
  assert.equal(searchStarted, true);
  resolveOptions(response({ purposes: ["Strength"] }));
  await loading;
  assert.equal(state.builder.exercises.length, 18);
});

test("loading exercises without an open section does not rebuild the Builder", async () => {
  const originalQuerySelector = document.querySelector;
  document.querySelector = (selector) => selector === ".builder-exercise-results" ? null : button;
  button.innerHTML = "Existing Builder";
  try {
    await loadBuilderExercises();
    assert.equal(button.innerHTML, "Existing Builder");
    assert.equal(state.builder.exercises.length, 18);
  } finally { document.querySelector = originalQuerySelector; }
});

test("landscape phones: a new search brings the scrolled section editor back to the library's top; a page added with Load more does not", async () => {
  // The library starts 120 px down the editor's scroll content.
  const modal = { scrollTop: 900, getBoundingClientRect: () => ({ top: 10 }) };
  const library = { getBoundingClientRect: () => ({ top: 10 + 120 - modal.scrollTop }) };
  results.closest = (selector) => ({ ".builder-section-modal": modal, ".builder-section-library": library })[selector] || null;
  let overflowY = "visible";
  globalThis.getComputedStyle = () => ({ overflowY });
  try {
    await loadBuilderExercises();
    assert.equal(modal.scrollTop, 120, "back to the library's top, the first results under the pinned search row");
    modal.scrollTop = 900;
    await loadBuilderExercises({ append: true });
    assert.equal(modal.scrollTop, 900, "Load more keeps the place");
    modal.scrollTop = 60;
    await loadBuilderExercises();
    assert.equal(modal.scrollTop, 60, "not scrolled past the library: left alone");
    overflowY = "auto";
    modal.scrollTop = 900;
    await loadBuilderExercises();
    assert.equal(modal.scrollTop, 900, "phones upright and desktop: the results list scrolls itself, the editor is left alone");
    assert.equal(results.scrollTop, 0);
  } finally {
    delete results.closest;
    delete globalThis.getComputedStyle;
  }
});

test("with nothing shown yet a search says it is loading, a failed one says so with Try again (never 'No matching exercises.'), and Try again loads again", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path) => { await gate; return realFetch(path); };
  const pending = loadBuilderExercises();
  assert.match(results.innerHTML, /Loading exercises…/);
  assert.doesNotMatch(results.innerHTML, /No matching exercises/);
  release();
  await pending;
  assert.equal(state.builder.exercises.length, 18);

  state.builder = emptyBuilderState({ exerciseQuery: "Squat" });
  results.innerHTML = "";
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "Server error" }) });
  await assert.rejects(loadBuilderExercises());
  assert.equal(state.builder.exerciseLoadFailed, true);
  assert.match(results.innerHTML, /The exercises could not be loaded\. <button type="button" class="text-action" data-action="builder-retry-exercises">Try again<\/button>/);
  assert.doesNotMatch(results.innerHTML, /No matching exercises/);

  globalThis.fetch = realFetch;
  await handleBuilderWorkspaceAction({ dataset: { action: "builder-retry-exercises" } }, { loadBuilderExercises });
  assert.equal(state.builder.exercises.length, 18);
  assert.equal(state.builder.exerciseLoadFailed, false);
  assert.doesNotMatch(results.innerHTML, /could not be loaded/);
});

test("a search started after a failure is never shown as failed while it runs, and a failed new search never leaves the old query's results", async () => {
  state.builder = emptyBuilderState({ exerciseQuery: "Squat", exerciseLoadFailed: true });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path) => { await gate; return realFetch(path); };
  const pending = loadBuilderExercises();
  assert.equal(state.builder.exerciseLoadFailed, false, "a section editor opening now draws Loading, not the old failure");
  release();
  await pending;
  assert.equal(state.builder.exercises.length, 18);

  state.builder.exerciseQuery = "Lunge";
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "Server error" }) });
  await assert.rejects(loadBuilderExercises());
  assert.deepEqual(state.builder.exercises, [], "the Squat results do not stay under the Lunge search");
  assert.match(results.innerHTML, /could not be loaded/);
  globalThis.fetch = realFetch;
});

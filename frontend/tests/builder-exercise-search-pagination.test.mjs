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

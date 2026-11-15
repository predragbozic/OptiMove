// A Builder exercise load that nobody waits for (the search box's timer; the refresh after marking an exercise
// under the "marked" filter) must not end as an unhandled rejection when the request fails: the failure is already
// said in place with Try again and already reported once by api.js. Invented data only.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const results = { innerHTML: "", scrollTop: 0 };
const button = { disabled: false };
globalThis.document = { querySelector: (selector) => (selector === ".builder-exercise-results" ? results : button), querySelectorAll: () => [] };
const { state, emptyBuilderState } = await import("../state.js");
const { loadBuilderExercises, loadBuilderExercisesDetached } = await import("../builder-data.js");
const { handleExerciseLibraryAction } = await import("../exercise-actions.js");
const originalFetch = globalThis.fetch;
const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);
after(() => { globalThis.fetch = originalFetch; process.off("unhandledRejection", onUnhandled); });
const settle = () => new Promise((r) => setTimeout(r, 20));
const offline = () => { globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); }; };

beforeEach(() => {
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ exerciseQuery: "Squat" });
  state.markedExerciseIds = new Set();
  results.innerHTML = "";
  unhandled.length = 0;
  offline();
});

test("1. the search timer's load: a failed request says so in place and leaves no unhandled rejection; the awaited load still rejects", async () => {
  await assert.rejects(loadBuilderExercises(), TypeError, "a caller that waits still hears of the failure");
  results.innerHTML = "";
  state.builder = emptyBuilderState({ exerciseQuery: "Squat" });
  assert.equal(await loadBuilderExercisesDetached(), undefined);
  await settle();
  assert.deepEqual(unhandled, []);
  assert.equal(state.builder.exerciseLoadFailed, true);
  assert.match(results.innerHTML, /The exercises could not be loaded\./);
  assert.match(results.innerHTML, /data-action="builder-retry-exercises"/);
  // The timer of the search box uses it, and no load is started anywhere without being waited for or detached.
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /builderSearchTimer = setTimeout\(\(\) => loadBuilderExercisesDetached\(\), 250\);/);
  for (const file of ["app.js", "exercise-actions.js", "builder-actions.js"]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(void |=> )loadBuilderExercises\(/, file);
  }
});

test("2. marking an exercise under the 'marked' filter while offline: the mark is kept, the list says it failed, no unhandled rejection", async () => {
  state.builder.selectedNodeId = "section-1";
  state.builder.exerciseFilters.marked = true;
  const handled = await handleExerciseLibraryAction({ dataset: { action: "exercise-toggle-mark", exerciseId: "ex-1" } }, { renderBuilder: () => {} });
  await settle();
  assert.equal(handled, true);
  assert.ok(state.markedExerciseIds.has("ex-1"));
  assert.deepEqual(unhandled, []);
  assert.equal(state.builder.exerciseLoadFailed, true);
  assert.match(results.innerHTML, /The exercises could not be loaded\./);
});

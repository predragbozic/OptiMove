import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { renderExerciseLibraryHtml } from "../exercise-library.js";
import { renderExerciseBlocksHtml } from "../exercise-blocks.js";

// The owner's phone round (2026-10-17): Blocks sits beside the view icons in
// one consistent group, and managing application blocks leaves the library
// list: a gear only in the Blocks view (after a tap on Blocks), not even
// inside a block.

const BLOCK = "11111111-1111-1111-1111-111111111111";
function library({ admin = false, collection = "", name = "" } = {}) {
  const filters = collection ? { collection } : {};
  const html = renderExerciseLibraryHtml({ exercises: [], itemIds: [], markedExerciseIds: new Set(), search: { view: "list", term: "", filters, options: {}, collectionName: name, canManageCollections: admin }, tagEditor: { open: false } });
  return new JSDOM(html).window.document;
}

test("1. the plain library: Blocks right before the views in one group, Add apart, and no block management - also for an administrator", () => {
  for (const admin of [false, true]) {
    const doc = library({ admin });
    const group = doc.querySelector(".exercise-results-head .exercise-browse-controls");
    const blocks = group.querySelector('[data-action="exercise-blocks-open"]');
    assert.ok(blocks.classList.contains("exercise-browse-button"));
    assert.equal(blocks.getAttribute("aria-label"), "Exercise blocks");
    assert.equal(blocks.nextElementSibling, group.querySelector(".exercise-view-switcher"), "Blocks is beside the views");
    assert.equal(doc.querySelectorAll('[data-action="exercise-collections-open"]').length, 0);
    assert.doesNotMatch(doc.body.textContent, /Manage application blocks/);
    assert.ok(doc.querySelector('.exercise-results-head > .exercise-results-actions > [data-action="exercise-add-open"] + .exercise-browse-controls'));
    assert.equal(doc.querySelector(".exercise-block-chip"), null);
  }
});

test("2. inside a block: its name is a chip that leaves it, and nobody gets a gear there - an administrator neither", () => {
  const coach = library({ collection: BLOCK, name: "Ankle <stiffness>" });
  const chip = coach.querySelector('.exercise-results-filters > .exercise-block-chip[data-action="exercise-blocks-clear"]');
  assert.equal(chip.textContent, "Block: Ankle <stiffness>×");
  assert.equal(chip.getAttribute("aria-label"), "Leave block Ankle <stiffness> and show all exercises");
  assert.equal(coach.querySelectorAll('[data-action="exercise-collections-open"]').length, 0);
  assert.doesNotMatch(coach.body.innerHTML, /Selected block/);

  const admin = library({ admin: true, collection: BLOCK, name: "Ankle" });
  assert.equal(admin.querySelectorAll('[data-action="exercise-collections-open"]').length, 0);
  assert.equal(admin.querySelector(".exercise-browse-controls").firstElementChild.dataset.action, "exercise-blocks-open");

  const other = library({ admin: true, collection: "other" });
  assert.equal(other.querySelector(".exercise-block-chip").textContent, "Block: Other×");
  assert.equal(other.querySelectorAll('[data-action="exercise-collections-open"]').length, 0);
  assert.equal(library({ collection: BLOCK }).querySelector(".exercise-block-chip").textContent, "Block: Selected block×");
});

test("3. the Blocks view: All exercises and, for an administrator, the gear that manages application blocks", () => {
  const data = { blocks: [{ id: BLOCK, name: "Ankle", description: "", exerciseCount: 3, coverImageUrl: "", locked: false }], other: { id: "other", name: "Other", exerciseCount: 0 } };
  const admin = new JSDOM(renderExerciseBlocksHtml({ ...data, canManageCollections: true })).window.document;
  const gear = admin.querySelector('.exercise-blocks-head .exercise-browse-controls > [data-action="exercise-collections-open"]:not([data-collection-id])');
  assert.equal(gear.getAttribute("aria-label"), "Manage application blocks");
  assert.ok(gear.querySelector("svg"));
  assert.ok(admin.querySelector(".exercise-blocks-head [data-block-exercises].exercise-browse-button"));
  assert.doesNotMatch(admin.body.textContent, /Create \/ manage blocks/);
  const coach = new JSDOM(renderExerciseBlocksHtml({ ...data, canManageCollections: false })).window.document;
  assert.equal(coach.querySelectorAll('[data-action="exercise-collections-open"]').length, 0);
  // Opening a block carries its name for the chip.
  assert.ok([...admin.querySelectorAll("[data-open-block]")].every((button) => button.dataset.blockName === "Ankle"));
});

test("4. one look and touch size: the group's buttons match the switcher, phones stack count and Add, the badges, then the group", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.exercise-browse-button \{ display: inline-flex;[^}]*min-height: 38px;[^}]*border-radius: 8px; background: var\(--surface-soft\);/);
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.exercise-results-head \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto; grid-template-areas: "count add" "filters filters" "browse browse";[^}]*row-gap: 0; \}\s*\.exercise-results-actions \{ display: contents; \}/);
  // Touch sizes on every touch screen, a tablet wider than 760 px included.
  assert.match(css, /@media \(max-width: 760px\), \(pointer: coarse\) \{\s*\.exercise-add-button \{ min-height: 44px; \}\s*\.exercise-block-chip \{ min-height: 44px; \}\s*\.exercise-browse-button \{ min-height: 50px; padding: 0 14px; \}\s*\.exercise-browse-button\.is-icon \{ width: 50px; padding: 0; \}\s*\.exercise-results-head \.exercise-view-button \{ min-width: 44px; min-height: 44px; \}/);
  // Add and the group stay together at the right when they wrap.
  assert.match(css, /\.exercise-results-actions \{ display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; margin-left: auto; \}/);
  assert.doesNotMatch(css, /has-block-edit/);
});

test("5. a realtime access change or a block save reads the Blocks view again and never swaps it for the library", async () => {
  const dom = new JSDOM('<h2 id="screenTitle"></h2><div id="viewToolbar"></div><main id="content"></main>');
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const { els } = await import("../dom.js");
  const { state, emptyExerciseOptions } = await import("../state.js");
  const { openExerciseBlocks } = await import("../exercise-blocks.js");
  const { reloadExerciseLibrarySurface } = await import("../exercise-actions.js");
  els.title = document.querySelector("#screenTitle");
  els.toolbar = document.querySelector("#viewToolbar");
  els.content = document.querySelector("#content");
  state.currentUser = { id: "coach-id", activeWorkspace: { type: "private_coach" } };
  state.exerciseSearch = { filters: {}, options: emptyExerciseOptions(), limit: 30 };
  state.markedExerciseIds = new Set();
  state.markedExercises = new Map();
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, json: async () => String(url).includes("/catalog") ? { blocks: [], other: { id: "other", name: "Other", exerciseCount: 1 }, canManageCollections: false } : String(url).includes("/options") ? emptyExerciseOptions() : { exercises: [], lockedPreviews: [] } };
  };
  const handlers = { renderExercises() { assert.fail("the library must not replace the Blocks view"); }, setLoading() {} };
  await openExerciseBlocks(handlers);
  await reloadExerciseLibrarySurface(handlers);
  assert.ok(document.querySelector(".exercise-block-catalog"));
  assert.equal(document.querySelector("#exerciseSearch"), null);
  assert.equal(requests.filter((url) => url.includes("/catalog")).length, 2);
  assert.equal(requests.filter((url) => url.startsWith("/api/exercises?")).length, 0);
  dom.window.close();

  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.equal(app.match(/reloadExerciseLibrarySurface\(\{ renderExercises, setLoading \}\)/g)?.length, 2, "the realtime refresh and the block save");
  assert.doesNotMatch(app, /exercise-collections-open[^]*?openExerciseBlocks\(\{ renderExercises, setLoading \}\);\s*\}, action\.dataset\.collectionId/);
});

test("6. only the Exercise Library asks for locked previews; the Builder's search does not", async () => {
  const { exerciseSearchUrl } = await import("../exercise-data.js");
  assert.equal(new URL(exerciseSearchUrl("", 18, {}), "https://x.test").searchParams.has("lockedPreviews"), false);
  assert.equal(new URL(exerciseSearchUrl("", 30, {}, { lockedPreviews: true }), "https://x.test").searchParams.get("lockedPreviews"), "1");
  const actions = await readFile(new URL("../exercise-actions.js", import.meta.url), "utf8");
  assert.match(actions, /fetcher: \(\) => api\(exerciseSearchUrl\(query, limit, filters, \{ lockedPreviews: true \}\)\)/);
  assert.match(actions, /moreLockedPreviews = state\.exerciseSearch\.filters\.marked \? false : Boolean\(data\.moreLockedPreviews\)/);
  const builder = await readFile(new URL("../builder-data.js", import.meta.url), "utf8");
  assert.match(builder, /exerciseSearchUrl\(query, 18, filters\)\}&offset=/);
});

test("7. a block cover sends no referrer; switching all-users access off says who loses it", async () => {
  const html = renderExerciseBlocksHtml({ blocks: [{ id: BLOCK, name: "Ankle", exerciseCount: 1, coverImageUrl: "https://example.test/cover.jpg", locked: false }], other: { id: "other", exerciseCount: 0 }, canManageCollections: false });
  assert.match(html, /<img referrerpolicy="no-referrer" class="exercise-block-cover-image" src="https:\/\/example\.test\/cover\.jpg"/);
  const collections = await readFile(new URL("../exercise-collections.js", import.meta.url), "utf8");
  assert.match(collections, /panel\.original\.accessAll && !panel\.draft\.accessAll \? "Everyone who is not a selected user loses access to these exercises, including their personal copies\."/);
});

test("8. under Marked no Load more is offered for locked previews (through the real search)", async () => {
  const dom = new JSDOM('<h2 id="screenTitle"></h2><div id="viewToolbar"></div><main id="content"></main>');
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const { state, emptyExerciseOptions } = await import("../state.js");
  const { searchExercises } = await import("../exercise-actions.js");
  const { clearAllViewCache } = await import("../view-cache.js");
  clearAllViewCache();
  state.currentUser = { id: "marked-coach", activeWorkspace: { type: "private_coach" } };
  state.markedExerciseIds = new Set();
  state.markedExercises = new Map();
  let html = "";
  const handlers = { setLoading() {}, renderExercises(exercises) { html = renderExerciseLibraryHtml({ exercises, itemIds: [], markedExerciseIds: new Set(), search: state.exerciseSearch, tagEditor: { open: false } }); } };
  globalThis.fetch = async (url) => ({ ok: true, json: async () => String(url).includes("visible-marked") ? { ids: [] } : { exercises: [], hasMore: false, lockedPreviews: [{ id: "x", name: "Locked", blockName: null }], moreLockedPreviews: true } });
  for (const marked of [false, true]) {
    clearAllViewCache();
    state.exerciseSearch = { surface: "exercises", term: "", filters: { marked }, options: emptyExerciseOptions(), limit: 30, view: "list" };
    await searchExercises("", handlers);
    assert.equal(Boolean(new JSDOM(html).window.document.querySelector('[data-action="exercise-load-more"]')), !marked, `marked=${marked}`);
  }
  dom.window.close();
});

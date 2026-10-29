import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { renderExerciseLibraryHtml } from "../exercise-library.js";
import { emptyExerciseFilters, emptyExerciseOptions, state } from "../state.js";
import { clearAllViewCache } from "../view-cache.js";

// Exercise Library "Load more" (owner, 2026-10-29: it threw the page back to
// its top): the next page comes in under the exercises shown, the cards
// already shown are the very same nodes in the same place, nothing replaces
// the list while it loads, the focus goes on to the first new exercise, a
// second press sends nothing, and a failure leaves the list as it was. The
// browser check (scroll position kept to the pixel) is in the pull request.

const initialDom = new JSDOM("<body></body>");
globalThis.document = initialDom.window.document;
globalThis.window = initialDom.window;
const { handleExerciseLibraryAction, invalidateExercisesCache, keptExerciseCount, keptExerciseItemIds, loadExercises, searchExercises, showMoreExercises } = await import("../exercise-actions.js");
const { els } = await import("../dom.js");
initialDom.window.close();

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const all = Array.from({ length: 75 }, (_, index) => ({ id: `ex-${index + 1}`, name: `Exercise ${index + 1}`, owner_scope: "system", is_active: true }));

// The server: `limit` rows from the start, as GET /api/exercises answers.
function server({ fail = () => false, hold = null } = {}) {
  const calls = [];
  globalThis.fetch = async (path) => {
    const url = new URL(path, "https://test.local");
    calls.push(url);
    if (hold) await hold.promise;
    if (fail(url)) return { ok: false, status: 500, statusText: "Server Error", json: async () => ({ error: "boom" }) };
    if (url.pathname === "/api/exercises/options") return { ok: true, json: async () => ({}) };
    const limit = Number(url.searchParams.get("limit"));
    return { ok: true, json: async () => ({ exercises: all.slice(0, limit), hasMore: limit < all.length, lockedPreviews: [], moreLockedPreviews: false }) };
  };
  return calls;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// app.js's renderExercises around the same exported steps it calls
// (keptExerciseItemIds, then showMoreExercises), with its item registry as a Map.
const registry = new Map();
function appHandlers() {
  let nextId = 0;
  const calls = { loading: [], renders: 0 };
  const registerItems = (rows) => rows.map((row) => {
    const id = `item-${nextId++}`;
    registry.set(id, row);
    return id;
  });
  return {
    calls,
    setLoading(text) { calls.loading.push(text); els.content.innerHTML = `<div class="empty">${text}</div>`; },
    renderExercises(exercises, { keepShown = false } = {}) {
      calls.renders += 1;
      const shownCount = keepShown ? (state.lastExerciseResults || []).length : 0;
      const { kept, itemIds } = keepShown
        ? keptExerciseItemIds(state.lastExerciseResults || [], exercises, state.exerciseDetail.ids || [], { register: registerItems, refresh: (id, item) => registry.set(id, item) })
        : { kept: 0, itemIds: registerItems(exercises) };
      state.lastExerciseResults = exercises;
      state.exerciseDetail = { ids: itemIds, currentId: kept ? state.exerciseDetail.currentId : null };
      const html = renderExerciseLibraryHtml({ exercises, itemIds, markedExerciseIds: new Set(), search: state.exerciseSearch, selection: state.exerciseSelection, tagEditor: { open: false } });
      if (keepShown) showMoreExercises(els.content, html, { kept, shownCount });
      else els.content.innerHTML = html;
    },
  };
}

async function openLibrary(view = "details") {
  const dom = new JSDOM('<body><div id="viewToolbar"></div><main id="content"></main></body>');
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  els.toolbar = document.querySelector("#viewToolbar");
  els.content = document.querySelector("#content");
  state.currentUser = { id: "coach", activeWorkspace: { type: "private_coach" } };
  state.activeTab = "exercises";
  state.exerciseSearch = { filters: emptyExerciseFilters(), options: emptyExerciseOptions(), term: "", limit: 30, view, surface: "exercises" };
  state.exerciseSelection = { active: false, ids: new Map(), note: "" };
  state.exerciseDetail = { ids: [], currentId: null };
  state.lastExerciseResults = [];
  state.markedExercises = new Map();
  state.markedExerciseIds = new Set();
  clearAllViewCache();
  const handlers = appHandlers();
  await loadExercises(handlers);
  return { dom, handlers };
}

const cards = () => [...els.content.querySelectorAll('[data-action="open-exercise"]')];
const loadMore = (handlers) => handleExerciseLibraryAction(els.content.querySelector('[data-action="exercise-load-more"]'), handlers);

for (const view of ["details", "tile", "big", "list"]) {
  test(`A1 (${view}): Load more adds the next 30 under the shown ones, which stay the same nodes, and never shows a loading screen`, async () => {
    const calls = server();
    const { dom, handlers } = await openLibrary(view);
    const shown = cards();
    assert.equal(shown.length, 30);
    const loadingBefore = handlers.calls.loading.length;
    const removed = [];
    new dom.window.MutationObserver((records) => records.forEach((record) => removed.push(...record.removedNodes))).observe(els.content, { childList: true, subtree: true });
    await loadMore(handlers);
    await settle();
    assert.equal(handlers.calls.loading.length, loadingBefore, "no Loading exercises... in place of the list");
    const now = cards();
    assert.equal(now.length, 60);
    assert.ok(shown.every((card, index) => card === now[index] && card.isConnected), "the 30 shown are the very same nodes, first, in order");
    assert.deepEqual(now.slice(30).map((card) => card.querySelector(".exercise-title, .exercise-view-title").textContent), all.slice(30, 60).map((exercise) => exercise.name));
    assert.ok(!removed.some((node) => node.nodeType === 1 && node.matches?.(".exercise-card, .exercise-view-card, .exercise-grid, .exercise-view-grid")), "no card or list removed");
    assert.equal(els.content.querySelector(".exercise-results-count").textContent, "60 exercises shown");
    assert.equal(state.exerciseSearch.limit, 60);
    assert.equal(calls.at(-1).searchParams.get("limit"), "60");
    // Opening an exercise reaches every card, the new ones included, and a
    // kept card opens its fresh row.
    assert.equal(state.exerciseDetail.ids.length, 60);
    assert.equal(new Set(state.exerciseDetail.ids).size, 60);
    assert.equal(now[0].dataset.itemId, state.exerciseDetail.ids[0]);
    assert.ok(state.exerciseDetail.ids.every((id, index) => registry.get(id) === state.lastExerciseResults[index]));
    dom.window.close();
  });
}

test("A1: with a search and a filter the next page keeps them and the shown cards", async () => {
  const calls = server();
  const { dom, handlers } = await openLibrary();
  state.exerciseSearch.filters.purpose = "Strength";
  state.exerciseSearch.limit = 30;
  await searchExercises("Exercise", handlers);
  const shown = cards();
  assert.equal(shown.length, 30);
  await loadMore(handlers);
  const request = calls.at(-1);
  assert.equal(request.searchParams.get("search"), "Exercise");
  assert.equal(request.searchParams.get("purpose"), "Strength");
  assert.equal(request.searchParams.get("limit"), "60");
  assert.ok(shown.every((card, index) => card === cards()[index]));
  dom.window.close();
});

test("A2: the keyboard focus goes from Load more to the first new exercise, never to the top of the page", async () => {
  server();
  const { dom, handlers } = await openLibrary("tile");
  const button = els.content.querySelector('[data-action="exercise-load-more"]');
  button.focus();
  await loadMore(handlers);
  const focused = document.activeElement;
  assert.equal(focused.dataset.action, "open-exercise");
  assert.equal(focused.dataset.itemId, state.exerciseDetail.ids[30], "the 31st exercise");
  dom.window.close();
});

test("A2: focus the coach moved elsewhere meanwhile stays where it is", async () => {
  server();
  const { dom, handlers } = await openLibrary();
  const holdMore = deferred();
  server({ hold: holdMore });
  const pending = loadMore(handlers);
  const third = cards()[2];
  third.focus();
  holdMore.resolve();
  await pending;
  assert.equal(document.activeElement, third);
  dom.window.close();
});

test("A3: while it loads the button says so, a second press sends nothing, and the list stays", async () => {
  server();
  const { dom, handlers } = await openLibrary();
  const hold = deferred();
  const calls = server({ hold });
  const first = loadMore(handlers);
  await settle();
  const button = els.content.querySelector('[data-action="exercise-load-more"]');
  assert.equal(button.textContent, "Loading...");
  assert.equal(button.getAttribute("aria-disabled"), "true");
  assert.equal(cards().length, 30, "the list stays on screen while it loads");
  const second = loadMore(handlers);
  const third = loadMore(handlers);
  hold.resolve();
  await Promise.all([first, second, third]);
  assert.equal(calls.filter((url) => url.pathname === "/api/exercises").length, 1, "one request for three presses");
  assert.equal(cards().length, 60);
  assert.equal(state.exerciseSearch.limit, 60);
  const fresh = els.content.querySelector('[data-action="exercise-load-more"]');
  assert.equal(fresh.textContent, "Load more");
  assert.equal(fresh.hasAttribute("aria-disabled"), false);
  dom.window.close();
});

test("A3: a failed load keeps every exercise shown, says so under the list, and the next press asks for the same page", async () => {
  server();
  const { dom, handlers } = await openLibrary();
  const shown = cards();
  const calls = server({ fail: (url) => url.pathname === "/api/exercises" });
  await loadMore(handlers);
  assert.ok(shown.every((card, index) => card === cards()[index] && card.isConnected));
  assert.equal(cards().length, 30);
  assert.equal(els.content.querySelector(".error"), null, "never the error box in place of the list");
  assert.equal(els.content.querySelector(".load-more-error").textContent, "More exercises could not be loaded. Try again.");
  assert.equal(els.content.querySelector(".load-more-error").getAttribute("role"), "alert");
  const button = els.content.querySelector('[data-action="exercise-load-more"]');
  assert.equal(button.textContent, "Load more");
  assert.equal(button.hasAttribute("aria-disabled"), false);
  assert.equal(state.exerciseSearch.limit, 30, "the page that was not shown is asked for again");
  assert.equal(calls.at(-1).searchParams.get("limit"), "60");
  const retry = server();
  await loadMore(handlers);
  assert.equal(retry.at(-1).searchParams.get("limit"), "60");
  assert.equal(cards().length, 60);
  assert.equal(els.content.querySelector(".load-more-error"), null);
  dom.window.close();
});

test("A3: a page that was not drawn keeps the locked matches shown; a newer search's own are never overwritten", async () => {
  const locked = (name) => ({ name, blockName: "Coach block" });
  const answer = (term) => async (path) => {
    const url = new URL(path, "https://test.local");
    if (url.pathname === "/api/exercises/options") return { ok: true, json: async () => ({}) };
    const limit = Number(url.searchParams.get("limit"));
    return { ok: true, json: async () => ({ exercises: all.slice(0, limit), hasMore: true, lockedPreviews: [locked(`${term} locked`)] }) };
  };
  globalThis.fetch = answer("first");
  const { dom, handlers } = await openLibrary();
  assert.deepEqual(state.exerciseSearch.lockedPreviews, [locked("first locked")]);
  server({ fail: (url) => url.pathname === "/api/exercises" });
  await loadMore(handlers);
  assert.deepEqual(state.exerciseSearch.lockedPreviews, [locked("first locked")], "after a failure");
  handlers.renderExercises(state.lastExerciseResults);
  assert.match(els.content.querySelector(".exercise-locked-results").textContent, /first locked/, "a later redraw still shows them");
  // A newer search lands while the further page is still on its way.
  const hold = deferred();
  globalThis.fetch = async (path) => { await hold.promise; return answer("old")(path); };
  const pending = loadMore(handlers);
  await settle();
  globalThis.fetch = answer("newer");
  state.exerciseSearch.limit = 30;
  await searchExercises("Squat", handlers);
  hold.resolve();
  await pending;
  assert.deepEqual(state.exerciseSearch.lockedPreviews, [locked("newer locked")]);
  // The same, with the newer search on the very same key: the library read
  // again after an invalidation while the further page was on its way.
  const holdAgain = deferred();
  globalThis.fetch = async (path) => { await holdAgain.promise; return answer("old")(path); };
  const again = loadMore(handlers);
  await settle();
  invalidateExercisesCache();
  globalThis.fetch = answer("same key");
  await searchExercises("Squat", handlers);
  holdAgain.resolve();
  await again;
  assert.deepEqual(state.exerciseSearch.lockedPreviews, [locked("same key locked")]);
  dom.window.close();
});

test("A3: a failed check of the marked exercises keeps the list too", async () => {
  server();
  const { dom, handlers } = await openLibrary();
  state.exerciseSearch.filters.marked = true;
  state.markedExercises.set("ex-1", { id: "ex-1" });
  server({ fail: (url) => url.pathname === "/api/exercises/visible-marked" });
  await loadMore(handlers);
  assert.equal(cards().length, 30);
  assert.ok(els.content.querySelector(".load-more-error"));
  assert.equal(state.exerciseSearch.limit, 30);
  dom.window.close();
});

test("A1: a library that changed meanwhile is drawn again whole - still without a loading screen", async () => {
  server();
  const { dom, handlers } = await openLibrary();
  const loadingBefore = handlers.calls.loading.length;
  globalThis.fetch = async (path) => {
    const url = new URL(path, "https://test.local");
    const limit = Number(url.searchParams.get("limit"));
    const rows = [{ id: "new-first", name: "Arrived first" }, ...all].slice(0, limit);
    return { ok: true, json: async () => ({ exercises: rows, hasMore: true }) };
  };
  await loadMore(handlers);
  assert.equal(handlers.calls.loading.length, loadingBefore);
  assert.equal(cards().length, 60);
  assert.equal(cards()[0].querySelector(".exercise-title").textContent, "Arrived first");
  dom.window.close();
});

test("A1: leaving the library while the page loads draws nothing over the next screen", async () => {
  server();
  const { dom, handlers } = await openLibrary();
  const hold = deferred();
  server({ hold });
  const pending = loadMore(handlers);
  await settle();
  state.activeTab = "templates";
  els.content.innerHTML = "<p>Program Library</p>";
  hold.resolve();
  await pending;
  assert.equal(els.content.innerHTML, "<p>Program Library</p>");
  dom.window.close();
});

test("keptExerciseCount keeps all shown or none", () => {
  const shown = all.slice(0, 3);
  assert.equal(keptExerciseCount(shown, all.slice(0, 6), ["a", "b", "c"]), 3);
  assert.equal(keptExerciseCount(shown, [all[1], ...all.slice(1, 6)], ["a", "b", "c"]), 0);
  assert.equal(keptExerciseCount(shown, all.slice(0, 2), ["a", "b", "c"]), 0);
  assert.equal(keptExerciseCount(shown, all.slice(0, 6), ["a", "b"]), 0, "item ids of another list");
  assert.equal(keptExerciseCount([], all, []), 0);
});

test("keptExerciseItemIds keeps the shown ids pointing at the fresh rows and registers only the new ones", () => {
  const shown = all.slice(0, 2);
  const next = [{ ...all[0], name: "Renamed" }, { ...all[1] }, all[2]];
  const refreshed = [];
  const registered = [];
  const result = keptExerciseItemIds(shown, next, ["a", "b"], {
    register: (rows) => { registered.push(...rows); return rows.map((row) => `new-${row.id}`); },
    refresh: (id, row) => refreshed.push([id, row]),
  });
  assert.deepEqual(result, { kept: 2, itemIds: ["a", "b", "new-ex-3"] });
  assert.deepEqual(refreshed, [["a", next[0]], ["b", next[1]]]);
  assert.deepEqual(registered, [all[2]]);
  const changed = keptExerciseItemIds(shown, [all[1], all[0]], ["a", "b"], { register: (rows) => rows.map(() => "fresh"), refresh: () => assert.fail("nothing is kept") });
  assert.deepEqual(changed, { kept: 0, itemIds: ["fresh", "fresh"] });
});

test("app.js renders a further page through keepShown and keeps an opened exercise", async () => {
  const app = (await readFile(new URL("../app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const body = app.match(/function renderExercises\(exercises, \{ keepShown = false \} = \{\}\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(body, /keptExerciseItemIds\(state\.lastExerciseResults \|\| \[\], exercises, state\.exerciseDetail\.ids \|\| \[\], \{ register: registerItems, refresh: \(id, item\) => itemRegistry\.set\(id, item\) \}\)/);
  assert.match(body, /: \{ kept: 0, itemIds: registerItems\(exercises\) \};/);
  assert.match(body, /currentId: kept \? state\.exerciseDetail\.currentId : null/);
  assert.match(body, /if \(keepShown\) showMoreExercises\(els\.content, html, \{ kept, shownCount \}\);\n  else els\.content\.innerHTML = html;/);
});

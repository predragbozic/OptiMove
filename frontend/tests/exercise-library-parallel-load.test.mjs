import { after, before, test } from "node:test";
import assert from "node:assert/strict";

// perf/settings-navigation-fast-path: loadExercises() must fire
// /api/exercises/options and /api/exercises at the same time instead of the
// options fetch blocking the initial exercise list, and a failure in either
// one must never leave the "Loading exercises..." placeholder stuck forever.
// exercise-actions.js is a real, already-exported/testable module (unlike
// app.js, which runs init() - full DOM/session/network wiring - at import
// time and is never imported directly by this test suite) - a minimal flat
// document/element stub (same convention as the rest of this suite) is
// enough to drive it directly.

const fakeElements = new Map();
function fakeElement() {
  return { innerHTML: "", value: "", textContent: "", _listeners: {}, addEventListener(type, handler) { this._listeners[type] = handler; } };
}
globalThis.document = {
  querySelector(selector) {
    if (!fakeElements.has(selector)) fakeElements.set(selector, fakeElement());
    return fakeElements.get(selector);
  },
  querySelectorAll: () => [],
};

const { loadExercises, searchExercises } = await import("../exercise-actions.js");
const { els } = await import("../dom.js");
const { state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");

function resetState() {
  state.exerciseSearch = { term: "", limit: 30, hasMore: false, filters: { purpose: "", quality: "", group: "", bodyPart: "", movementPattern: "", startingPosition: "", place: "", complexity: "", attractor: "", tag: "", favorite: false, marked: false }, options: { purposes: [], qualities: [], groups: [], bodyParts: [], movementPatterns: [], startingPositions: [], places: [], complexities: [], attractors: [], tags: [] } };
  state.navStack = [];
  els.content.innerHTML = "";
  els.toolbar.innerHTML = "";
  // perf/main-navigation-cache: searchExercises() now goes through
  // view-cache.js's module-level (test-run-wide) cache store - without this,
  // every test after the first would see a fresh() cache hit for the same
  // (empty term, default filters) context and never actually call fetch.
  clearAllViewCache();
}

function handlers() {
  const rendered = [];
  return {
    calls: rendered,
    setLoading: (text) => { els.content.innerHTML = `<div class="empty">${text}</div>`; },
    renderExercises: (exercises) => { rendered.push(exercises); },
  };
}

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

// Records the order fetches were ISSUED in (not resolved in) - proves the
// options and exercises calls both start before either has finished,
// regardless of which one the mock resolves first.
function installOrderTrackingFetch({ optionsDelayMs = 5, exercisesDelayMs = 5, optionsOk = true, exercisesOk = true } = {}) {
  const issuedOrder = [];
  globalThis.fetch = (url) => {
    const isOptions = String(url).includes("/api/exercises/options");
    issuedOrder.push(isOptions ? "options" : "exercises");
    const delay = isOptions ? optionsDelayMs : exercisesDelayMs;
    const ok = isOptions ? optionsOk : exercisesOk;
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          ok,
          status: ok ? 200 : 500,
          json: async () => (isOptions
            ? { purposes: ["Strength"], qualities: [], groups: [], bodyParts: [], movementPatterns: [], startingPositions: [], places: [], complexities: [], attractors: [], tags: [] }
            : { exercises: [{ id: "ex-1", name: "Squat" }], hasMore: false }),
        });
      }, delay);
    });
  };
  return issuedOrder;
}

test("1. loadExercises() issues /api/exercises/options and /api/exercises before either has resolved (true parallel start)", async () => {
  resetState();
  // options resolves slower than exercises - if the old sequential code were
  // still in place, the exercises fetch could not even be ISSUED until
  // options had already resolved, so its issue timestamp would always come
  // after options' resolution. Here it must be issued immediately.
  const issuedOrder = installOrderTrackingFetch({ optionsDelayMs: 30, exercisesDelayMs: 5 });
  const h = handlers();
  await loadExercises(h);
  assert.deepEqual(issuedOrder, ["options", "exercises"], "both requests must be issued back-to-back at the start, not one after the other's response");
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], [{ id: "ex-1", name: "Squat" }]);
});

test("2. the exercise list still renders even when it resolves before the (slower) options fetch", async () => {
  resetState();
  installOrderTrackingFetch({ optionsDelayMs: 40, exercisesDelayMs: 5 });
  const h = handlers();
  await loadExercises(h);
  assert.equal(h.calls.length, 1, "the exercise list must render exactly once, regardless of which fetch resolves first");
});

test("3. a failing /api/exercises/options never blocks or breaks the exercise list", async () => {
  resetState();
  installOrderTrackingFetch({ optionsOk: false });
  const h = handlers();
  await assert.doesNotReject(() => loadExercises(h));
  assert.equal(h.calls.length, 1, "the exercise list must still render even though options failed");
  assert.deepEqual(state.exerciseSearch.options.purposes, [], "a failed options fetch must leave the (empty) defaults in place, not crash the load");
});

test("4. a failing /api/exercises replaces the stuck loading placeholder with a visible error instead of leaving it forever", async () => {
  resetState();
  globalThis.fetch = (url) => {
    if (String(url).includes("/api/exercises/options")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ purposes: [] }) });
    return Promise.resolve({ ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({ error: "Search failed" }) });
  };
  const h = handlers();
  await loadExercises(h);
  assert.equal(h.calls.length, 0, "renderExercises must never be called for a failed search");
  assert.ok(!els.content.innerHTML.includes("Loading exercises...") && !els.content.innerHTML.includes("Searching exercises..."), "the loading placeholder must not be left on screen forever after a failed fetch");
  assert.ok(els.content.innerHTML.includes("Search failed"), "the real error message must be shown");
});

test("5. a later searchExercises() call (typing/filter change) also recovers from a failure instead of sticking on 'Searching...'", async () => {
  resetState();
  let call = 0;
  globalThis.fetch = () => {
    call += 1;
    if (call === 1) return Promise.resolve({ ok: true, status: 200, json: async () => ({ purposes: [] }) }); // options
    if (call === 2) return Promise.resolve({ ok: true, status: 200, json: async () => ({ exercises: [], hasMore: false }) }); // initial search
    return Promise.resolve({ ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({ error: "Down" }) }); // a later, failing search
  };
  const h = handlers();
  await loadExercises(h);
  await searchExercises("squat", h);
  assert.ok(!els.content.innerHTML.includes("Searching exercises..."), "a failed re-search must not leave its own loading placeholder stuck either");
  assert.ok(els.content.innerHTML.includes("Down"));
});

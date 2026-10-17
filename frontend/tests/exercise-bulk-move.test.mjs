import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { EXERCISE_SELECTION_LIMIT, openExerciseBulkMove } from "../exercise-bulk-move.js";
import { isSelectableExercise, renderExerciseLibraryHtml } from "../exercise-library.js";
import { emptyExerciseOptions, state } from "../state.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const exercises = [
  { id: "sys-1", name: "Squat", owner_scope: "system", is_active: true },
  { id: "sys-2", name: "Lunge", owner_scope: "system", is_active: true },
  { id: "own-1", name: "My copy", owner_scope: "user", is_active: true, can_edit: true },
  { id: "old-1", name: "Archived drill", owner_scope: "system", is_active: false },
];
const search = (extra = {}) => ({ filters: {}, options: emptyExerciseOptions(), view: "list", canManageCollections: true, ...extra });
const libraryHtml = ({ selection, view = "list", canManageCollections = true } = {}) => renderExerciseLibraryHtml({
  exercises, itemIds: exercises.map((exercise) => exercise.id), markedExerciseIds: new Set(),
  search: search({ view, canManageCollections }), selection, tagEditor: { open: false },
});

test("only the block administrator gets Select; while selecting, only active application exercises carry a mark", () => {
  assert.equal(libraryHtml({ canManageCollections: false, selection: { active: true, ids: new Map() } }).includes("exercise-select"), false);
  for (const view of ["list", "tile", "big", "details"]) {
    const dom = new JSDOM(libraryHtml({ view, selection: { active: true, ids: new Map([["sys-2", "Lunge"], ["elsewhere", "Hop"]]), note: "" } }));
    const doc = dom.window.document;
    assert.equal(doc.querySelector(".exercise-select-button").textContent, "Done");
    assert.equal(doc.querySelector(".exercise-select-button").hasAttribute("aria-pressed"), false, "the label alone says the state");
    assert.deepEqual([...doc.querySelectorAll('[data-action="exercise-select-toggle"]')].map((box) => box.dataset.exerciseId), ["sys-1", "sys-2"], view);
    assert.equal(doc.querySelector('[data-exercise-id="sys-2"][data-action="exercise-select-toggle"]').checked, true);
    assert.ok(doc.querySelector('[data-exercise-card="sys-2"]').classList.contains("is-selected"));
    // The mark is its own control, never inside a button that opens something.
    for (const box of doc.querySelectorAll('[data-action="exercise-select-toggle"]')) assert.equal(box.closest("button"), null);
    assert.equal(doc.querySelector("[data-exercise-selection-count]").textContent, "2 selected · 1 not shown here");
    assert.equal(doc.querySelector('[data-action="exercise-bulk-move-open"]').disabled, false);
    dom.window.close();
  }
  const idle = new JSDOM(libraryHtml({ selection: { active: false, ids: new Map() } }));
  assert.equal(idle.window.document.querySelector(".exercise-select-button").textContent, "Select");
  assert.equal(idle.window.document.querySelectorAll('[data-action="exercise-select-toggle"], .exercise-selection-bar').length, 0);
  idle.window.close();
  assert.deepEqual(exercises.filter(isSelectableExercise).map((exercise) => exercise.id), ["sys-1", "sys-2"]);
});

async function openLibrary() {
  const dom = new JSDOM('<h2 id="screenTitle"></h2><div id="viewToolbar"></div><main id="content"></main>');
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const { els } = await import("../dom.js");
  els.content = document.querySelector("#content");
  els.toolbar = document.querySelector("#viewToolbar");
  els.title = document.querySelector("#screenTitle");
  const { handleExerciseLibraryAction } = await import("../exercise-actions.js");
  state.exerciseSearch = search();
  state.exerciseSelection = { active: false, ids: new Map(), note: "" };
  state.lastExerciseResults = exercises;
  state.markedExerciseIds = new Set();
  state.tagEditor = { open: false };
  const handlers = {
    renderExercises(list) {
      state.lastExerciseResults = list;
      els.content.innerHTML = renderExerciseLibraryHtml({ exercises: list, itemIds: list.map((exercise) => exercise.id), markedExerciseIds: new Set(), search: state.exerciseSearch, selection: state.exerciseSelection, tagEditor: { open: false } });
    },
    setLoading() {},
  };
  handlers.renderExercises(exercises);
  // The app's content click delegation, reduced to the library's actions.
  els.content.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (action) void handleExerciseLibraryAction(action, handlers);
  });
  return { dom, click: async (selector) => { document.querySelector(selector).click(); await settle(); } };
}

test("Select, a mark, Select all shown, Clear and Done keep the selection in state and update the bar in place", async () => {
  const { dom, click } = await openLibrary();
  await click(".exercise-select-button");
  assert.equal(state.exerciseSelection.active, true);
  assert.equal(document.activeElement, document.querySelector(".exercise-select-button"));
  assert.match(document.querySelector("[data-exercise-selection-note]").textContent, /Tick application exercises to move them into a block/);
  const bar = document.querySelector(".exercise-selection-bar");
  await click('[data-action="exercise-select-toggle"][data-exercise-id="sys-1"]');
  assert.deepEqual([...state.exerciseSelection.ids.entries()], [["sys-1", "Squat"]]);
  assert.equal(document.querySelector(".exercise-selection-bar"), bar, "the bar is updated, not replaced");
  assert.equal(bar.querySelector("[data-exercise-selection-count]").textContent, "1 selected");
  assert.ok(document.querySelector('[data-exercise-card="sys-1"]').classList.contains("is-selected"));
  await click('[data-action="exercise-select-all-shown"]');
  assert.deepEqual([...state.exerciseSelection.ids.keys()], ["sys-1", "sys-2"]);
  assert.equal(document.querySelector('[data-action="exercise-select-all-shown"]').disabled, true);
  await click('[data-action="exercise-select-toggle"][data-exercise-id="sys-2"]');
  assert.deepEqual([...state.exerciseSelection.ids.keys()], ["sys-1"]);
  await click('[data-action="exercise-select-clear"]');
  assert.equal(state.exerciseSelection.ids.size, 0);
  assert.equal(document.querySelector('[data-action="exercise-bulk-move-open"]').disabled, true);
  assert.equal(document.querySelector('[data-action="exercise-select-toggle"][data-exercise-id="sys-1"]').checked, false);
  // At most a hundred: the next mark is refused and said so.
  state.exerciseSelection.ids = new Map(Array.from({ length: EXERCISE_SELECTION_LIMIT }, (_, index) => [`x-${index}`, ""]));
  await click('[data-action="exercise-select-toggle"][data-exercise-id="sys-2"]');
  assert.equal(state.exerciseSelection.ids.has("sys-2"), false);
  assert.equal(document.querySelector('[data-action="exercise-select-toggle"][data-exercise-id="sys-2"]').checked, false);
  assert.match(document.querySelector("[data-exercise-selection-note]").textContent, /At most 100/);
  await click('.exercise-selection-bar [data-action="exercise-select-mode"]');
  assert.deepEqual(state.exerciseSelection, { active: false, ids: new Map(), note: "" });
  assert.equal(document.querySelector(".exercise-selection-bar"), null);
  dom.window.close();
});

// The move dialog against a fake of its two routes.
async function openDialog({ lookup, put = async () => ({ ok: true, json: async () => ({ collectionId: "block-b", moved: ["sys-1", "sys-2"], unchanged: [], changed: true }) }) }) {
  const dom = new JSDOM("<main></main>");
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const requests = [];
  let lookups = 0;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
    if (options.method === "PUT") return put(options);
    lookups += 1;
    return { ok: true, json: async () => (typeof lookup === "function" ? lookup(lookups) : lookup) };
  };
  let moved = 0;
  const overlay = openExerciseBulkMove(["sys-1", "sys-2", "own-1", "gone"], { onMoved: async () => { moved += 1; } });
  await settle();
  await settle();
  const choose = async (value) => {
    const select = document.querySelector("[data-bulk-move-target]");
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle();
  };
  const press = async (selector) => { document.querySelector(selector).click(); await settle(); await settle(); };
  return { dom, overlay, requests, choose, press, moved: () => moved, lookups: () => lookups };
}
const blocks = [{ id: "block-a", name: "Speed", accessAll: false }, { id: "block-b", name: "Open drills", accessAll: true }];
const where = {
  exercises: [
    { id: "sys-1", name: "Squat", movable: true, current: { id: "block-a", name: "Speed" } },
    { id: "sys-2", name: "Lunge", movable: true, current: null },
    { id: "own-1", name: "My copy", movable: false, current: { id: "block-a", name: "Speed" } },
  ],
  blocks,
};

test("the dialog says where the selected exercises are, who can use them after the move, and sends what it showed", async () => {
  const { dom, overlay, requests, choose, press, moved } = await openDialog({ lookup: where });
  assert.equal(requests[0].url, "/api/exercise-collections/exercise-blocks?ids=sys-1,sys-2,own-1,gone");
  const text = () => document.querySelector(".exercise-bulk-move-modal").textContent;
  assert.match(text(), /2 selected exercises — now in Speed \(1\), Other \(1\)/);
  assert.match(text(), /Left out \(archived or a personal copy\): My copy/);
  assert.match(text(), /1 selected exercise no longer exists/);
  assert.equal(document.querySelector("[data-bulk-move-submit]").disabled, true, "nothing is sent before a destination is chosen");
  await choose("block-a");
  assert.match(text(), /Only this block's selected users and the administrator can use them/);
  assert.match(text(), /1 is already in “Speed” and stays as it is/);
  assert.equal(document.querySelector("[data-bulk-move-submit]").textContent.trim(), "Move 1 exercise to “Speed”");
  assert.equal(document.querySelector("[data-bulk-move-submit]").getAttribute("aria-describedby"), "exercise-bulk-move-access");
  await choose("other");
  assert.match(text(), /Every coach can use them: Other is available to all coaches/);
  await choose("block-b");
  assert.match(text(), /Every coach can use them: this block is open to all users/);
  await press("[data-bulk-move-submit]");
  const sent = requests.find((request) => request.method === "PUT");
  assert.equal(sent.url, "/api/exercise-collections/exercise-blocks");
  assert.deepEqual(sent.body, { collectionId: "block-b", moves: [{ exerciseId: "sys-1", expectedCollectionId: "block-a" }, { exerciseId: "sys-2", expectedCollectionId: null }] });
  assert.equal(moved(), 1);
  assert.match(text(), /Moved 2 exercises to “Open drills”. Every coach can use them now./);
  assert.equal(document.querySelector("[data-bulk-move-target]"), null, "the old places are not shown after the move");
  assert.equal(document.querySelector("[data-bulk-move-submit]"), null);
  await press("[data-bulk-move-close]");
  assert.equal(overlay.isConnected, false);
  dom.window.close();
});

test("a refusal names its reason; changed elsewhere asks for Check again, and an unknown outcome is never a failure", async () => {
  let answer = { ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "staleRevision", stale: ["sys-1"] }) };
  const moved = { ...where, exercises: where.exercises.map((exercise) => exercise.id === "sys-1" ? { ...exercise, current: { id: "block-b", name: "Open drills" } } : exercise) };
  const { dom, requests, choose, press, lookups } = await openDialog({ lookup: (count) => (count === 1 ? where : moved), put: async () => answer });
  await choose("block-a");
  await press("[data-bulk-move-submit]");
  const text = () => document.querySelector(".exercise-bulk-move-modal").textContent;
  assert.match(text(), /Nothing was moved: some of these exercises were moved elsewhere/);
  assert.equal(document.querySelector("[data-bulk-move-submit]").disabled, true, "the same expectations are never sent twice");
  await press("[data-bulk-move-check]");
  assert.equal(lookups(), 2);
  assert.match(text(), /Checked just now/);
  assert.match(text(), /now in Open drills \(1\), Other \(1\)/);
  assert.equal(document.querySelector("[data-bulk-move-target]").value, "block-a", "the chosen destination is kept");
  // The answer is lost (503 outcomeUnknown): not confirmed, locked until checked.
  answer = { ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({ error: "outcomeUnknown" }) };
  await press("[data-bulk-move-submit]");
  assert.deepEqual(requests.filter((request) => request.method === "PUT").at(-1).body.moves[0], { exerciseId: "sys-1", expectedCollectionId: "block-b" });
  assert.match(text(), /The move was not confirmed/);
  assert.equal(document.querySelector("[data-bulk-move-submit]").disabled, true);
  // No answer at all is the same.
  await press("[data-bulk-move-check]");
  answer = Promise.reject(new TypeError("Failed to fetch"));
  answer.catch(() => {});
  await press("[data-bulk-move-submit]");
  assert.match(text(), /The move was not confirmed/);
  // The blocks are busy: a plain refusal, Move stays usable.
  await press("[data-bulk-move-check]");
  answer = { ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "tryAgain" }) };
  await press("[data-bulk-move-submit]");
  assert.match(text(), /Nothing was moved: the blocks are being changed right now/);
  assert.equal(document.querySelector("[data-bulk-move-submit]").disabled, false);
  dom.window.close();
});

test("a lost answer whose move did land is recognised by Check again as saved, once", async () => {
  const landed = { ...where, exercises: where.exercises.map((exercise) => exercise.movable ? { ...exercise, current: { id: "block-a", name: "Speed" } } : exercise) };
  const { dom, choose, press, moved } = await openDialog({ lookup: (count) => (count === 1 ? where : landed),
    put: async () => ({ ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({ error: "outcomeUnknown" }) }) });
  await choose("block-a");
  await press("[data-bulk-move-submit]");
  assert.match(document.querySelector(".exercise-bulk-move-modal").textContent, /The move was not confirmed/);
  assert.equal(moved(), 0);
  await press("[data-bulk-move-check]");
  assert.match(document.querySelector(".exercise-bulk-move-modal").textContent, /The move was saved: all 2 are now in “Speed”. Only the selected users of “Speed” and the administrator can use them now./);
  assert.equal(moved(), 1);
  dom.window.close();
});

test("permission gone, or nothing left that can move: no Move at all", async () => {
  const denied = await openDialog({ lookup: where, put: async () => ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({ error: "notFound" }) }) });
  await denied.choose("block-b");
  await denied.press("[data-bulk-move-submit]");
  assert.match(document.querySelector(".exercise-bulk-move-modal").textContent, /Nothing was moved: you no longer have permission/);
  assert.equal(document.querySelector("[data-bulk-move-submit]"), null);
  assert.equal(document.querySelector("[data-bulk-move-close]").textContent, "Close");
  denied.dom.window.close();
  const fixedOnly = await openDialog({ lookup: { exercises: [where.exercises[2]], blocks } });
  assert.match(document.querySelector(".exercise-bulk-move-modal").textContent, /None of the selected exercises can be moved now/);
  assert.equal(document.querySelector("[data-bulk-move-submit], [data-bulk-move-target]"), null);
  fixedOnly.dom.window.close();
});

test("the page behind is out of reach while the dialog is open, and back when it closes or is removed", async () => {

  const { dom, overlay, press } = await openDialog({ lookup: where });

  const page = document.querySelector("main");
  assert.equal(page.inert, true);
  await press("[data-bulk-move-close]");
  assert.notEqual(page.inert, true);
  const second = openExerciseBulkMove(["sys-1"]);
  assert.equal(page.inert, true);
  second.remove();
  await settle();
  assert.notEqual(page.inert, true, "removed by someone else (a workspace change): the page comes back");
  void overlay;
  dom.window.close();
});

test("a move in flight cannot be closed away", async () => {
  let finish;
  const { dom, overlay, choose, press } = await openDialog({ lookup: where, put: () => new Promise((resolve) => { finish = resolve; }) });
  await choose("block-b");
  document.querySelector("[data-bulk-move-submit]").click();
  await settle();
  assert.equal(document.querySelector("[data-bulk-move-close]").disabled, true);
  overlay.querySelector(".exercise-editor-backdrop").click();
  document.querySelector(".exercise-bulk-move-modal").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(overlay.isConnected, true);
  finish({ ok: true, json: async () => ({ collectionId: "block-b", moved: ["sys-1", "sys-2"], unchanged: [], changed: true }) });
  await settle();
  await settle();
  await press("[data-bulk-move-close]");
  assert.equal(overlay.isConnected, false);
  dom.window.close();
});

test("the app passes the selection to the library, and the marks and bar have touch-size targets", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /renderExerciseLibraryHtml\(\{[^}]*selection: state\.exerciseSelection/);
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.exercise-select-check\s*\{[^}]*width:\s*44px;\s*height:\s*44px/);
  assert.match(css, /\.exercise-selection-bar\s*\{[^}]*position:\s*sticky/);
  assert.match(css, /@media \(max-width: 760px\), \(pointer: coarse\)\s*\{\s*\.exercise-selection-actions \.compact-button,\s*\.exercise-results-actions \.exercise-select-button\s*\{\s*min-height:\s*44px/);
  assert.match(css, /\.exercise-card\.is-selectable:not\(:has\(> \.exercise-media\)\)\s*\{\s*padding-top:\s*54px/);
});

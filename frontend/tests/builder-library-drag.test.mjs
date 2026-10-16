import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

// The owner's request (2026-10-16): on a computer an exercise is dragged
// from the section editor's library onto the Added list and lands where it
// is dropped. And the library lists every exercise when nothing is typed
// in the search - also after a draft was opened with Continue, which does
// not load the library itself.

const dom = new JSDOM("<!doctype html><div id=content></div>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.FormData = dom.window.FormData;
globalThis.requestAnimationFrame = (callback) => callback();
const { state, emptyBuilderState } = await import("../state.js");
const { dropBuilderLibraryExercise, builderLibraryDropBlocked, handleBuilderWorkspaceAction, submitBuilderForm } = await import("../builder-actions.js");
const { ensureBuilderExercises } = await import("../builder-data.js");
const drag = await import("../builder-library-drag.js");
const { renderBuilderExerciseResult, renderBuilderExerciseResults } = await import("../builder-exercises.js");

const content = document.getElementById("content");
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function draft(order) {
  return {
    plan: { id: "draft-1", status: "draft", isEditDraft: true, planType: "weekly" },
    blocks: [{ id: "day-1", sessions: [{ id: "session-1", nodes: [{ id: "section-1", type: "section", items: order.map((id) => ({ id, title: `Exercise ${id}`, exerciseId: `lib-${id}` })) }] }] }],
  };
}
const order = () => state.builder.draft.blocks[0].sessions[0].nodes[0].items.map((item) => item.id);

// Lays out the Added list: each item 40 px tall, from y = 100.
function addedColumn(ids, { hidden = [] } = {}) {
  content.innerHTML = `<div class="builder-section-panel">
    <section class="builder-section-library"><div class="builder-exercise-results">
      <article class="builder-exercise-result" draggable="true" data-builder-library-drag data-exercise-id="lib-new"><button type="button" class="builder-exercise-preview"><img src="x.png" alt=""></button><strong>New</strong></article>
    </div></section>
    <section class="builder-section-added">${ids.map((id) => `<form data-drag-item data-item-id="${id}"><b>${id}</b></form>`).join("")}<div class="builder-added-list-compact">${hidden.map((id) => `<form data-drag-item data-item-id="${id}"></form>`).join("")}</div></section>
  </div>`;
  content.querySelector(".builder-section-added").getClientRects = () => [{}];
  ids.forEach((id, index) => {
    const item = content.querySelector(`.builder-section-added > [data-item-id="${id}"]`);
    item.getClientRects = () => [{}];
    item.getBoundingClientRect = () => ({ top: 100 + index * 40, height: 40, bottom: 140 + index * 40 });
  });
  for (const item of content.querySelectorAll(".builder-added-list-compact [data-drag-item]")) {
    item.getClientRects = () => [];
    item.getBoundingClientRect = () => ({ top: 0, height: 0, bottom: 0 });
  }
}

function dataTransfer() {
  const data = new Map([["text/uri-list", "x.png"]]);
  return {
    data, effectAllowed: "", dropEffect: "",
    get types() { return [...data.keys()]; },
    clearData() { data.clear(); },
    setData(type, value) { data.set(type, value); },
    getData(type) { return data.get(type) || ""; },
  };
}

function dragEvent(target, { clientY = 0, transfer = dataTransfer(), relatedTarget = null } = {}) {
  return {
    target, currentTarget: content, clientY, dataTransfer: transfer, relatedTarget,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
}

// Starts a library drag from the first card; its events share one transfer.
function beginDrag() {
  const start = dragEvent(content.querySelector("article"));
  drag.startBuilderLibraryDrag(start);
  return start.dataTransfer;
}

beforeEach(() => {
  delete globalThis.matchMedia;
  content.innerHTML = "";
});
afterEach(() => {
  drag.endBuilderLibraryDrag(dragEvent(content));
});

test("1. a library card drags as its own exercise only, and the Added column is outlined while it does", () => {
  addedColumn(["a", "b"]);
  const image = content.querySelector("img");
  const start = dragEvent(image);
  assert.equal(drag.startBuilderLibraryDrag(start), true);
  assert.equal(start.defaultPrevented, false);
  assert.deepEqual([...start.dataTransfer.data], [[drag.LIBRARY_DRAG_TYPE, "lib-new"]], "the picture's address is not carried");
  assert.equal(start.dataTransfer.effectAllowed, "copy");
  assert.ok(content.querySelector(".builder-section-panel").classList.contains("is-library-dragging"));
  assert.equal(drag.startBuilderLibraryDrag(dragEvent(content.querySelector(".builder-section-added"))), false, "not a card");
});

test("2. over the Added column the place it would land is marked; elsewhere nothing may drop", () => {
  addedColumn(["a", "b", "c"]);
  const transfer = beginDrag();
  const zone = content.querySelector(".builder-section-added");
  const over = dragEvent(zone.querySelector('[data-item-id="b"]'), { clientY: 125, transfer });
  assert.equal(drag.overBuilderLibraryDrag(over), true);
  assert.equal(over.defaultPrevented, true, "the column takes the drop");
  assert.equal(over.dataTransfer.dropEffect, "copy");
  assert.ok(zone.classList.contains("is-library-drop-target"));
  assert.ok(zone.querySelector('[data-item-id="b"]').classList.contains("is-drop-before"), "between a and b");
  const below = dragEvent(zone, { clientY: 400, transfer });
  drag.overBuilderLibraryDrag(below);
  assert.equal(zone.querySelectorAll(".is-drop-before").length, 0);
  assert.ok(zone.querySelector('[data-item-id="c"]').classList.contains("is-drop-after"), "after the last one");
  const library = dragEvent(content.querySelector(".builder-section-library"), { clientY: 125, transfer });
  drag.overBuilderLibraryDrag(library);
  assert.equal(library.defaultPrevented, false, "the library itself is no drop target");
  assert.equal(content.querySelectorAll(".is-drop-before, .is-drop-after, .is-library-drop-target").length, 0);
});

test("3. a drop gives the exercise and its position among the added ones the screen shows", () => {
  addedColumn(["a", "b", "c"], { hidden: ["a", "b", "c"] });
  const drops = [];
  for (const [clientY, index] of [[90, 0], [125, 1], [165, 2], [300, 3]]) {
    const transfer = beginDrag();
    const drop = dragEvent(content.querySelector(".builder-section-added"), { clientY, transfer });
    assert.equal(drag.dropBuilderLibraryDrag(drop, { onDrop: (...args) => drops.push(args) }), true);
    assert.equal(drop.defaultPrevented, true);
    assert.deepEqual(drops.at(-1), ["lib-new", index]);
    assert.equal(content.querySelectorAll(".is-library-dragging, .is-library-drop-target, .is-drop-before, .is-drop-after").length, 0);
  }
  const transfer = beginDrag();
  drag.dropBuilderLibraryDrag(dragEvent(content.querySelector(".builder-section-library"), { clientY: 125, transfer }), { onDrop: (...args) => drops.push(args) });
  assert.equal(drops.length, 4, "a drop outside the Added column adds nothing");
  // No added exercise in view (one open for editing): at the end.
  for (const item of content.querySelectorAll(".builder-section-added > [data-drag-item]")) item.getClientRects = () => [];
  const transferEnd = beginDrag();
  drag.dropBuilderLibraryDrag(dragEvent(content.querySelector(".builder-section-added"), { clientY: 90, transfer: transferEnd }), { onDrop: (...args) => drops.push(args) });
  assert.deepEqual(drops.at(-1), ["lib-new", Number.MAX_SAFE_INTEGER]);
});

test("4. another drag (a file, a text) is left to the browser, and a touch-only screen or a drop in progress does not drag", () => {
  addedColumn(["a"]);
  const over = dragEvent(content.querySelector(".builder-section-added"), { clientY: 120 });
  assert.equal(drag.overBuilderLibraryDrag(over), false);
  assert.equal(over.defaultPrevented, false);
  assert.equal(drag.dropBuilderLibraryDrag(dragEvent(content.querySelector(".builder-section-added")), { onDrop: () => assert.fail("not ours") }), false);

  const blocked = dragEvent(content.querySelector("article"));
  drag.startBuilderLibraryDrag(blocked, { isBlocked: () => true });
  assert.equal(blocked.defaultPrevented, true);
  assert.equal(drag.overBuilderLibraryDrag(dragEvent(content.querySelector(".builder-section-added"))), false);

  // The Added column not on screen (a narrow window shows one at a time): no drag.
  content.querySelector(".builder-section-added").getClientRects = () => [];
  const hidden = dragEvent(content.querySelector("article"));
  drag.startBuilderLibraryDrag(hidden);
  assert.equal(hidden.defaultPrevented, true);
  content.querySelector(".builder-section-added").getClientRects = () => [{}];

  const screens = (matching) => { globalThis.matchMedia = (query) => ({ matches: matching.includes(query) }); };
  screens(["(pointer: coarse)"]);
  const touch = dragEvent(content.querySelector("article"));
  drag.startBuilderLibraryDrag(touch);
  assert.equal(touch.defaultPrevented, true);
  assert.equal(drag.libraryDragAvailable(), false);
  assert.doesNotMatch(renderBuilderExerciseResults([{ id: "e1", name: "Skip" }], new Set(), null), /draggable/);
  screens(["(pointer: coarse)", "(any-pointer: fine)", "(any-hover: hover)"]);
  assert.equal(drag.libraryDragAvailable(), false, "a tablet with a pen or a trackpad keeps Add");
  screens(["(pointer: fine)", "(hover: hover)", "(any-pointer: coarse)"]);
  assert.equal(drag.libraryDragAvailable(), true, "a computer, also one with a touch screen, drags");
});

test("4b. a card re-rendered while it is dragged (its dragend never comes) leaves later drags of files or text to the browser", () => {
  addedColumn(["a"]);
  beginDrag();
  // The add confirmation repaints the results under the drag: the card is gone, no dragend.
  content.querySelector(".builder-exercise-results").innerHTML = "";
  const zone = content.querySelector(".builder-section-added");
  const foreign = { types: ["Files"], getData: () => "", dropEffect: "" };
  const over = dragEvent(zone, { clientY: 120, transfer: foreign });
  assert.equal(drag.overBuilderLibraryDrag(over), false);
  assert.equal(over.defaultPrevented, false);
  assert.equal(content.querySelectorAll(".is-library-dragging, .is-library-drop-target").length, 0, "the leftover outline goes");
  const drop = dragEvent(zone, { clientY: 120, transfer: foreign });
  assert.equal(drag.dropBuilderLibraryDrag(drop, { onDrop: () => assert.fail("not a library drag") }), false);
  assert.equal(drop.defaultPrevented, false);

  // A moving pointer after such a drag also cleans up: no pointer events come while dragging.
  addedColumn(["a"]);
  beginDrag();
  content.querySelector(".builder-exercise-results").innerHTML = "";
  assert.ok(content.querySelector(".is-library-dragging"));
  assert.equal(drag.endStaleBuilderLibraryDrag(), true);
  assert.equal(content.querySelectorAll(".is-library-dragging").length, 0);
  assert.equal(drag.endStaleBuilderLibraryDrag(), false, "nothing left: nothing to do");

  // The drag itself says which exercise it carries, whatever was cleaned up.
  addedColumn(["a"]);
  const transfer = beginDrag();
  drag.endStaleBuilderLibraryDrag();
  const drops = [];
  drag.dropBuilderLibraryDrag(dragEvent(content.querySelector(".builder-section-added"), { clientY: 90, transfer }), { onDrop: (...args) => drops.push(args) });
  assert.deepEqual(drops, [["lib-new", 0]]);
});

test("5. on a computer the library cards are draggable as their exercise; the Add button stays", () => {
  const html = renderBuilderExerciseResults([{ id: "e1", name: "Skip" }], new Set(), null);
  assert.match(html, /<article class="builder-exercise-result " draggable="true" data-builder-library-drag data-exercise-id="e1">/);
  assert.match(html, /data-action="builder-pick-exercise" data-exercise-id="e1"/);
  assert.doesNotMatch(renderBuilderExerciseResult({ id: "e1", name: "Skip" }, new Set()), /draggable/, "only when asked");
});

test("6. a dropped exercise is added with the typed dose and moved to where it was dropped", async () => {
  state.builder = emptyBuilderState({ draft: draft(["a", "b", "c"]), selectedNodeId: "section-1" });
  content.innerHTML = `<div class="builder-section-panel"><input data-builder-new-dose name="sets" value="3"><input data-builder-new-dose name="reps" value="8"><input data-builder-new-dose name="load" value=""></div>`;
  let serverOrder = ["a", "b", "c"];
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.endsWith("/exercises")) serverOrder = [...serverOrder, "n"];
    else {
      const id = decodeURIComponent(url.match(/items\/([^/]+)\/move/)[1]);
      const index = serverOrder.indexOf(id);
      const other = index + (body.direction === "up" ? -1 : 1);
      [serverOrder[index], serverOrder[other]] = [serverOrder[other], serverOrder[index]];
    }
    return response(draft(serverOrder));
  };
  const paints = [];
  const handlers = {
    renderBuilder() { paints.push("builder"); },
    renderBuilderSectionItems() { paints.push(order().join("")); return true; },
    renderBuilderAddFeedback() { paints.push("added"); return true; },
    async refreshBuilderDraft() { assert.fail("nothing failed"); },
  };
  assert.equal(await dropBuilderLibraryExercise("lib-new", 1, handlers), true);
  assert.deepEqual(calls[0], { url: "/api/builder/nodes/section-1/exercises", body: { exerciseId: "lib-new", sets: "3", reps: "8", load: "" } });
  assert.deepEqual(calls.slice(1).map((call) => [call.url, call.body.direction]), [["/api/builder/items/n/move", "up"], ["/api/builder/items/n/move", "up"]]);
  assert.deepEqual(order(), ["a", "n", "b", "c"]);
  assert.equal(state.builder.addConfirmation?.itemId, "n", "the added confirmation names it");
  assert.equal(paints[0], "added");

  calls.length = 0;
  assert.equal(await dropBuilderLibraryExercise("lib-other", 9, handlers), true);
  assert.equal(calls.length, 1, "dropped below the last one: added at the end, no move");
});

test("7. one drop at a time, and none while an added exercise is being moved", async () => {
  state.builder = emptyBuilderState({ draft: draft(["a"]), selectedNodeId: "section-1" });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let posts = 0;
  globalThis.fetch = async () => { posts += 1; await gate; return response(draft(["a", "n"])); };
  const handlers = { renderBuilder() {}, renderBuilderSectionItems: () => true, renderBuilderAddFeedback: () => true };
  const first = dropBuilderLibraryExercise("lib-new", 0, handlers);
  assert.equal(builderLibraryDropBlocked(), true);
  assert.equal(await dropBuilderLibraryExercise("lib-new", 0, handlers), false);
  release();
  globalThis.fetch = async (url) => response(draft(url.includes("/move") ? ["n", "a"] : ["a", "n"]));
  await first;
  assert.equal(posts, 1);
  assert.equal(builderLibraryDropBlocked(), false);
  state.builder.itemMovePending = { planId: "draft-1" };
  assert.equal(builderLibraryDropBlocked(), true);
  assert.equal(await dropBuilderLibraryExercise("lib-new", 0, handlers), false);
});

test("8. a section editor loads its library when it opens: an empty search lists every exercise, once", async () => {
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ draft: draft(["a"]), exerciseQuery: "" });
  state.markedExerciseIds = new Set();
  state.exerciseSearch.options.purposes = ["Strength"];
  content.innerHTML = `<div class="builder-exercise-results"></div>`;
  const requests = [];
  let fail = true;
  globalThis.fetch = async (path) => {
    const url = new URL(path, "http://localhost");
    requests.push(url);
    if (fail) return response({ error: "Database busy." }, 503);
    return response({ exercises: [{ id: "e1", name: "Skip" }, { id: "e2", name: "Squat" }], hasMore: false });
  };
  const ensured = [];
  const handlers = { renderBuilder() {}, ensureBuilderExercises: () => ensured.push(ensureBuilderExercises()?.catch(() => {})) };
  await handleBuilderWorkspaceAction({ dataset: { action: "builder-select-node", sessionId: "session-1", nodeId: "section-1" } }, handlers);
  await Promise.all(ensured);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get("search"), "");
  assert.match(content.innerHTML, /could not be loaded/);

  fail = false;
  await handleBuilderWorkspaceAction({ dataset: { action: "builder-select-node", sessionId: "session-1", nodeId: "section-1" } }, handlers);
  await Promise.all(ensured);
  assert.equal(requests.length, 2, "an earlier failure is tried again when the editor opens");
  assert.deepEqual(state.builder.exercises.map((exercise) => exercise.id), ["e1", "e2"]);
  assert.match(content.innerHTML, /Skip[\s\S]*Squat/);

  await handleBuilderWorkspaceAction({ dataset: { action: "builder-select-node", sessionId: "session-1", nodeId: "section-1" } }, handlers);
  assert.equal(ensured.at(-1), undefined, "the list on hand is current: no new request");
  assert.equal(requests.length, 2);
  state.builder.exerciseLoadFailed = true;
  await ensureBuilderExercises();
  assert.equal(requests.length, 3, "a later reload of the same search that failed is tried again too");

  // Opening an editor that is scrolled leaves it where it is (a landscape
  // phone's results do not scroll on their own; a new search would bring
  // the editor back to the library's top).
  content.innerHTML = `<section class="builder-section-modal"><section class="builder-section-library"><div class="builder-exercise-results"></div></section></section>`;
  const modal = content.querySelector(".builder-section-modal");
  let modalScroll = 500;
  Object.defineProperty(modal, "scrollTop", { get: () => modalScroll, set: (value) => { modalScroll = value; } });
  modal.getBoundingClientRect = () => ({ top: 0 });
  content.querySelector(".builder-section-library").getBoundingClientRect = () => ({ top: -400 });
  state.builder.exerciseQuery = "Sk";
  globalThis.getComputedStyle = () => ({ overflowY: "visible" });
  try {
    await ensureBuilderExercises();
  } finally {
    delete globalThis.getComputedStyle;
  }
  assert.equal(modalScroll, 500, "the editor stays where it was");

  state.builder.selectedNodeId = "";
  assert.equal(ensureBuilderExercises(), null, "no section open, no library");
  state.builder.selectedNodeId = "section-1";
  state.activeTab = "weekly";
  assert.equal(ensureBuilderExercises(), null);
});

test("9. a new section opens its editor with the library loaded", async () => {
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ draft: draft([]) });
  const withSection = draft([]);
  withSection.blocks[0].sessions[0].nodes.push({ id: "section-2", type: "section", items: [] });
  globalThis.fetch = async () => response(withSection);
  const form = document.createElement("form");
  form.dataset.builderForm = "add-node";
  form.dataset.sessionId = "session-1";
  let ensured = 0;
  await submitBuilderForm(form, { renderBuilder() {}, ensureBuilderExercises: () => { ensured += 1; } });
  assert.equal(state.builder.selectedNodeId, "section-2");
  assert.equal(ensured, 1);
});

test("10. the app wires the drag to the drop action, and every section opening to the library load", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /els\.content\.addEventListener\("dragstart", \(event\) => \{ startBuilderLibraryDrag\(event, \{ isBlocked: builderLibraryDropBlocked \}\); \}\);/);
  assert.match(app, /els\.content\.addEventListener\("dragover", overBuilderLibraryDrag\);/);
  assert.match(app, /els\.content\.addEventListener\("dragleave", leaveBuilderLibraryDrag\);/);
  assert.match(app, /els\.content\.addEventListener\("dragend", endBuilderLibraryDrag\);\s*document\.addEventListener\("pointermove", endStaleBuilderLibraryDrag, \{ passive: true \}\);/);
  // The reorder drag waits for a library drop being placed, too.
  assert.match(app, /startBuilderItemDrag\(event, \{[^}]*isBlocked: builderLibraryDropBlocked,/);
  assert.match(app, /dropBuilderLibraryDrag\(event, \{\s*onDrop: \(exerciseId, index\) => \{\s*void dropBuilderLibraryExercise\(exerciseId, index, \{ renderBuilder, renderBuilderSectionItems, renderBuilderAddFeedback, refreshBuilderDraft \}\)\.catch\(renderBuilderError\);/);
  assert.equal(app.match(/ensureBuilderExercises: ensureBuilderExercisesQuietly/g)?.length, 3, "both form paths and the workspace actions");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.builder-section-panel\.is-library-dragging \.builder-section-added \{ outline: 2px dashed var\(--accent\);/);
  assert.match(css, /\.builder-section-added\.is-library-drop-target \{ background: var\(--accent-soft\); \}/);
  assert.match(css, /@media \(max-width: 560px\) \{\s*\.builder-exercise-result\[draggable="true"\] \{ cursor: default; \}/, "no grab hand where nothing can be dropped");
  assert.match(css, /@media \(max-width: 760px\), \(pointer: coarse\) \{\s*\.builder-exercise-load-failed \.text-action \{ display: inline-flex; align-items: center; min-width: 44px; min-height: 44px; \}/, "Try again is a whole touch target");
});

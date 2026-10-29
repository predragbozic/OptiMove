// Training Load -> Data configuration -> Categories: dragging a variable onto
// a category on a computer (PR-2, docs/ai/data-configuration-visual-proposal.md
// section 6). Driven through the real handlers, the real drag handlers and the
// real markup in a DOM, with a fake fetch and a fake drag, so both what the
// screen sends and what it shows are proved: the tray and its one read, only
// on a computer and never for a coach; the drop targets (this workspace's own
// active categories only); the one link create a drop sends (the same body as
// Add to a category, never an owner, actor or basis); "already there" from the
// server's link_exists; a refusal as a warning; Undo for 10 seconds through
// the link remove; a lost answer checked by the very same request while every
// other drop waits; and the guards on leaving.
import { after, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";

const dom = new JSDOM(`<!doctype html><body><section id="content"></section></body>`);
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
let confirmAnswer = true;
const confirmQuestions = [];
dom.window.confirm = (question) => { confirmQuestions.push(question); return confirmAnswer; };
// The main pointer: a mouse (a computer) or a finger (a phone or tablet).
let computer = true;
const media = (query) => ({
  matches: computer && (query === "(pointer: fine)" || query === "(hover: hover)"),
  addEventListener: () => {}, removeEventListener: () => {},
});
globalThis.matchMedia = media;
dom.window.matchMedia = media;

let respond = () => ({ status: 404, body: { error: "notFound" } });
const calls = installFetchMock((call) => respond(call));
after(() => restoreFetch());

const { dropVariablesForm, handleVariablesAction, loadVariablesSection, resetVariables, variablesMayBeLeft, variablesUnloadShouldWarn } = await import("../metric-variables-actions.js");
const { variablesState } = await import("../metric-variables-data.js");
const { openClassificationForm } = await import("../metric-classification-data.js");
const { renderVariablesHtml } = await import("../metric-variables-view.js");
const { VARIABLE_DRAG_TYPE, dropVariableDrag, endVariableDrag, leaveVariableDrag, overVariableDrag, startVariableDrag } = await import("../data-config-drag.js");
const { UNDO_MS, dropBlocked, dropVariableOnCategory } = await import("../metric-classification-drag.js");
const { state } = await import("../state.js");

const VB = "/api/training-load/sources/metrics/variables";
const CB = "/api/training-load/sources/metrics/classification";
const FB = "/api/training-load/sources/metrics/fields";
const LINKS = `${CB}/links`;
const TRAY = `${VB}?scope=own&state=active`;
const CLUB = "11111111-0000-4000-8000-000000000001";
const TEAM = "22222222-0000-4000-8000-000000000001";
const V1 = "aaaaaaaa-1111-4000-8000-000000000001";
const V2 = "aaaaaaaa-1111-4000-8000-000000000002";
const D1 = "dddddddd-0000-4000-8000-000000000001";
const C1 = "cccccccc-0000-4000-8000-000000000001";
const C2 = "cccccccc-0000-4000-8000-000000000002";
const C3 = "cccccccc-0000-4000-8000-000000000003";
const C4 = "cccccccc-0000-4000-8000-000000000004";
const L1 = "eeeeeeee-0000-4000-8000-000000000001";
const LNEW = "eeeeeeee-0000-4000-8000-000000000009";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = "b".repeat(64);

const node = (over = {}) => ({ id: D1, key: "endurance", name: "Endurance", description: null, ownerScope: "system", state: "active", editable: true, actions: ["rename", "archive"], namesToken: TOKEN, truncated: false, ...over });
// The platform's tree: Aerobic capacity in Endurance, Sprint in no domain,
// Old work archived, and a club's own category the platform never sees as its own.
const platformTree = () => ({
  domains: [node()],
  categories: [
    node({ id: C1, key: "aerobic_capacity", name: "Aerobic capacity" }),
    node({ id: C2, key: "sprint", name: "Sprint <b>" }),
    node({ id: C3, key: "old_work", name: "Old work", state: "archived", actions: ["restore"] }),
  ],
  categoryDomains: [{ id: L1, variableId: null, categoryId: C1, domainId: D1, ownerScope: "system", editable: true, actions: ["remove"] }],
  truncated: false,
});
const variable = (over = {}) => ({
  id: V1, key: "total_distance", label: "Total distance", shortLabel: null, description: null, ownerScope: "system", state: "active", editable: true,
  levels: ["session"], currentVersion: { id: "v1", versionNumber: 1, unit: "m", valueType: "numeric", dailyAggregationMethod: "sum", minValue: null, maxValue: null, condition: null, createdAt: "2026-10-20T08:00:00.000Z" },
  mappingTarget: { ready: true, notReadyCode: null }, createdAt: "2026-10-20T08:00:00.000Z", updatedAt: "2026-10-20T08:00:00.000Z", truncated: false,
  actions: ["rename", "archive", "newVersion"], labelsToken: "a".repeat(64), ...over,
});

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderVariablesHtml(); };
// The drag handlers as app.js binds them on the content.
let lastDrop = Promise.resolve();
content.addEventListener("dragstart", (event) => { startVariableDrag(event, { isBlocked: dropBlocked }); });
content.addEventListener("dragover", overVariableDrag);
content.addEventListener("dragleave", leaveVariableDrag);
content.addEventListener("drop", (event) => {
  dropVariableDrag(event, { onDrop: (variableId, categoryId) => { lastDrop = dropVariableOnCategory(variableId, categoryId, { render }); } });
});
content.addEventListener("dragend", endVariableDrag);

const $ = (selector) => content.querySelector(selector);
const text = () => content.textContent.replace(/\s+/g, " ");
const posts = () => calls.filter((call) => call.method === "POST");
const gets = () => calls.filter((call) => call.method === "GET").map((call) => call.url);
const chip = (id) => $(`[data-dc-drag-variable][data-variable-id="${id}"]`);
const targetIds = () => [...content.querySelectorAll("[data-dc-drop-category]")].map((li) => li.dataset.categoryId);
const categoryButton = (id) => $(`[data-action="metric-classification-open"][data-kind="category"][data-node-id="${id}"]`);

async function click(selector) {
  const element = $(selector);
  assert.ok(element, `${selector} is on the screen`);
  await handleVariablesAction(element, { render });
}

// The browser's drag, as far as the handlers read it: its types and data.
function newTransfer() {
  const store = {};
  return {
    types: [], effectAllowed: "", dropEffect: "",
    setData(type, value) { store[type] = value; if (!this.types.includes(type)) this.types.push(type); },
    getData(type) { return store[type] || ""; },
    clearData() { for (const key of Object.keys(store)) delete store[key]; this.types.length = 0; },
  };
}
function fire(type, target, dataTransfer, { relatedTarget = null } = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  target.dispatchEvent(event);
  return event;
}
// A whole drag: start on a variable in the tray, over the category, drop.
async function drag(variableId, categoryId) {
  const transfer = newTransfer();
  const start = fire("dragstart", chip(variableId), transfer);
  if (start.defaultPrevented) return { start };
  const over = fire("dragover", categoryButton(categoryId), transfer);
  const drop = fire("drop", categoryButton(categoryId), transfer);
  await lastDrop;
  return { start, over, drop, transfer };
}

function asPlatform() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null, label: "Platform", role: "platform_admin" } };
}
function asClub() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "FK Borac", role: "club_admin" } };
}
function asCoach() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "team", scopeId: TEAM, clubId: CLUB, label: "First team", role: "team_coach" } };
}

// The reads answer from `tree` / `trayItems`; the writes from `post(call)`.
let tree = platformTree();
let trayItems = [variable(), variable({ id: V2, key: "max_speed", label: "Max <i>speed</i>" })];
let trayCursor = null;
let trayAnswer = null;
function serve(post = () => ({ status: 404, body: { error: "notFound" } })) {
  respond = (call) => {
    if (call.method === "GET" && call.url === CB) return { status: 200, body: tree };
    if (call.method === "GET" && call.url === FB) return { status: 200, body: { fields: [] } };
    if (call.method === "GET" && call.url === TRAY) return trayAnswer || { status: 200, body: { variables: trayItems, nextCursor: trayCursor } };
    if (call.method === "POST") return post(call);
    return { status: 404, body: { error: "notFound" } };
  };
}
const created = (linkId = LNEW) => ({ status: 201, body: { link: { id: linkId, variableId: V1, categoryId: C2, domainId: null, ownerScope: "system", editable: true, actions: ["remove"] } } });
const removed = (linkId = LNEW) => ({ status: 200, body: { link: { id: linkId, present: false } } });

// The Categories screen, opened from the start screen's card.
async function openCategories() {
  await loadVariablesSection(render);
  calls.length = 0;
  await click('[data-action="metric-classification-view"][data-view="categories"]');
}

beforeEach(() => {
  mock.timers.reset();
  resetVariables();
  calls.length = 0;
  confirmQuestions.length = 0;
  confirmAnswer = true;
  computer = true;
  tree = platformTree();
  trayItems = [variable(), variable({ id: V2, key: "max_speed", label: "Max <i>speed</i>" })];
  trayCursor = null;
  trayAnswer = null;
  serve();
  state.activeTab = "training-load";
  state.trainingLoad.section = "variables";
  asPlatform();
  content.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Where the drag is offered
// ---------------------------------------------------------------------------
test("on a computer the Categories screen reads the tray once beside the tree; the variables are draggable and escaped; only this workspace's own active categories take a drop", async () => {
  await openCategories();
  assert.deepEqual(gets().sort(), [CB, TRAY].sort(), "one read of the tree and one of the tray");
  const tray = $(".dc-tray");
  assert.ok(tray, "the tray is beside the categories");
  assert.equal(tray.querySelector("h3").textContent, "Variables");
  assert.match(tray.textContent.replace(/\s+/g, " "), /Drag a variable onto a category to add it there\. Adding never moves it: it stays in any category it is already in\. Without a mouse: under Variables, open a variable and choose Add to a category\./);
  assert.equal(chip(V1).getAttribute("draggable"), "true");
  assert.equal(chip(V2).querySelector(".dc-chip-label").textContent, "Max <i>speed</i>");
  assert.ok(content.innerHTML.includes("Max &lt;i&gt;speed&lt;/i&gt;"), "a variable's label is escaped");
  assert.deepEqual(targetIds(), [C1, C2], "the two active system categories; the archived one takes nothing");
  assert.ok(!$(`.dc-archived [data-dc-drop-category]`), "no archived category is a target");
});

test("in a club workspace only the club's own active categories take a drop, never the system's", async () => {
  asClub();
  tree = platformTree();
  tree.categories.push(node({ id: C4, key: "club_work", name: "Club work", ownerScope: "club" }));
  await openCategories();
  assert.deepEqual(targetIds(), [C4]);
  // The tray says it holds the club's own variables, and how a system one is added.
  assert.equal($(".dc-tray h3").textContent, "This club's variables");
  assert.match($(".dc-tray").textContent.replace(/\s+/g, " "), /System variables are not listed here: to add one, open it under Variables, in System \(reference\), and choose Add to a category\. Without a mouse, open any variable under Variables and choose Add to a category\./);
  const { over } = await drag(V1, C1);
  assert.equal(over.defaultPrevented, false, "a system category refuses the drag");
  assert.equal(posts().length, 0, "and nothing is sent");
});

test("on a phone or tablet, and for a team's coach, there is no tray, no target and no tray read", async () => {
  computer = false;
  await openCategories();
  assert.ok(!$(".dc-tray") && !targetIds().length);
  assert.deepEqual(gets(), [CB], "the tree only");
  resetVariables();
  computer = true;
  asCoach();
  await openCategories();
  assert.ok(!$(".dc-tray") && !targetIds().length);
  assert.ok(!gets().includes(TRAY));
  assert.equal(await dropVariableOnCategory(V1, C1, { render }), undefined);
  assert.equal(posts().length, 0, "a coach's drop sends nothing, whatever reaches the handler");
});

test("the tray says when it is empty, when only the first 100 are shown, and a failed read is tried again", async () => {
  trayItems = [];
  await openCategories();
  assert.match($(".dc-tray").textContent, /There are no active variables here yet\. Create one under Variables\./);
  resetVariables();
  asClub();
  tree.categories.push(node({ id: C4, key: "club_work", name: "Club work", ownerScope: "club" }));
  await openCategories();
  assert.match($(".dc-tray").textContent.replace(/\s+/g, " "), /This club has no variables of its own yet\. To add a system variable to a category, open it under Variables, in System \(reference\), and choose Add to a category\./);
  asPlatform();
  resetVariables();
  trayItems = [variable()];
  trayCursor = "next";
  await openCategories();
  assert.match($(".dc-tray").textContent, /The first 100 are shown\. To add another one, open it under Variables and choose Add to a category\./);
  resetVariables();
  trayAnswer = { status: 500, body: { error: "internal_error" } };
  await openCategories();
  assert.match($(".dc-tray").textContent, /The variables could not be loaded\./);
  trayAnswer = null;
  calls.length = 0;
  await click('[data-action="metric-classification-tray-reload"]');
  assert.deepEqual(gets(), [TRAY]);
  assert.ok(chip(V1));
});

test("with no category to take a drop the tray says to create one first", async () => {
  tree.categories = [node({ id: C3, key: "old_work", name: "Old work", state: "archived", actions: ["restore"] })];
  tree.categoryDomains = [];
  await openCategories();
  assert.match($(".dc-tray").textContent, /Create a category first, then drag variables onto it\./);
});

// ---------------------------------------------------------------------------
// The drag itself
// ---------------------------------------------------------------------------
test("the drag carries only the variable's id under its own type; a category under the pointer is marked and allows the drop; elsewhere nothing is allowed", async () => {
  await openCategories();
  const transfer = newTransfer();
  transfer.setData("text/html", "<b>stray</b>");
  const start = fire("dragstart", chip(V1).querySelector(".dc-chip-label"), transfer);
  assert.equal(start.defaultPrevented, false);
  assert.deepEqual(transfer.types, [VARIABLE_DRAG_TYPE], "only this drag's own type, no markup");
  assert.equal(transfer.getData(VARIABLE_DRAG_TYPE), V1);
  assert.equal(transfer.effectAllowed, "copy");
  assert.ok(chip(V1).classList.contains("is-dragging") && $(".dc-drag-board").classList.contains("is-dragging"));

  const over = fire("dragover", categoryButton(C2), transfer);
  assert.equal(over.defaultPrevented, true);
  assert.equal(transfer.dropEffect, "copy");
  assert.ok($(`[data-dc-drop-category][data-category-id="${C2}"]`).classList.contains("is-drop-target"));
  // Moving inside the category keeps the mark; leaving it takes it away.
  const inner = categoryButton(C2).querySelector(".metric-variables-item-name");
  fire("dragleave", categoryButton(C2), transfer, { relatedTarget: inner });
  assert.ok($(`[data-category-id="${C2}"]`).classList.contains("is-drop-target"));
  fire("dragleave", categoryButton(C2), transfer, { relatedTarget: $(".dc-tray") });
  assert.ok(!$(`[data-category-id="${C2}"]`).classList.contains("is-drop-target"));
  // Over another category: only that one is marked.
  fire("dragover", categoryButton(C2), transfer);
  fire("dragover", categoryButton(C1), transfer);
  assert.deepEqual([...content.querySelectorAll(".is-drop-target")].map((li) => li.dataset.categoryId), [C1]);
  // Not over a category: nothing allowed, nothing marked.
  const outside = fire("dragover", $(".dc-tray"), transfer);
  assert.equal(outside.defaultPrevented, false);
  assert.equal(content.querySelectorAll(".is-drop-target").length, 0);
  // Dropped outside a category: nothing is sent and the marks go.
  fire("drop", $(".dc-tray"), transfer);
  await lastDrop;
  assert.equal(posts().length, 0);
  assert.ok(!content.querySelector(".is-dragging"));
});

test("a drag that is not a variable's is left alone, and a drag that ends anywhere clears its marks", async () => {
  await openCategories();
  const other = newTransfer();
  other.setData("text/plain", V1);
  const over = fire("dragover", categoryButton(C1), other);
  assert.equal(over.defaultPrevented, false);
  const drop = fire("drop", categoryButton(C1), other);
  assert.equal(drop.defaultPrevented, false);
  await lastDrop;
  assert.equal(posts().length, 0);
  const transfer = newTransfer();
  fire("dragstart", chip(V1), transfer);
  fire("dragover", categoryButton(C1), transfer);
  fire("dragend", chip(V1), transfer);
  assert.ok(!content.querySelector(".is-dragging") && !content.querySelector(".is-drop-target"));
});

test("a drop sends one link create with exactly the request key, the variable and the category; the screen says so and offers Undo; the list is read again later", async () => {
  serve(() => created());
  await openCategories();
  variablesState().list = { ...variablesState().list, loaded: true };
  const { drop } = await drag(V1, C2);
  assert.equal(drop.defaultPrevented, true);
  assert.equal(posts().length, 1);
  const [call] = posts();
  assert.equal(call.url, LINKS);
  assert.deepEqual(Object.keys(call.body).sort(), ["categoryId", "requestKey", "variableId"], "never an owner, actor or basis");
  assert.match(call.body.requestKey, UUID);
  assert.equal(call.body.variableId, V1);
  assert.equal(call.body.categoryId, C2);
  assert.match(text(), /Total distance was added to Sprint <b>\./);
  assert.ok(content.innerHTML.includes("Sprint &lt;b&gt;"), "the category's name is escaped in the line");
  assert.ok($('[data-action="metric-classification-drop-undo"]'));
  assert.equal(variablesState().list.loaded, false, "the list's category filter counts are read again when it is shown");
  // A second drop of the same pair is sent again: the server decides.
  serve(() => ({ status: 409, body: { error: "link_exists" } }));
  await drag(V1, C2);
  assert.equal(posts().length, 2);
  assert.notEqual(posts()[1].body.requestKey, call.body.requestKey, "a new drop is a new request");
});

test("two fast drops on the same category send exactly one request: the second waits for the first and is not sent", async () => {
  let release;
  serve(() => new Promise((resolve) => { release = resolve; }));
  await openCategories();
  for (let i = 0; i < 2; i += 1) {
    const transfer = newTransfer();
    fire("dragstart", chip(V1), transfer);
    fire("dragover", categoryButton(C2), transfer);
    fire("drop", categoryButton(C2), transfer);
  }
  assert.equal(posts().length, 1, "the second drop, while the first is being saved, sends nothing");
  release(created());
  await lastDrop;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posts().length, 1);
  assert.match(text(), /Total distance was added to Sprint <b>\./);
});

test("a variable already in the category: the server's link_exists reads as already there, nothing changed, no Undo", async () => {
  serve(() => ({ status: 409, body: { error: "link_exists" } }));
  await openCategories();
  await drag(V2, C1);
  assert.match(text(), /Max <i>speed<\/i> is already in Aerobic capacity\. Nothing was changed\./);
  assert.ok(!$('[data-action="metric-classification-drop-undo"]'));
  assert.ok(!$(".dc-drop-status.is-warning"), "not a warning");
});

for (const [code, status, sentence] of [
  ["variable_not_active", 409, /This variable is archived, so it cannot be linked\. Nothing was saved\./],
  ["node_archived", 409, /An archived domain or category cannot be linked\. Nothing was saved\./],
  ["link_outside_owner", 409, /This link would reach outside this workspace's own domains and categories\. Nothing was saved\./],
  ["notFound", 404, /It is not available in this workspace now, or it is no longer there\./],
]) {
  test(`a drop refused with ${code} is a warning with the screen's own sentence; nothing else changes and the next drop is free`, async () => {
    serve(() => ({ status, body: { error: code } }));
    await openCategories();
    await drag(V1, C1);
    assert.match(text(), sentence);
    assert.match(text(), /Total distance was not added to Aerobic capacity\./, "the line names the drop that failed");
    assert.ok($(".dc-drop-status.is-warning[role=alert]"));
    assert.ok(!$('[data-action="metric-classification-drop-undo"]'));
    assert.equal(dropBlocked(), false);
    assert.equal(chip(V1).getAttribute("draggable"), "true");
  });
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------
test("Undo within 10 seconds sends the link remove with a new request key and nothing else; the line says it is no longer there", async () => {
  serve((call) => (call.url === LINKS ? created() : removed()));
  await openCategories();
  await drag(V1, C2);
  const createKey = posts()[0].body.requestKey;
  await click('[data-action="metric-classification-drop-undo"]');
  assert.equal(posts().length, 2);
  const undo = posts()[1];
  assert.equal(undo.url, `${LINKS}/${LNEW}/remove`);
  assert.deepEqual(Object.keys(undo.body), ["requestKey"]);
  assert.match(undo.body.requestKey, UUID);
  assert.notEqual(undo.body.requestKey, createKey);
  assert.match(text(), /Total distance is no longer in Sprint <b>\./);
  assert.ok(!$('[data-action="metric-classification-drop-undo"]'));
});

test("after 10 seconds Undo is gone and an Undo that arrives late sends nothing", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    serve(() => created());
    await openCategories();
    await drag(V1, C2);
    const undoButton = $('[data-action="metric-classification-drop-undo"]');
    assert.ok(undoButton);
    mock.timers.tick(UNDO_MS - 1);
    assert.ok($('[data-action="metric-classification-drop-undo"]'), "still offered just before the end");
    assert.match(text(), /Total distance was added to Sprint <b>\. Undo You can undo it for 10 seconds\./);
    mock.timers.tick(1);
    assert.ok(!$('[data-action="metric-classification-drop-undo"]'), "the screen is drawn again without it");
    assert.match(text(), /Total distance was added to Sprint <b>\. To take it out, open Total distance under Variables and choose Remove next to Sprint <b>\./);
    await handleVariablesAction(undoButton, { render });
    assert.equal(posts().length, 1, "no remove after the 10 seconds");
  } finally {
    mock.timers.reset();
  }
});

test("the end of Undo does not redraw the screen under a drag of the next variable; it does once the drag is over", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    serve(() => created());
    await openCategories();
    await drag(V1, C2);
    const transfer = newTransfer();
    fire("dragstart", chip(V2), transfer);
    fire("dragover", categoryButton(C1), transfer);
    const board = $(".dc-drag-board");
    mock.timers.tick(UNDO_MS);
    assert.equal($(".dc-drag-board"), board, "not drawn again mid-drag");
    assert.ok(board.classList.contains("is-dragging") && $(`[data-category-id="${C1}"]`).classList.contains("is-drop-target"));
    await handleVariablesAction($('[data-action="metric-classification-drop-undo"]'), { render });
    assert.equal(posts().length, 1, "Undo is over even while the button is still drawn");
    fire("dragend", chip(V2), transfer);
    mock.timers.tick(500);
    assert.ok(!$('[data-action="metric-classification-drop-undo"]'), "drawn again once the drag is over");
  } finally {
    mock.timers.reset();
  }
});

test("the last drop's line sits at the top of the tray, which stays on the screen", async () => {
  serve(() => created());
  await openCategories();
  await drag(V1, C2);
  const status = $(".dc-drop-status");
  assert.ok(status && status.closest(".dc-tray"), "inside the tray");
  assert.equal($(".dc-tray").firstElementChild, status, "first in it");
});

test("the tray comes first in the page, and its list keeps where it was scrolled through a drop, its Undo and the end of Undo", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    serve((call) => (call.url === LINKS ? created() : removed()));
    await openCategories();
    assert.equal($(".dc-drag-board").firstElementChild, $(".dc-tray"), "the tray first, so its buttons come first in the tab order");
    $(".dc-tray-list").scrollTop = 120;
    await drag(V1, C2);
    assert.equal($(".dc-tray-list").scrollTop, 120, "after the drop");
    mock.timers.tick(UNDO_MS);
    assert.equal($(".dc-tray-list").scrollTop, 120, "after the end of Undo");
    await drag(V2, C1);
    await click('[data-action="metric-classification-drop-undo"]');
    assert.equal($(".dc-tray-list").scrollTop, 120, "after an Undo");
  } finally {
    mock.timers.reset();
  }
});

test("the end of Undo never draws the screen over a form being typed in", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    serve(() => created());
    await openCategories();
    await drag(V1, C2);
    await click('[data-action="metric-classification-create-open"][data-kind="category"]');
    const field = $('[data-mc-field="name"]');
    assert.ok(field, "New category opens once the drop is saved");
    mock.timers.tick(UNDO_MS);
    assert.equal($('[data-mc-field="name"]'), field, "the form is not drawn again");
    assert.equal(variablesState().drop.undoUntil, 0, "Undo is over all the same");
  } finally {
    mock.timers.reset();
  }
});

test("a name the server shortened keeps its mark in the tray and in the line", async () => {
  trayItems = [variable({ label: "A very long variable name", truncated: true })];
  tree.categories[1] = node({ id: C2, key: "sprint", name: "Sprint work of a very long name", truncated: true });
  serve(() => created());
  await openCategories();
  assert.equal(chip(V1).querySelector(".dc-chip-label").textContent, "A very long variable name…");
  await drag(V1, C2);
  assert.match(text(), /A very long variable name… was added to Sprint work of a very long name…\./);
});

test("a drag whose chip was drawn again does not hold back the end of Undo", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    serve(() => created());
    await openCategories();
    await drag(V1, C2);
    fire("dragstart", chip(V2), newTransfer());
    render();
    mock.timers.tick(UNDO_MS);
    assert.ok(!$('[data-action="metric-classification-drop-undo"]'), "the screen is drawn without Undo");
  } finally {
    mock.timers.reset();
  }
});

test("a new drop clears an earlier notice of the screen", async () => {
  serve(() => created());
  await openCategories();
  variablesState().notice = "An earlier notice.";
  render();
  assert.match(text(), /An earlier notice\./);
  await drag(V1, C2);
  assert.doesNotMatch(text(), /An earlier notice\./);
});

test("a new drop replaces the line of an unchecked one", async () => {
  const answers = [{ throwNetworkError: true }, created()];
  serve(() => answers.shift());
  await openCategories();
  await drag(V1, C2);
  await click('[data-action="metric-classification-drop-dismiss"]');
  assert.match(text(), /The result was not checked/);
  await drag(V2, C1);
  assert.doesNotMatch(text(), /The result was not checked/);
  assert.match(text(), /Max <i>speed<\/i> was added to Aerobic capacity\./);
});

test("an Undo the server refuses is a warning with the remove's sentence", async () => {
  serve((call) => (call.url === LINKS ? created() : { status: 404, body: { error: "notFound" } }));
  await openCategories();
  await drag(V1, C2);
  await click('[data-action="metric-classification-drop-undo"]');
  assert.match(text(), /Undo did not go through\. It is not available in this workspace now, or it is no longer there\. Open Total distance under Variables to see its categories\./);
  assert.ok($(".dc-drop-status.is-warning"));
});

// ---------------------------------------------------------------------------
// A lost answer is checked by the very same request
// ---------------------------------------------------------------------------
for (const [name, lost] of [
  ["no answer", { throwNetworkError: true }],
  ["503 outcome_unknown", { status: 503, body: { error: "outcome_unknown" } }],
  ["an uncoded 502", { status: 502, body: {} }],
]) {
  test(`${name}: Result not confirmed; every other drop waits; Check result sends the same body; a busy check stays unconfirmed; a replayed save settles it`, async () => {
    const answers = [lost, { status: 409, body: { error: "try_again" } }, { status: 201, body: { replayed: true, link: { id: LNEW } } }];
    serve(() => answers.shift());
    await openCategories();
    await drag(V1, C2);
    const first = posts()[0].body;
    assert.match(text(), /Result not confirmed\. No confirmation arrived, so it is not known whether Total distance was added to Sprint <b>\. Check result sends the same request again: it is never saved twice\./);
    assert.equal(dropBlocked(), true);
    assert.ok($(".dc-drag-board.is-locked"));
    assert.equal(chip(V2).getAttribute("draggable"), "false");
    const { start } = await drag(V2, C1);
    assert.equal(start.defaultPrevented, true, "another drag does not start");
    assert.equal(await dropVariableOnCategory(V2, C1, { render }), undefined);
    assert.equal(posts().length, 1, "and nothing else is sent");

    await click('[data-action="metric-classification-drop-check"]');
    assert.deepEqual(posts()[1].body, first, "the very same body, request key included");
    assert.equal(posts()[1].url, LINKS);
    assert.match(text(), /The check could not be done: the server was busy\. The result is still not confirmed/);
    assert.equal(dropBlocked(), true);

    await click('[data-action="metric-classification-drop-check"]');
    assert.deepEqual(posts()[2].body, first);
    assert.match(text(), /Total distance was added to Sprint <b>\./);
    assert.equal(dropBlocked(), false);
    assert.ok($('[data-action="metric-classification-drop-undo"]'));
  });
}

test("a check answered link_exists settles as already there; an Undo whose answer is lost is checked with the same remove", async () => {
  const answers = [{ throwNetworkError: true }, { status: 409, body: { error: "link_exists" } }];
  serve(() => answers.shift());
  await openCategories();
  await drag(V1, C2);
  await click('[data-action="metric-classification-drop-check"]');
  assert.match(text(), /Total distance is already in Sprint <b>\. Nothing was changed\./);
  assert.equal(dropBlocked(), false);

  const more = [created(), { throwNetworkError: true }, removed()];
  serve(() => more.shift());
  await drag(V1, C1);
  await click('[data-action="metric-classification-drop-undo"]');
  assert.match(text(), /it is not known whether Total distance was removed from Aerobic capacity/);
  const undo = posts().at(-1);
  await click('[data-action="metric-classification-drop-check"]');
  assert.deepEqual(posts().at(-1).body, undo.body);
  assert.equal(posts().at(-1).url, undo.url);
  assert.match(text(), /Total distance is no longer in Aerobic capacity\./);
});

test("Close without checking ends the status, says the result was not checked and reads the list again", async () => {
  serve(() => ({ throwNetworkError: true }));
  await openCategories();
  variablesState().list = { ...variablesState().list, loaded: true };
  await drag(V1, C2);
  await click('[data-action="metric-classification-drop-dismiss"]');
  assert.equal(variablesState().drop.phase, "unchecked", "nothing is pending any more");
  assert.match($(".dc-tray .dc-drop-status").textContent.replace(/\s+/g, " "), /The result was not checked\. To see whether Total distance is in Sprint <b>, open Total distance under Variables\./, "said in the tray, where the box was");
  assert.equal(variablesUnloadShouldWarn(), false);
  assert.equal(variablesState().list.loaded, false);
  assert.equal(dropBlocked(), false);
});

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------
test("a drop in flight or not confirmed asks before leaving and before the page is closed; declined keeps it, accepted ends it and reads the list again", async () => {
  let release;
  serve(() => new Promise((resolve) => { release = resolve; }));
  await openCategories();
  const transfer = newTransfer();
  fire("dragstart", chip(V1), transfer);
  fire("dragover", categoryButton(C2), transfer);
  fire("drop", categoryButton(C2), transfer);
  assert.match(text(), /Adding Total distance to Sprint <b>\.\.\./);
  assert.equal(variablesUnloadShouldWarn(), true);
  confirmAnswer = false;
  assert.equal(variablesMayBeLeft(), false);
  assert.deepEqual(confirmQuestions, ["Total distance is still being added to Sprint <b>. Leave anyway? You will not see whether it was added."]);
  release({ throwNetworkError: true });
  await lastDrop;
  assert.match(text(), /Result not confirmed\./);
  assert.equal(variablesMayBeLeft(), false);
  assert.equal(confirmQuestions[1], "It is not confirmed whether Total distance was added to Sprint <b>. Leave without checking? Open Total distance under Variables later to see its categories.");
  // Within the screen: going back to the start asks the same, and stays when declined.
  await click('[data-action="metric-classification-view"][data-view="home"]');
  assert.equal(variablesState().view, "categories");
  // Leaving Training Load once agreed (app.js drops the form): the drop ends
  // and the list, which it may have changed, is read again when shown.
  confirmAnswer = true;
  variablesState().list = { ...variablesState().list, loaded: true };
  assert.equal(variablesMayBeLeft(), true);
  dropVariablesForm();
  assert.equal(variablesState().drop, null);
  assert.equal(variablesState().list.loaded, false);
  assert.equal(variablesUnloadShouldWarn(), false);
});

test("going back to the start screen with a drop not confirmed asks first; agreed, the drop ends", async () => {
  serve(() => ({ throwNetworkError: true }));
  await openCategories();
  await drag(V1, C2);
  confirmAnswer = true;
  await click('[data-action="metric-classification-view"][data-view="home"]');
  assert.equal(confirmQuestions.length, 1);
  assert.equal(variablesState().view, "home");
  assert.equal(variablesState().drop, null);
  assert.equal(variablesUnloadShouldWarn(), false);
});

test("a drop not confirmed keeps New category closed, and an open form never discards it without asking", async () => {
  serve(() => ({ throwNetworkError: true }));
  await openCategories();
  await drag(V1, C2);
  const create = '[data-action="metric-classification-create-open"][data-kind="category"]';
  assert.equal($(create).disabled, true, "New category waits for the result");
  await click(create);
  assert.equal(variablesState().form, null, "and a click that reaches the handler opens nothing");
  assert.ok($('[data-action="metric-classification-drop-check"]'), "Check result stays on the screen");
  // Whatever form is open, leaving asks about the drop first.
  variablesState().form = openClassificationForm("node-create", { kind: "category" });
  confirmAnswer = false;
  assert.equal(variablesMayBeLeft(), false);
  assert.deepEqual(confirmQuestions, ["It is not confirmed whether Total distance was added to Sprint <b>. Leave without checking? Open Total distance under Variables later to see its categories."]);
  assert.ok(variablesState().drop?.unconfirmed, "declined, the drop is kept");
});

test("while a drop is being saved New category opens nothing: two writes never run at once", async () => {
  let release;
  serve(() => new Promise((resolve) => { release = resolve; }));
  await openCategories();
  const transfer = newTransfer();
  fire("dragstart", chip(V1), transfer);
  fire("dragover", categoryButton(C2), transfer);
  fire("drop", categoryButton(C2), transfer);
  await click('[data-action="metric-classification-create-open"][data-kind="category"]');
  assert.equal(variablesState().form, null);
  release(created());
  await lastDrop;
  assert.equal($('[data-action="metric-classification-create-open"][data-kind="category"]').disabled, false, "free again once saved");
});

test("an open form blocks a drop: nothing is sent", async () => {
  serve(() => created());
  await openCategories();
  variablesState().form = openClassificationForm("node-create", { kind: "category" });
  assert.equal(dropBlocked(), true);
  await dropVariableOnCategory(V1, C2, { render });
  assert.equal(posts().length, 0);
});

test("returning to Data configuration on the Categories screen reads the tray again", async () => {
  await openCategories();
  dropVariablesForm();
  calls.length = 0;
  await loadVariablesSection(render);
  assert.ok(gets().includes(TRAY), "the tray is read again");
  assert.ok(chip(V1));
});

test("back from a category on the Categories screen reads the tray when a return to Data configuration left it unread", async () => {
  await openCategories();
  await click(`[data-action="metric-classification-open"][data-kind="category"][data-node-id="${C2}"]`);
  // Away to another section and back, with the category still open.
  dropVariablesForm();
  await loadVariablesSection(render);
  calls.length = 0;
  await click('[data-action="metric-classification-back"]');
  assert.ok(gets().includes(TRAY), "the tray is read");
  assert.ok(chip(V1), "and its variables are there to drag");
  assert.doesNotMatch(text(), /Loading variables/);
  // An ordinary back, with the tray already read, reads nothing again.
  await click(`[data-action="metric-classification-open"][data-kind="category"][data-node-id="${C2}"]`);
  calls.length = 0;
  await click('[data-action="metric-classification-back"]');
  assert.ok(!gets().includes(TRAY));
  assert.ok(chip(V1));
});

test("Cancel of New category keeps the last drop's line and its Undo", async () => {
  serve(() => created());
  await openCategories();
  await drag(V1, C2);
  await click('[data-action="metric-classification-create-open"][data-kind="category"]');
  assert.ok(variablesState().form);
  await click('[data-action="metric-variables-cancel"]');
  assert.equal(variablesState().form, null);
  assert.match(text(), /Total distance was added to Sprint <b>\./);
  assert.ok($('[data-action="metric-classification-drop-undo"]'), "Undo is still offered");
});

test("a drop naming a variable that is not in the tray, or a category that takes nothing, sends nothing", async () => {
  serve(() => created());
  await openCategories();
  await dropVariableOnCategory("aaaaaaaa-1111-4000-8000-000000000099", C2, { render });
  await dropVariableOnCategory(V1, C3, { render });
  await dropVariableOnCategory(V1, "cccccccc-0000-4000-8000-000000000099", { render });
  // A drag of this type from elsewhere (another tab of the app) with a foreign id.
  const transfer = newTransfer();
  transfer.setData(VARIABLE_DRAG_TYPE, "aaaaaaaa-1111-4000-8000-000000000099");
  fire("dragover", categoryButton(C2), transfer);
  fire("drop", categoryButton(C2), transfer);
  await lastDrop;
  assert.equal(posts().length, 0);
  assert.equal(variablesState().drop, null);
});

test("a saved drop asks nothing on leaving, and leaving ends its Undo", async () => {
  serve(() => created());
  await openCategories();
  await drag(V1, C2);
  assert.equal(variablesUnloadShouldWarn(), false);
  confirmAnswer = false;
  assert.equal(variablesMayBeLeft(), true);
  await click(`[data-action="metric-classification-open"][data-kind="category"][data-node-id="${C2}"]`);
  assert.equal(confirmQuestions.length, 0);
  assert.equal(variablesState().drop, null);
  await click('[data-action="metric-classification-back"]');
  assert.ok(!$('[data-action="metric-classification-drop-undo"]'), "no Undo when the screen is opened again");
});

test("a late answer to a drop left behind changes nothing on the screen the coach is on", async () => {
  let release;
  serve(() => new Promise((resolve) => { release = resolve; }));
  await openCategories();
  const transfer = newTransfer();
  fire("dragstart", chip(V1), transfer);
  fire("dragover", categoryButton(C2), transfer);
  fire("drop", categoryButton(C2), transfer);
  confirmAnswer = true;
  await click('[data-action="metric-classification-view"][data-view="home"]');
  release(created());
  await lastDrop;
  assert.equal(variablesState().drop, null);
  assert.doesNotMatch(text(), /was added to/);
});

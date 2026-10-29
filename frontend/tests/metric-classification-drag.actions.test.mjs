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
  assert.match(tray.textContent.replace(/\s+/g, " "), /Drag a variable onto a category to add it there\. It stays in its other categories\. With a keyboard, open a variable and choose Add to a category\./);
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
    mock.timers.tick(1);
    assert.ok(!$('[data-action="metric-classification-drop-undo"]'), "the screen is drawn again without it");
    assert.match(text(), /Total distance was added to Sprint <b>\./);
    await handleVariablesAction(undoButton, { render });
    assert.equal(posts().length, 1, "no remove after the 10 seconds");
  } finally {
    mock.timers.reset();
  }
});

test("an Undo the server refuses is a warning with the remove's sentence", async () => {
  serve((call) => (call.url === LINKS ? created() : { status: 404, body: { error: "notFound" } }));
  await openCategories();
  await drag(V1, C2);
  await click('[data-action="metric-classification-drop-undo"]');
  assert.match(text(), /It is not available in this workspace now, or it is no longer there\./);
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
  assert.equal(variablesState().drop, null);
  assert.match(text(), /The result was not checked\. Open the variable to see its categories as they are saved now\./);
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
  assert.deepEqual(confirmQuestions, ["A change is still being saved. Leave anyway? Its result will not be shown."]);
  release({ throwNetworkError: true });
  await lastDrop;
  assert.match(text(), /Result not confirmed\./);
  assert.equal(variablesMayBeLeft(), false);
  assert.equal(confirmQuestions[1], "The last change is not confirmed. Leave without checking? Open the variable later to see its categories.");
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

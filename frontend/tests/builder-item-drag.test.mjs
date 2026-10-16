import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// Drag-to-reorder of the exercises added to a Builder section: the drop
// position, the move of N positions as N one-step swaps through the existing
// route, the order kept on screen meanwhile, the failure path, and the grips.

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
globalThis.window = { confirm: () => true };
const { state, emptyBuilderState } = await import("../state.js");
const { moveBuilderItemTo, handleBuilderItemAction } = await import("../builder-actions.js");
const { dropIndexFor, edgeScrollStep, startBuilderItemDrag } = await import("../builder-item-drag.js");
globalThis.getComputedStyle = () => ({ overflowY: "visible" });
const { renderBuilderItems, renderBuilderAddedList } = await import("../builder-exercises.js");

const ids = ["a", "b", "c", "d", "e"];
function draft(order = ids) {
  return {
    plan: { id: "draft-1", status: "draft", isEditDraft: true, planType: "weekly" },
    blocks: [{ id: "day-1", sessions: [{ id: "session-1", nodes: [{ id: "section-1", type: "section", items: order.map((id) => ({ id, title: `Exercise ${id}` })) }] }] }],
  };
}
const order = () => state.builder.draft.blocks[0].sessions[0].nodes[0].items.map((item) => item.id);
const response = (body) => ({ ok: true, status: 200, json: async () => body });

// A fake server that swaps an item with its neighbour, like POST /items/:id/move.
let serverOrder;
let calls;
function server({ failOnCall = 0 } = {}) {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (failOnCall && calls.length === failOnCall) return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    const id = decodeURIComponent(url.match(/items\/([^/]+)\/move/)[1]);
    const index = serverOrder.indexOf(id);
    const other = index + (JSON.parse(options.body).direction === "up" ? -1 : 1);
    [serverOrder[index], serverOrder[other]] = [serverOrder[other], serverOrder[index]];
    return response(draft(serverOrder));
  };
}
let paints;
let refreshed;
const handlers = () => ({
  renderBuilder() { paints.push({ how: "builder", order: order() }); },
  renderBuilderSectionItems() { paints.push({ how: "items", order: order() }); return true; },
  async refreshBuilderDraft() { refreshed += 1; state.builder.draft = draft(serverOrder); },
  renderBuilderError(error) { throw error; },
});

beforeEach(() => {
  state.builder = emptyBuilderState();
  state.builder.draft = draft();
  state.builder.selectedNodeId = "section-1";
  serverOrder = [...ids];
  calls = [];
  paints = [];
  refreshed = 0;
});

test("1. the drop position counts the other items whose middle is above the pointer", () => {
  assert.equal(dropIndexFor(5, [10, 30, 50]), 0);
  assert.equal(dropIndexFor(31, [10, 30, 50]), 2);
  assert.equal(dropIndexFor(99, [10, 30, 50]), 3);
  assert.equal(dropIndexFor(10, [10, 30, 50]), 0, "exactly on a middle stays above it");
});

test("2. a drag of three positions down shows the new order at once and sends three one-step swaps", async () => {
  server();
  assert.equal(await moveBuilderItemTo("a", 3, handlers()), true);
  assert.deepEqual(paints[0], { how: "items", order: ["b", "c", "d", "a", "e"] }, "painted before any answer");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.url === "/api/builder/items/a/move" && call.body.direction === "down"));
  assert.deepEqual(serverOrder, ["b", "c", "d", "a", "e"]);
  assert.deepEqual(order(), ["b", "c", "d", "a", "e"]);
  assert.equal(state.builder.itemMovePending, null);
  assert.equal(paints.length, 2);
});

test("3. a drag up sends 'up' swaps, and the up/down buttons are one-step moves through the same path", async () => {
  server();
  await moveBuilderItemTo("e", 1, handlers());
  assert.deepEqual(serverOrder, ["a", "e", "b", "c", "d"]);
  assert.ok(calls.every((call) => call.body.direction === "up"));
  calls = [];
  await handleBuilderItemAction({ dataset: { action: "builder-move-item", itemId: "c", direction: "up" } }, handlers());
  assert.deepEqual(serverOrder, ["a", "e", "c", "b", "d"]);
  assert.equal(calls.length, 1);
});

test("4. while the swaps are on their way the screen keeps the final order, and a second move waits its turn", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  serverOrder = [...ids];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (calls.length === 1) await gate;
    const id = decodeURIComponent(url.match(/items\/([^/]+)\/move/)[1]);
    const index = serverOrder.indexOf(id);
    const other = index + (JSON.parse(options.body).direction === "up" ? -1 : 1);
    [serverOrder[index], serverOrder[other]] = [serverOrder[other], serverOrder[index]];
    return response(draft(serverOrder));
  };
  const move = moveBuilderItemTo("a", 2, handlers());
  assert.deepEqual(order(), ["b", "c", "a", "d", "e"]);
  assert.equal(await moveBuilderItemTo("d", 0, handlers()), false, "refused while a move is pending");
  release();
  await move;
  assert.deepEqual(order(), ["b", "c", "a", "d", "e"]);
  assert.equal(calls.length, 2);
});

test("5. if a swap fails the draft is read again, so the screen never keeps an order that was not saved", async () => {
  server({ failOnCall: 2 });
  await assert.rejects(moveBuilderItemTo("a", 3, handlers()));
  assert.equal(refreshed, 1);
  assert.equal(state.builder.itemMovePending, null);
  assert.deepEqual(order(), ["b", "a", "c", "d", "e"], "what the server really has after the one swap that landed");
});

test("6. nothing is sent for the same position, a position outside the list or an unknown item", async () => {
  server();
  assert.equal(await moveBuilderItemTo("b", 1, handlers()), false);
  assert.equal(await moveBuilderItemTo("b", 9, handlers()), false);
  assert.equal(await moveBuilderItemTo("b", -1, handlers()), false);
  assert.equal(await moveBuilderItemTo("zz", 0, handlers()), false);
  assert.equal(calls.length, 0);
  assert.deepEqual(order(), ids);
});

test("7. every added exercise has a grip to drag, desktop and phone, and the up/down buttons stay", () => {
  const node = draft().blocks[0].sessions[0].nodes[0];
  for (const html of [renderBuilderItems(node), renderBuilderAddedList(node)]) {
    assert.equal([...html.matchAll(/data-drag-item/g)].length, 5);
    assert.equal([...html.matchAll(/data-builder-item-drag data-item-id="([a-e])"/g)].length, 5);
    assert.match(html, /aria-label="Drag Exercise c to reorder \(position 3 of 5\)"/);
    assert.equal([...html.matchAll(/type="button" tabindex="-1" aria-hidden="true" data-builder-item-drag/g)].length, 5, "the grip is neither a Tab stop nor announced; the arrows are the keyboard path");
    assert.equal([...html.matchAll(/data-action="builder-move-item"/g)].length, 10);
  }
  const single = { items: [{ id: "only", title: "Only one" }] };
  for (const html of [renderBuilderItems(single), renderBuilderAddedList(single)]) {
    assert.doesNotMatch(html, /data-builder-item-drag/, "nothing to reorder: no grip");
  }
  assert.match(renderBuilderAddedList(single), /<span class="builder-added-card-index">1<\/span>/);
});

test("8. a delete during a multi-step move is refused, and the screen ends on the server's own order", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method });
    if (options.method === "DELETE") {
      serverOrder = serverOrder.filter((id) => id !== decodeURIComponent(url.match(/items\/([^/?]+)/)[1]));
      return response(draft(serverOrder));
    }
    if (calls.length === 1) await gate;
    const id = decodeURIComponent(url.match(/items\/([^/]+)\/move/)[1]);
    const index = serverOrder.indexOf(id);
    const other = index + (JSON.parse(options.body).direction === "up" ? -1 : 1);
    [serverOrder[index], serverOrder[other]] = [serverOrder[other], serverOrder[index]];
    return response(draft(serverOrder));
  };
  const move = moveBuilderItemTo("a", 3, handlers());
  await handleBuilderItemAction({ dataset: { action: "builder-delete-item", itemId: "c" } }, handlers());
  release();
  await move;
  assert.ok(calls.every((call) => call.method === "POST"), "no DELETE between the swaps");
  assert.deepEqual(order(), serverOrder);
  assert.deepEqual(order(), ["b", "c", "d", "a", "e"]);
});

test("9. the server's order wins at the end even if it differs from the planned one", async () => {
  // The server places the item one step short (another change landed in between).
  globalThis.fetch = async () => response(draft(["b", "c", "a", "d", "e"]));
  await moveBuilderItemTo("a", 3, handlers());
  assert.deepEqual(order(), ["b", "c", "a", "d", "e"]);
});

// A minimal DOM for the drag controller: a list of items with a grip each.
function dragFixture(count = 3) {
  const classes = () => { const set = new Set(); return { add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c), set }; };
  const list = { classList: classes(), parentElement: null, children: [] };
  const items = Array.from({ length: count }, (_, index) => {
    const listeners = {};
    const item = { index, isConnected: true, style: {}, classList: classes(), parentElement: list, matches: (sel) => sel === "[data-drag-item]", getBoundingClientRect: () => ({ top: index * 100, height: 100, bottom: index * 100 + 100 }) };
    item.handle = {
      dataset: { itemId: `item-${index}` }, listeners,
      closest: (sel) => (sel === "[data-builder-item-drag]" ? item.handle : sel === "[data-drag-item]" ? item : null),
      setPointerCapture() {},
      addEventListener: (type, fn) => { listeners[type] = fn; },
      removeEventListener: (type) => { delete listeners[type]; },
    };
    return item;
  });
  list.children = items;
  return { list, items };
}
const press = (item, y, extra = {}) => ({ target: item.handle, pointerId: 1, button: 0, clientY: y, preventDefault() {}, ...extra });
const moveTo = (item, y) => item.handle.listeners.pointermove?.({ clientY: y, preventDefault() {} });

test("10. the drag controller: a small wobble, a blocked state, a cancel or a re-render never drops; a real drag does", () => {
  const drops = [];
  const onDrop = (id, index) => drops.push([id, index]);

  let { items } = dragFixture();
  assert.equal(startBuilderItemDrag(press(items[0], 148), { onDrop }), true);
  moveTo(items[0], 151);
  items[0].handle.listeners.pointerup();
  assert.deepEqual(drops, [], "3 px is a press, not a drag - even across a neighbour's middle (150)");
  assert.deepEqual(Object.keys(items[0].handle.listeners), [], "listeners removed");

  ({ items } = dragFixture());
  assert.equal(startBuilderItemDrag(press(items[0], 50), { onDrop, isBlocked: () => true }), false);
  assert.deepEqual(Object.keys(items[0].handle.listeners), []);

  ({ items } = dragFixture());
  startBuilderItemDrag(press(items[0], 50), { onDrop });
  moveTo(items[0], 190);
  assert.ok(items[1].classList.contains("is-drop-after") || items[2].classList.contains("is-drop-before"));
  items[0].isConnected = false;
  items[0].handle.listeners.pointerup?.();
  assert.deepEqual(drops, [], "the list was re-rendered during the drag");

  ({ items } = dragFixture());
  startBuilderItemDrag(press(items[0], 50), { onDrop });
  moveTo(items[0], 190);
  items[0].handle.listeners.pointercancel();
  assert.deepEqual(drops, []);

  ({ items } = dragFixture());
  startBuilderItemDrag(press(items[0], 50), { onDrop });
  moveTo(items[0], 190);
  assert.equal(items[0].classList.contains("is-dragging"), true);
  items[0].handle.listeners.pointerup();
  assert.deepEqual(drops, [["item-0", 1]]);
  assert.equal(items[0].classList.contains("is-dragging"), false);
  assert.equal(items[0].style.transform, "");
  assert.ok(items.every((item) => !item.classList.contains("is-drop-before") && !item.classList.contains("is-drop-after")));
});

test("11. the Tests calendar's normalized touchstart object (no pointerId) never starts a builder drag", () => {
  const { items } = dragFixture();
  assert.equal(startBuilderItemDrag({ target: items[0].handle, clientY: 10, preventDefault() {} }, { onDrop: () => assert.fail("no drop") }), false);
  assert.deepEqual(Object.keys(items[0].handle.listeners), []);
});

test("12. edge scrolling: none in the middle, faster the deeper the pointer is in a zone, and a second finger never starts a drag", () => {
  const band = { top: 100, bottom: 500 };
  assert.equal(edgeScrollStep(300, band), 0);
  assert.equal(edgeScrollStep(156, band), 0);
  assert.ok(edgeScrollStep(150, band) < 0 && edgeScrollStep(150, band) > edgeScrollStep(101, band), "deeper in the top zone scrolls up faster");
  assert.equal(edgeScrollStep(60, band), -18, "beyond the edge: the maximum");
  assert.ok(edgeScrollStep(470, band) > 0 && edgeScrollStep(499, band) > edgeScrollStep(470, band));
  const { items } = dragFixture();
  assert.equal(startBuilderItemDrag(press(items[0], 50, { isPrimary: false }), { onDrop: () => assert.fail("no drop") }), false);
});

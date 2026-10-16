import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// Drag-to-reorder of the exercises added to a Builder section: the drop
// position, the move of N positions as N one-step swaps through the existing
// route, the order kept on screen meanwhile, the failure path, and the grips.

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
globalThis.window = { confirm: () => true };
const { state, emptyBuilderState } = await import("../state.js");
const { moveBuilderItemTo, handleBuilderItemAction } = await import("../builder-actions.js");
const { dropIndexFor } = await import("../builder-item-drag.js");
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
    assert.equal([...html.matchAll(/data-action="builder-move-item"/g)].length, 10);
  }
});

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { BLOCK_MOVE_CLIENT_BOUND_MS, openExerciseClassification } from "../exercise-classification.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const microtasks = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
const blockInfo = (extra = {}) => ({
  exerciseId: "exercise-one", exerciseName: "Skip", movable: true,
  current: { id: "block-a", name: "Speed" },
  blocks: [{ id: "block-a", name: "Speed", accessAll: false }, { id: "block-b", name: "Open drills", accessAll: true }, { id: "block-c", name: "Rehab", accessAll: false }],
  ...extra,
});

// The panel against a fake of its routes; `move` answers the block PUT.
async function openPanel({ canManageBlocks = true, info = blockInfo(), move = () => ({ ok: true, json: async () => ({ changed: true }) }), confirm = () => true } = {}) {
  const dom = new JSDOM("<main></main>");
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const prompts = [];
  window.confirm = (text) => { prompts.push(text); return confirm(text); };
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal });
    if (String(url).includes("/exercise-block/")) {
      if (options.method === "PUT") return move(options);
      return info ? { ok: true, json: async () => info } : { ok: false, status: 500, statusText: "Error", json: async () => ({ error: "internalError" }) };
    }
    return { ok: true, json: async () => ({ system: {}, overrides: {} }) };
  };
  let refreshed = 0;
  await openExerciseClassification("exercise-one", {}, async () => { refreshed += 1; }, { canManageBlocks });
  await settle();
  return { dom, prompts, requests, refreshed: () => refreshed };
}
const choose = (value) => {
  const select = document.querySelector("[data-classification-block]");
  select.value = value;
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
};

test("a coach who does not manage blocks sees no block section and nothing is read for it", async () => {
  const { dom, requests } = await openPanel({ canManageBlocks: false });
  assert.equal(document.querySelector(".exercise-classification-block"), null);
  assert.equal(requests.some((request) => request.url.includes("/exercise-block/")), false);
  dom.window.close();
});

test("the administrator moves the exercise into another block with its own button and a confirmation naming the consequence", async () => {
  const { dom, prompts, requests, refreshed } = await openPanel();
  const section = document.querySelector(".exercise-classification-block");
  assert.match(section.textContent, /For every coach, not only you/);
  assert.equal(document.querySelector("[data-classification-block]").value, "block-a");
  assert.equal(document.querySelector("[data-classification-block-save]").disabled, true, "nothing to move yet");
  choose("block-c");
  assert.equal(document.querySelector("[data-classification-block-save]").disabled, false);
  document.querySelector("[data-classification-block-save]").click();
  await settle();
  assert.match(prompts[0], /Move “Skip” into the block “Rehab”\?/);
  assert.match(prompts[0], /Other coaches lose it, including their personal copies/);
  assert.match(prompts[0], /It leaves “Speed”\./);
  const put = requests.filter((request) => request.method === "PUT");
  assert.equal(put.length, 1);
  assert.equal(put[0].url, "/api/exercise-collections/exercise-block/exercise-one");
  assert.deepEqual(put[0].body, { collectionId: "block-c", expectedCollectionId: "block-a" });
  assert.match(document.querySelector(".exercise-classification-block [role='status']").textContent, /Moved to “Rehab”/);
  assert.equal(document.querySelector("[data-classification-block]").value, "block-c");
  assert.equal(refreshed(), 1);
  assert.equal(requests.some((request) => request.url.endsWith("/classification") && request.method === "PUT"), false, "the personal classification is not saved by a move");
  dom.window.close();
});

test("moving to Other or into an open block says who can use it; a declined confirmation sends nothing", async () => {
  const declined = await openPanel({ confirm: () => false });
  choose("");
  document.querySelector("[data-classification-block-save]").click();
  await settle();
  assert.match(declined.prompts[0], /Move “Skip” to Other\?\n\nIt leaves “Speed” and becomes available to all coaches\./);
  assert.equal(declined.requests.some((request) => request.method === "PUT"), false);
  declined.dom.window.close();
  const open = await openPanel({ info: blockInfo({ current: null }) });
  choose("block-b");
  document.querySelector("[data-classification-block-save]").click();
  await settle();
  assert.match(open.prompts[0], /Every coach can use it: this block is open to all users\./);
  assert.doesNotMatch(open.prompts[0], /It leaves/);
  assert.deepEqual(open.requests.find((request) => request.method === "PUT").body, { collectionId: "block-b", expectedCollectionId: null });
  open.dom.window.close();
});

test("a refused, lost or unanswered move keeps the shown block and says why", async () => {
  for (const [move, sentence] of [
    [() => ({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "staleRevision" }) }), /changed elsewhere/],
    [() => ({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "blockNotAvailable" }) }), /no longer available/],
    [() => ({ ok: false, status: 503, statusText: "Unavailable", json: async () => ({ error: "outcomeUnknown" }) }), /was not confirmed/],
    [() => { throw new TypeError("Failed to fetch"); }, /was not confirmed/],
  ]) {
    const { dom, refreshed } = await openPanel({ move });
    choose("block-c");
    document.querySelector("[data-classification-block-save]").click();
    await settle();
    assert.match(document.querySelector(".exercise-classification-block [role='alert']").textContent, sentence);
    assert.equal(refreshed(), 0);
    dom.window.close();
  }
  const pending = [];
  const { dom } = await openPanel({ move: (options) => new Promise((_, reject) => {
    pending.push(options);
    options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }) });
  choose("block-c");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    document.querySelector("[data-classification-block-save]").click();
    await microtasks();
    assert.equal(document.querySelector("[data-classification-block-save]").textContent, "Moving...");
    document.querySelector("[data-classification-block-save]").click();
    document.querySelector("[data-classification-close]").click();
    assert.ok(document.querySelector(".exercise-classification-overlay"), "the panel stays open while a move is in flight");
    mock.timers.tick(BLOCK_MOVE_CLIENT_BOUND_MS);
    await microtasks();
  } finally { mock.timers.reset(); }
  assert.equal(pending.length, 1, "one move, however often it is clicked");
  assert.match(document.querySelector(".exercise-classification-block [role='alert']").textContent, /was not confirmed/);
  document.querySelector("[data-classification-close]").click();
  assert.equal(document.querySelector(".exercise-classification-overlay"), null);
  dom.window.close();
});

test("a private exercise shows its block without a choice; blocks that cannot be read say so", async () => {
  const fixed = await openPanel({ info: blockInfo({ movable: false }) });
  assert.equal(document.querySelector("[data-classification-block]"), null);
  assert.match(document.querySelector(".exercise-classification-block").textContent, /Block: Speed\. A private or archived exercise follows its original's block/);
  fixed.dom.window.close();
  const failed = await openPanel({ info: null });
  assert.match(document.querySelector(".exercise-classification-block [role='alert']").textContent, /could not be loaded/);
  failed.dom.window.close();
});

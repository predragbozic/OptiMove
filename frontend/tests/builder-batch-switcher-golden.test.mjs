// The Builder batch switcher, byte for byte (K6 contract 1.4). The golden HTML
// in support/builder-batch-switcher-golden.json was recorded from
// renderBuilderBatchSwitcher BEFORE its strip was extracted into the shared
// athlete-switcher.js; the extraction must leave every string identical,
// whitespace included. Cases: support/builder-batch-switcher-cases.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="content"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.requestAnimationFrame = (callback) => callback();
const { state, emptyBuilderState } = await import("../state.js");
const { renderBuilderBatchSwitcher } = await import("../builder-view.js");
const { ATHLETES, CASES } = await import("./support/builder-batch-switcher-cases.mjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, "support/builder-batch-switcher-golden.json"), "utf8"));

function renderCase(c) {
  state.athletes = ATHLETES;
  state.builder = emptyBuilderState({
    draft: { plan: { id: c.plans[c.index].id, status: "draft", planType: "weekly", batchId: "g", isEditDraft: c.isEditDraft }, batch: { id: "g", plans: c.plans, hiddenCount: c.hiddenCount }, blocks: [] },
  });
  state.builder.batchSync = c.batchSync;
  return renderBuilderBatchSwitcher(c.plans, c.index);
}

test("the golden file covers every case", () => {
  assert.deepEqual(Object.keys(GOLDEN), CASES.map((c) => c.name));
});

for (const c of CASES) {
  test(`raw HTML unchanged: ${c.name}`, () => {
    assert.equal(renderCase(c), GOLDEN[c.name]);
  });
}

test("the cases pin what they claim: a photo, a hidden count, Program copy, both modes", () => {
  const all = CASES.map((c) => GOLDEN[c.name]).join("\n");
  assert.match(all, /builder-batch-photo/);
  assert.match(all, /can't open\./);
  assert.match(all, /title="Program copy"/);
  assert.match(all, />Program c\.</);
  assert.match(all, /<strong>Current copy<\/strong>/);
  assert.match(all, /data-builder-batch-edit-note/);
  assert.match(all, /data-action="builder-toggle-batch-sync" checked/);
  assert.match(all, /data-action="builder-toggle-batch-sync" >/);
  assert.match(all, /data-plan-id="" disabled aria-label="Previous athlete"/);
  assert.match(all, /data-plan-id="" disabled aria-label="Next athlete"/);
});

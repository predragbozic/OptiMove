// K6 contract 1.4: the Builder's batch switcher stays byte for byte. The golden
// file holds today's raw HTML (whitespace included) for every case; it was
// written from the code BEFORE the strip was extracted into
// athlete-switcher.js and must not change with the extraction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="content"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.requestAnimationFrame = (callback) => callback();
const { state, emptyBuilderState } = await import("../state.js");
const { renderBuilderBatchSwitcher } = await import("../builder-view.js");
const { buildBatchSwitcherCases } = await import("./support/builder-batch-switcher-cases.mjs");

const golden = JSON.parse(readFileSync(new URL("./support/builder-batch-switcher.golden.json", import.meta.url), "utf8"));

test("the batch switcher's raw HTML equals the golden file for every case", () => {
  state.builder = emptyBuilderState({});
  const cases = buildBatchSwitcherCases({ state, renderBuilderBatchSwitcher });
  assert.equal(cases.length, golden.length, "same number of cases");
  assert.ok(cases.length >= 30);
  for (let i = 0; i < cases.length; i += 1) {
    assert.equal(cases[i].name, golden[i].name);
    assert.equal(cases[i].html, golden[i].html, `case "${cases[i].name}" changed`);
  }
});

test("the golden file pins the contract's cases", () => {
  const all = golden.map((g) => g.html).join("\n");
  assert.match(all, /Program copy/, "the neither-name fallback");
  assert.match(all, /builder-batch-hidden/, "the hidden-members sentence");
  assert.match(all, /data-builder-batch-edit-note/, "the edit draft sentence");
  assert.match(all, /builder-batch-photo/, "a photo");
  assert.match(all, /Apply changes to all athletes/);
});

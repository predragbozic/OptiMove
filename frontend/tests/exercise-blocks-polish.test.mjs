import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { renderExerciseBlocksHtml, openExerciseBlocks, refreshExerciseBlocks } from "../exercise-blocks.js";
import { openExerciseCollections } from "../exercise-collections.js";
import { state } from "../state.js";

const initialBlock = {
  id: "block-one", name: "Movement", description: "Instructions stay protected", revision: 1,
  coverImageUrl: "https://example.test/first-cover.svg", accessAll: false,
  blockPreview: "hidden", exercisePreview: "hidden", exercises: [], users: [], exerciseCount: 2,
};
const other = { id: "other", name: "Other", exerciseCount: 1, coverImageUrl: "" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("separate covers and neutral placeholder remain distinct; locked cards never expose exercise controls", () => {
  const html = renderExerciseBlocksHtml({ blocks: [initialBlock, { ...initialBlock, id: "two", coverImageUrl: "https://example.test/second-cover.svg", locked: true }], other, canManageCollections: false });
  const dom = new JSDOM(html);
  const cards = dom.window.document.querySelectorAll(".exercise-block-card");
  assert.equal(cards[0].querySelector("img").src, initialBlock.coverImageUrl);
  assert.equal(cards[1].querySelector("img").src, "https://example.test/second-cover.svg");
  assert.ok(cards[2].querySelector(".exercise-block-placeholder"));
  assert.ok(cards[1].querySelector(".exercise-block-lock svg[aria-hidden='true']"));
  assert.equal(cards[1].querySelectorAll("button,iframe,video,[data-action]").length, 0);
  assert.equal(dom.window.document.querySelectorAll("[data-action='exercise-collections-open']").length, 0);
  dom.window.close();
});

test("cover styling contains the complete image and uses readable locked-card foregrounds", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.exercise-block-cover-image\s*\{[^}]*object-fit:\s*contain/);
  assert.match(css, /\.exercise-block-cover\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*10/);
  assert.match(css, /\.exercise-block-card\.is-locked\s*\{[^}]*color:\s*var\(--text\)/);
  assert.doesNotMatch(css, /\.exercise-block-card\.is-locked\s+\.exercise-block-cover\s*\{[^}]*opacity/);
  assert.match(css, /\.exercise-block-pick input\[type="checkbox"\]\s*\{[^}]*width:\s*18px/);
  assert.match(css, /\.exercise-collections-overlay \.compact-button\s*\{[^}]*white-space:\s*normal/);
});

test("administrator can add, replace and remove a cover without altering membership or access", async () => {
  const dom = new JSDOM("<button id='opener'>Manage blocks</button>");
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  window.confirm = () => true;
  let stored = { ...initialBlock, coverImageUrl: "", exercises: [{ id: "exercise-one", name: "Skip" }], users: [{ id: "coach-one", name: "Coach" }] };
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === "PATCH") {
      const body = JSON.parse(options.body);
      writes.push(body);
      stored = { ...stored, ...body, revision: stored.revision + 1 };
      return { ok: true, json: async () => ({ collection: stored }) };
    }
    return { ok: true, json: async () => String(url).includes("/options") ? { exercises: stored.exercises, users: stored.users } : { collections: [stored] } };
  };
  await openExerciseCollections(async () => {}, stored.id);
  assert.equal(document.querySelector("[data-clear-block-cover]").disabled, true);
  for (const cover of ["https://example.test/add.svg", "https://example.test/replace.svg"]) {
    const input = document.querySelector("[data-block-cover]");
    input.value = cover;
    input.dispatchEvent(new window.Event("input"));
    assert.equal(document.querySelector("[data-clear-block-cover]").disabled, false);
    document.querySelector("[data-save-block]").click();
    await settle();
    assert.equal(writes.at(-1).coverImageUrl, cover);
  }
  document.querySelector("[data-clear-block-cover]").click();
  assert.equal(document.querySelector("[data-block-cover]").value, "");
  assert.equal(document.activeElement, document.querySelector("[data-block-cover]"));
  document.querySelector("[data-save-block]").click();
  await settle();
  assert.equal(writes.at(-1).coverImageUrl, "");
  for (const write of writes) {
    assert.deepEqual(write.exerciseIds, ["exercise-one"]);
    assert.deepEqual(write.userIds, ["coach-one"]);
    assert.equal(write.accessAll, false);
  }
  document.querySelector("[data-close-collections]").click();
  dom.window.close();
});

test("revocation replaces the old available image/actions with a locked preview, then hidden removes the card", async () => {
  const dom = new JSDOM('<h2 id="screenTitle"></h2><div id="viewToolbar"></div><main id="content"></main>');
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const { els } = await import("../dom.js");
  els.title = document.querySelector("#screenTitle");
  els.toolbar = document.querySelector("#viewToolbar");
  els.content = document.querySelector("#content");
  state.exerciseSearch = { filters: {} };
  let blocks = [initialBlock];
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ blocks, other, canManageCollections: false }) });
  await openExerciseBlocks({ renderExercises() {}, setLoading() {} });
  assert.ok(document.querySelector('[data-open-block="block-one"]'));
  blocks = [{ ...initialBlock, coverImageUrl: "", locked: true }];
  await refreshExerciseBlocks();
  assert.equal(document.querySelector('[data-open-block="block-one"]'), null);
  assert.equal(document.querySelector('.is-locked img'), null);
  assert.ok(document.querySelector('.is-locked .exercise-block-placeholder'));
  assert.equal(document.body.innerHTML.includes(initialBlock.coverImageUrl), false);
  blocks = [];
  await refreshExerciseBlocks();
  assert.equal(document.querySelector(".is-locked"), null);
  assert.equal(document.querySelectorAll(".exercise-block-card").length, 1);
  dom.window.close();
});

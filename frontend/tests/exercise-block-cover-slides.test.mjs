import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { advanceBlockCovers, blockCoverSlides, dropBrokenBlockCover, openExerciseBlocks, refreshExerciseBlocks, renderExerciseBlocksHtml, stepBlockCover } from "../exercise-blocks.js";
import { emptyExerciseOptions, state } from "../state.js";

const slides = [
  { imageUrl: "https://example.test/a.jpg", videoUrl: "" },
  { imageUrl: "", videoUrl: "https://www.youtube.com/watch?v=abcdefghijk" },
  { imageUrl: "https://example.test/c.jpg", videoUrl: "https://www.youtube.com/watch?v=abcdefghijk" },
];
const block = { id: "block-id", name: "Ankle <strength>", description: "", exerciseCount: 3, coverImageUrl: "https://example.test/a.jpg", coverSlides: slides, locked: false };
const other = { id: "other", name: "Other", description: "", exerciseCount: 0, coverImageUrl: "", coverSlides: [] };

// On screen, with its current picture loaded (jsdom never loads one).
function onScreen(frame) {
  frame.getBoundingClientRect = () => ({ top: 10, bottom: 210, width: 300, height: 200 });
  Object.defineProperty(frame.querySelector(".exercise-block-cover-image"), "complete", { configurable: true, get: () => true });
  return frame;
}

function renderCatalog(blocks) {
  const dom = new JSDOM(`<main>${renderExerciseBlocksHtml({ blocks, other, canManageCollections: false })}</main>`, { pretendToBeVisual: true });
  return { dom, doc: dom.window.document };
}

test("a block without a cover of its own steps through its exercises' pictures, image first, then the video cover", () => {
  const { dom, doc } = renderCatalog([block]);
  const frame = doc.querySelector("[data-block-slides]");
  assert.ok(frame);
  assert.deepEqual(JSON.parse(frame.dataset.blockSlides).map((sources) => sources[0]), [
    "https://example.test/a.jpg", "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg", "https://example.test/c.jpg",
  ]);
  const image = frame.querySelector(".exercise-block-cover-image");
  assert.equal(image.src, "https://example.test/a.jpg");
  assert.equal(image.getAttribute("referrerpolicy"), "no-referrer");
  // The arrows sit beside the open button, never inside it.
  const open = frame.querySelector("button[data-open-block]");
  assert.equal(open.querySelectorAll("button").length, 0);
  const arrows = [...frame.querySelectorAll(":scope > [data-block-slide-step]")];
  assert.deepEqual(arrows.map((arrow) => arrow.getAttribute("aria-label")), ["Previous picture: Ankle <strength>", "Next picture: Ankle <strength>"]);
  assert.equal(frame.querySelectorAll(".exercise-block-cover-dots > span").length, 3);
  assert.equal(frame.querySelectorAll(".exercise-block-cover-dots > span.is-active").length, 1);
  dom.window.close();
});

test("one picture, an own cover, a locked block or no picture: no arrows and no turn", () => {
  const single = { ...block, id: "single", coverSlides: [slides[0], { imageUrl: "", videoUrl: "https://example.test/clip.mp4" }] };
  const covered = { ...block, id: "covered", coverImageUrl: "https://example.test/own-cover.jpg", coverSlides: [] };
  const locked = { ...block, id: "locked", locked: true, coverImageUrl: "", coverSlides: slides };
  const empty = { ...block, id: "empty", coverImageUrl: "", coverSlides: [] };
  const { dom, doc } = renderCatalog([single, covered, locked, empty]);
  assert.equal(doc.querySelectorAll("[data-block-slides], [data-block-slide-step]").length, 0);
  const cards = doc.querySelectorAll(".exercise-block-card");
  assert.equal(cards[0].querySelector("img").src, "https://example.test/a.jpg");
  assert.equal(cards[1].querySelector("img").src, "https://example.test/own-cover.jpg");
  // A locked card never shows an exercise's media, whatever the answer holds.
  assert.equal(cards[2].querySelectorAll("img, button").length, 0);
  assert.ok(cards[2].querySelector(".exercise-block-placeholder"));
  assert.ok(cards[3].querySelector(".exercise-block-placeholder"));
  assert.deepEqual(blockCoverSlides({ ...block, coverSlides: "not a list" }), []);
  assert.equal(blockCoverSlides({ ...block, coverSlides: Array.from({ length: 14 }, (_, index) => ({ imageUrl: `https://example.test/${index}.jpg` })) }).length, 10);
  // The same picture twice would make an arrow look dead: it is shown once.
  assert.deepEqual(blockCoverSlides({ ...block, coverSlides: [slides[0], slides[0], slides[1], { imageUrl: "", videoUrl: "https://youtu.be/abcdefghijk" }] })
    .map((sources) => sources[0]), ["https://example.test/a.jpg", "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg"]);
  dom.window.close();
});

test("Next and Previous wrap around, move the dot and carry the picture's other addresses", () => {
  const { dom, doc } = renderCatalog([block]);
  const frame = doc.querySelector("[data-block-slides]");
  const image = frame.querySelector(".exercise-block-cover-image");
  const active = () => [...frame.querySelectorAll(".exercise-block-cover-dots > span")].findIndex((dot) => dot.classList.contains("is-active"));
  assert.equal(stepBlockCover(frame, 1), true);
  assert.equal(image.src, "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg");
  assert.deepEqual(JSON.parse(image.dataset.fallbacks), ["https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"]);
  assert.equal(active(), 1);
  stepBlockCover(frame, 1);
  stepBlockCover(frame, 1);
  assert.equal(image.src, "https://example.test/a.jpg");
  assert.equal(image.dataset.fallbacks, undefined);
  assert.equal(active(), 0);
  stepBlockCover(frame, -1);
  assert.equal(image.src, "https://example.test/c.jpg");
  assert.equal(frame.dataset.slideIndex, "2");
  dom.window.close();
});

test("the turn moves only cards on screen, not under the pointer or focus, not after the arrows, not in a hidden tab or with reduced motion", () => {
  const { dom, doc } = renderCatalog([block, { ...block, id: "two", name: "Two" }, { ...block, id: "three", name: "Three" }]);
  const root = doc.querySelector("main");
  const [first, second, third] = [...doc.querySelectorAll("[data-block-slides]")];
  onScreen(first);
  onScreen(second);
  third.getBoundingClientRect = () => ({ top: 5000, bottom: 5200, width: 300, height: 200 });
  assert.equal(advanceBlockCovers(root), 2);
  assert.equal(first.dataset.slideIndex, "1");
  assert.equal(third.dataset.slideIndex, "0");
  second.dataset.slidesPaused = "manual";
  first.closest(".exercise-block-card").querySelector("[data-block-slide-step]").focus();
  assert.equal(advanceBlockCovers(root), 0);
  doc.activeElement.blur();
  Object.defineProperty(doc, "hidden", { configurable: true, get: () => true });
  assert.equal(advanceBlockCovers(root), 0);
  Object.defineProperty(doc, "hidden", { configurable: true, get: () => false });
  dom.window.matchMedia = (query) => ({ matches: query.includes("prefers-reduced-motion") });
  assert.equal(advanceBlockCovers(root), 0);
  dom.window.matchMedia = () => ({ matches: false });
  assert.equal(advanceBlockCovers(root), 1);
  assert.equal(first.dataset.slideIndex, "2");
  // A picture still loading is given its time.
  Object.defineProperty(first.querySelector(".exercise-block-cover-image"), "complete", { configurable: true, get: () => false });
  assert.equal(advanceBlockCovers(root), 0);
  Object.defineProperty(first.querySelector(".exercise-block-cover-image"), "complete", { configurable: true, get: () => true });
  // The mouse on the card holds it; a touch screen's leftover :hover does not.
  const firstCard = first.closest(".exercise-block-card");
  firstCard.matches = (selector) => selector === ":hover" || dom.window.Element.prototype.matches.call(firstCard, selector);
  assert.equal(advanceBlockCovers(root), 0);
  dom.window.matchMedia = (query) => ({ matches: query === "(hover: none)" });
  assert.equal(advanceBlockCovers(root), 1);
  assert.equal(first.dataset.slideIndex, "0");
  dom.window.close();
});

test("a picture that fails every address leaves the turn; with none left the card shows the placeholder", () => {
  const { dom, doc } = renderCatalog([block]);
  const frame = doc.querySelector("[data-block-slides]");
  const image = frame.querySelector(".exercise-block-cover-image");
  // Not yet marked missing (the app still has addresses to try): nothing moves.
  assert.equal(dropBrokenBlockCover(image), false);
  image.classList.add("image-missing");
  assert.equal(dropBrokenBlockCover(image), true);
  assert.equal(frame.dataset.slideIndex, "1");
  assert.equal(image.classList.contains("image-missing"), false);
  assert.ok(frame.querySelectorAll(".exercise-block-cover-dots > span")[0].classList.contains("is-broken"));
  image.classList.add("image-missing");
  dropBrokenBlockCover(image);
  assert.equal(frame.dataset.slideIndex, "2");
  assert.ok(frame.classList.contains("is-single"));
  stepBlockCover(frame, 1);
  assert.equal(frame.dataset.slideIndex, "2");
  image.classList.add("image-missing");
  assert.equal(dropBrokenBlockCover(image), true);
  assert.ok(frame.querySelector(".exercise-block-cover-image.image-missing + .exercise-block-placeholder"));
  assert.equal(stepBlockCover(frame, 1), false);
  dom.window.close();
});

test("a single picture or an own cover that fails every address shows the placeholder", async () => {
  const { dom, doc } = renderCatalog([{ ...block, coverSlides: [slides[0]] }, { ...block, id: "covered", coverImageUrl: "https://example.test/own.jpg", coverSlides: [] }]);
  for (const image of doc.querySelectorAll(".exercise-block-cover-image")) {
    assert.ok(image.nextElementSibling?.classList.contains("exercise-block-placeholder"));
  }
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.exercise-block-cover-image:not\(\.image-missing\) \+ \.exercise-block-placeholder\s*\{\s*display:\s*none/);
  dom.window.close();
});

test("in the Blocks view an arrow steps that card and stops its turn without opening the block; the turn runs every second", async (t) => {
  const dom = new JSDOM('<h2 id="screenTitle"></h2><div id="viewToolbar"></div><main id="content"></main>', { pretendToBeVisual: true });
  // The window's timers (the turn) end with it, also when an assertion fails.
  t.after(() => dom.window.close());
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const { els } = await import("../dom.js");
  els.title = document.querySelector("#screenTitle");
  els.toolbar = document.querySelector("#viewToolbar");
  els.content = document.querySelector("#content");
  state.currentUser = { id: "coach-id", activeWorkspace: { type: "private_coach" } };
  state.exerciseSearch = { filters: {}, options: emptyExerciseOptions(), limit: 30 };
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, json: async () => ({ blocks: [block, { ...block, id: "two", name: "Two" }], other, canManageCollections: false }) };
  };
  await openExerciseBlocks({ renderExercises() {}, setLoading() {} });
  const [first, second] = [...document.querySelectorAll("[data-block-slides]")].map(onScreen);
  first.querySelector('[data-block-slide-step="1"]').click();
  first.querySelector('[data-block-slide-step="1"]').click();
  assert.equal(first.dataset.slideIndex, "2");
  assert.equal(first.dataset.slidesPaused, "manual");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.filter((url) => url.startsWith("/api/exercises")).length, 0);
  assert.equal(state.exerciseSearch.surface, "blocks");
  document.activeElement.blur();
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal(second.dataset.slideIndex, "1");
  assert.equal(first.dataset.slideIndex, "2");
  // A picture the app gave up on is dropped through the catalog's own listener.
  const image = second.querySelector(".exercise-block-cover-image");
  image.classList.add("image-missing");
  image.dispatchEvent(new dom.window.Event("error"));
  assert.equal(second.dataset.brokenSlides, "1");
  // Drawn again (a search, a realtime refresh): the stopped card stays
  // stopped on the picture the coach chose; the other card turns again.
  await refreshExerciseBlocks();
  const [firstAgain, secondAgain] = [...document.querySelectorAll("[data-block-slides]")].map(onScreen);
  assert.notEqual(firstAgain, first);
  assert.equal(firstAgain.dataset.slidesPaused, "manual");
  assert.equal(firstAgain.dataset.slideIndex, "2");
  assert.equal(firstAgain.querySelector(".exercise-block-cover-image").getAttribute("src"), "https://example.test/c.jpg");
  assert.equal(secondAgain.dataset.slidesPaused, undefined);
  advanceBlockCovers(document.querySelector(".exercise-block-catalog"));
  assert.equal(firstAgain.dataset.slideIndex, "2");
  assert.equal(secondAgain.dataset.slideIndex, "1");
});

test("arrow styling: 44 px round targets over the picture, hidden with a single picture left", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.exercise-block-cover-frame\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.exercise-block-cover-step\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/);
  assert.match(css, /\.exercise-block-cover-frame\.is-single \.exercise-block-cover-step,?/);
  assert.match(css, /\.exercise-block-cover-dots\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.exercise-block-cover-step\s*\{[^}]*touch-action:\s*manipulation/);
  assert.match(css, /@media \(hover: hover\)\s*\{\s*\.exercise-block-cover-step:hover/);
});

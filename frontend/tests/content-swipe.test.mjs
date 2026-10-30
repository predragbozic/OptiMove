import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createContentSwipe, DETAIL_SWIPE, TREE_SWIPE } from "../content-swipe.js";
import { renderExerciseDetailHtml } from "../exercise-view.js";

// Swipes on #content (owner, 2026-10-29): in an exercise's detail a scroll up
// or down never changes the exercise, only a clear sideways swipe does, and
// the strip of other exercises scrolls under the finger and opens one only
// on a tap. The program tree and the weeks keep their rule exactly. Real
// touch events go through the listeners app.js installs on #content.

const items = new Map(Array.from({ length: 6 }, (_, index) => [`item-${index}`, { id: `ex-${index}`, title: `Exercise ${index}`, description: "Slow and steady." }]));
const ids = [...items.keys()];

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

function mount(markup, { width = 375 } = {}) {
  const dom = new JSDOM(`<body><section id="content">${markup}</section></body>`);
  const view = dom.window;
  Object.defineProperty(view, "innerWidth", { configurable: true, get: () => width });
  const content = view.document.querySelector("#content");
  const swipes = [];
  let mediaOpen = false;
  const swipe = createContentSwipe({ content, onSwipe: (direction) => swipes.push(direction), isMediaOpen: () => mediaOpen, view });
  content.addEventListener("touchstart", swipe.start, { passive: true });
  content.addEventListener("touchend", swipe.end, { passive: true });
  const touch = (target, type, point, touches) => {
    const event = new view.Event(type, { bubbles: true });
    Object.defineProperty(event, "changedTouches", { value: [{ clientX: point[0], clientY: point[1] }] });
    Object.defineProperty(event, "touches", { value: touches });
    target.dispatchEvent(event);
  };
  // One finger from `from` to `to` in `ms` milliseconds; `during` runs while it is down.
  const gesture = (target, from, to, ms, during) => {
    touch(target, "touchstart", from, [{}]);
    mock.timers.tick(ms);
    during?.();
    touch(target, "touchend", to, []);
  };
  return { dom, view, content, swipes, gesture, touch, setMediaOpen: (open) => { mediaOpen = open; } };
}

function detail(options) {
  const markup = renderExerciseDetailHtml({ item: items.get("item-2"), itemId: "item-2", ids, getItemById: (id) => items.get(id) });
  const page = mount(markup, options);
  page.area = page.content.querySelector(".exercise-detail-main");
  return page;
}

test("C1: a movement up or down in the detail never changes the exercise - fast, long, either way, anywhere in it", () => {
  const p = detail();
  for (const target of [p.area, p.content.querySelector(".drill-header"), p.content.querySelector(".exercise-detail-media")]) {
    p.gesture(target, [180, 650], [180, 150], 120);
    p.gesture(target, [180, 150], [180, 650], 120);
    p.gesture(target, [180, 650], [230, 350], 80);
  }
  assert.deepEqual(p.swipes, []);
  p.dom.window.close();
});

test("C2: a clear sideways swipe still changes it, both ways", () => {
  const p = detail();
  p.gesture(p.area, [300, 400], [160, 400], 150);
  p.gesture(p.area, [100, 400], [240, 400], 150);
  assert.deepEqual(p.swipes, [1, -1], "left: next, right: previous");
  p.dom.window.close();
});

test("C2: the detail's thresholds - 120 px and 30 % of the width, 2.5 times as far sideways, 0.3 px/ms", () => {
  assert.deepEqual({ ...DETAIL_SWIPE }, { minDistance: 120, minWidthShare: 0.3, minVelocity: 0.3, axisRatio: 2.5 });
  const p = detail();
  p.gesture(p.area, [300, 400], [181, 400], 100);
  assert.deepEqual(p.swipes, [], "119 px");
  p.gesture(p.area, [300, 400], [180, 400], 100);
  assert.deepEqual(p.swipes, [1], "120 px");
  p.gesture(p.area, [300, 400], [150, 340], 100);
  assert.deepEqual(p.swipes, [1, 1], "150 sideways, 60 down: exactly 2.5 times");
  p.gesture(p.area, [300, 400], [150, 339], 100);
  assert.deepEqual(p.swipes, [1, 1], "61 down: a scroll that drifted");
  p.gesture(p.area, [300, 400], [150, 400], 500);
  assert.deepEqual(p.swipes, [1, 1, 1], "0.3 px/ms");
  p.gesture(p.area, [300, 400], [150, 400], 501);
  assert.deepEqual(p.swipes, [1, 1, 1], "a slow drag");
  p.dom.window.close();
  const tablet = detail({ width: 768 });
  tablet.gesture(tablet.area, [600, 400], [371, 400], 100);
  assert.deepEqual(tablet.swipes, [], "229 px on a 768 px screen is under 30 %");
  tablet.gesture(tablet.area, [600, 400], [369, 400], 100);
  assert.deepEqual(tablet.swipes, [1]);
  tablet.dom.window.close();
});

test("C2: nothing changes when the detail or the page scrolled during the movement", () => {
  const p = detail();
  const layout = p.content.querySelector(".exercise-detail-layout");
  p.gesture(p.area, [300, 400], [150, 400], 150, () => { layout.scrollTop = 40; });
  p.gesture(p.area, [300, 400], [150, 400], 150, () => { p.content.scrollLeft = 30; });
  Object.defineProperty(p.view, "scrollY", { configurable: true, value: 0, writable: true });
  p.gesture(p.area, [300, 400], [150, 400], 150, () => { p.view.scrollY = 25; });
  assert.deepEqual(p.swipes, []);
  p.view.scrollY = 25;
  layout.scrollTop = 40;
  p.content.scrollLeft = 30;
  p.gesture(p.area, [300, 400], [150, 400], 150, () => { layout.scrollTop = 41; });
  assert.deepEqual(p.swipes, [1], "a pixel of rounding is not a scroll");
  p.dom.window.close();
});

test("C2: a second finger (a pinch) is never a swipe of the detail", () => {
  const p = detail();
  p.touch(p.area, "touchstart", [300, 400], [{}]);
  p.touch(p.area, "touchstart", [100, 500], [{}, {}]);
  mock.timers.tick(120);
  p.touch(p.area, "touchend", [150, 400], [{}]);
  p.touch(p.area, "touchend", [100, 500], []);
  assert.deepEqual(p.swipes, []);
  // The second finger on the shade around the detail, where no swipe starts.
  p.touch(p.area, "touchstart", [300, 400], [{}]);
  p.touch(p.content.querySelector(".exercise-detail-backdrop"), "touchstart", [10, 20], [{}, {}]);
  mock.timers.tick(120);
  p.touch(p.area, "touchend", [150, 400], [{}]);
  assert.deepEqual(p.swipes, []);
  p.gesture(p.area, [300, 400], [150, 400], 150);
  assert.deepEqual(p.swipes, [1], "the next single finger swipes again");
  p.dom.window.close();
});

test("C3: the strip of other exercises never changes the exercise; it scrolls sideways and a tap opens one", async () => {
  const p = detail();
  const strip = p.content.querySelector(".exercise-sibling-strip");
  const row = strip.querySelector(".exercise-sibling-row");
  for (const target of [row, strip.querySelector(".exercise-sibling-card"), strip.querySelector(".exercise-sibling-card span"), strip.querySelector(".eyebrow")]) {
    p.gesture(target, [340, 700], [20, 700], 100);
    p.gesture(target, [20, 700], [340, 700], 100);
  }
  assert.deepEqual(p.swipes, []);
  const css = (await readFile(new URL("../styles.css", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(css, /\.exercise-sibling-row \{\n  display: flex;\n  gap: 8px;\n  overflow-x: auto;/, "the strip scrolls sideways");
  const cards = [...strip.querySelectorAll(".exercise-sibling-card")];
  assert.deepEqual(cards.map((card) => card.dataset.action), ids.map(() => "exercise-jump"));
  assert.equal(cards[3].dataset.itemId, "item-3");
  assert.equal(strip.querySelector(".exercise-sibling-card.is-active").dataset.itemId, "item-2");
  assert.equal(strip.querySelector(".exercise-sibling-card.is-active").disabled, true, "the exercise shown stays off");
  assert.ok(cards.filter((card) => card.dataset.itemId !== "item-2").every((card) => !card.disabled));
  p.dom.window.close();
});

test("C3/C5: a tap on a strip card opens it; Previous, Next and Back work as before", async () => {
  const dom = new JSDOM("<body></body>");
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const { handleExerciseDetailAction } = await import("../exercise-actions.js");
  const calls = [];
  const handlers = {
    getItemById: (id) => items.get(id),
    moveExerciseDetail: (delta) => calls.push(["move", delta]),
    renderExerciseDetail: (item, id) => calls.push(["open", id]),
    pushAppHistory: () => calls.push(["history"]),
    renderCurrentNode: () => calls.push(["node"]),
  };
  assert.equal(handleExerciseDetailAction({ dataset: { action: "exercise-jump", itemId: "item-4" } }, handlers), true);
  assert.equal(handleExerciseDetailAction({ dataset: { action: "exercise-prev" } }, handlers), true);
  assert.equal(handleExerciseDetailAction({ dataset: { action: "exercise-next" } }, handlers), true);
  assert.deepEqual(calls, [["open", "item-4"], ["move", -1], ["move", 1]]);
  const markup = renderExerciseDetailHtml({ item: items.get("item-2"), itemId: "item-2", ids, getItemById: (id) => items.get(id) });
  const footer = new JSDOM(markup).window.document.querySelector(".exercise-detail-footer");
  assert.deepEqual([...footer.querySelectorAll("button")].map((button) => button.dataset.action), ["exercise-back", "exercise-prev", "exercise-next", "home"]);
  dom.window.close();
});

test("C4: the program tree and the weeks keep their rule exactly - 86 px, 0.28 px/ms, 1.8 times as far sideways", () => {
  assert.deepEqual({ ...TREE_SWIPE }, { minDistance: 86, minVelocity: 0.28, axisRatio: 1.8 });
  const p = mount('<div class="node-grid"><button class="node-card" type="button">Section</button></div><div class="panel"><p class="week">Week</p></div>');
  const node = p.content.querySelector(".node-card");
  const panel = p.content.querySelector(".week");
  p.gesture(node, [300, 400], [215, 400], 100);
  assert.deepEqual(p.swipes, [], "85 px");
  p.gesture(node, [300, 400], [214, 400], 100);
  assert.deepEqual(p.swipes, [1], "86 px");
  p.gesture(panel, [100, 400], [190, 450], 100);
  assert.deepEqual(p.swipes, [1, -1], "90 sideways, 50 down: 1.8 times");
  p.gesture(panel, [100, 400], [190, 451], 100);
  assert.deepEqual(p.swipes, [1, -1], "51 down");
  p.gesture(node, [300, 400], [200, 400], 357);
  assert.deepEqual(p.swipes, [1, -1, 1], "0.28 px/ms");
  p.gesture(node, [300, 400], [200, 400], 358);
  assert.deepEqual(p.swipes, [1, -1, 1], "slower");
  p.gesture(node, [180, 650], [180, 150], 120);
  assert.deepEqual(p.swipes, [1, -1, 1], "up or down: nothing, as before");
  p.gesture(node, [300, 400], [214, 400], 100, () => { p.content.scrollLeft = 50; });
  assert.deepEqual(p.swipes, [1, -1, 1, 1], "the tree's rule never looked at scrolling, and still does not");
  p.dom.window.close();
});

test("C4: where a swipe may start is unchanged, the strip aside - calendars, the week picker, lists and the media viewer keep the finger", () => {
  const p = mount('<div class="panel"><div class="calendar-grid"><i>1</i></div><div class="week-selector"><i>w</i></div><div class="exercise-list"><i>e</i></div><p class="free">x</p></div><div class="elsewhere">y</div>');
  for (const selector of [".calendar-grid i", ".week-selector i", ".exercise-list i", ".elsewhere"]) p.gesture(p.content.querySelector(selector), [300, 400], [150, 400], 100);
  assert.deepEqual(p.swipes, []);
  p.setMediaOpen(true);
  p.gesture(p.content.querySelector(".free"), [300, 400], [150, 400], 100);
  assert.deepEqual(p.swipes, []);
  p.setMediaOpen(false);
  p.gesture(p.content.querySelector(".free"), [300, 400], [150, 400], 100);
  assert.deepEqual(p.swipes, [1]);
  p.dom.window.close();
});

// A dialog opened over the detail (the editor from Edit / Copy, now drawn in
// front of a Specific Program too) keeps the finger: a fast drag on its frame
// slider met the detail's swipe and moved the exercise behind it.
test("C6: a swipe in a dialog over the detail - the editor and its slider, tags, a Builder modal - never changes the exercise behind; the detail itself still swipes", () => {
  const p = detail();
  p.content.insertAdjacentHTML("beforeend", '<div class="exercise-editor-overlay"><section class="panel exercise-editor-modal"><input type="range" class="frame"><p class="text">x</p></section></div><div class="exercise-tag-overlay"><section class="panel exercise-tag-modal"><p class="tag">t</p></section></div><div class="builder-modal-overlay"><section class="panel"><p class="builder">b</p></section></div>');
  for (const selector of [".frame", ".text", ".tag", ".builder"]) {
    p.gesture(p.content.querySelector(selector), [300, 400], [140, 400], 150);
    p.gesture(p.content.querySelector(selector), [100, 400], [260, 400], 150);
  }
  assert.deepEqual(p.swipes, []);
  p.gesture(p.area, [300, 400], [160, 400], 150);
  assert.deepEqual(p.swipes, [1], "the detail itself: as before");
  p.dom.window.close();
});

test("app.js: one listener pair on #content, the old vertical rule gone, back on the first exercise still returns", async () => {
  const app = (await readFile(new URL("../app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(app, /const contentSwipe = createContentSwipe\(\{ content: els\.content, onSwipe: handleHorizontalSwipe, isMediaOpen: \(\) => !els\.mediaModal\?\.hidden \}\);\n  els\.content\.addEventListener\("touchstart", contentSwipe\.start, \{ passive: true \}\);\n  els\.content\.addEventListener\("touchend", contentSwipe\.end, \{ passive: true \}\);/);
  assert.doesNotMatch(app, /function handleSwipeStart|function handleSwipeEnd|function isSwipeContext|state\.touch|velocityY|deltaY < 0 \? 1 : -1/);
  const horizontal = app.match(/function handleHorizontalSwipe\(direction\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(horizontal, /if \(direction < 0 && currentIndex <= 0\) \{\n      returnToNodeParent\(\);/);
  assert.match(horizontal, /moveNodeSibling\(1\)[\s\S]*moveNodeSibling\(-1\)[\s\S]*moveWeek\(direction\)/);
});

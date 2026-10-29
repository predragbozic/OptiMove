import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { HEADER_HIDE_DISTANCE, HEADER_MAX_SCREEN_SHARE, HEADER_REVEAL_DISTANCE, installExerciseHeaderReveal } from "../exercise-header-reveal.js";

// Exercise Library (owner, 2026-10-29): the header scrolls away with the list
// as before, and one short pull up brings it back pinned over the list;
// going on down hides it again. Driven here through the module's own scroll,
// focus and toggle listeners on a page whose geometry is the 375 px phone's
// measured in the browser: the top bar 10-139 px, the search row 147-365 px.

const TOPBAR = { top: 10, bottom: 139 };
const TOOLBAR = { top: 147, bottom: 365 };
const settleHide = () => new Promise((resolve) => setTimeout(resolve, 260));

function page({ reducedMotion = false, active = true, height = 812, width = 375, topbar = TOPBAR, toolbar = TOOLBAR } = {}) {
  const dom = new JSDOM(`<body>
    <main class="workspace">
      <header class="topbar"><button class="mobile-nav-toggle" type="button">Menu</button><div class="notification-panel" hidden></div><div class="workspace-panel" hidden></div></header>
      <section class="toolbar" id="viewToolbar"><input id="exerciseSearch" type="search"><label><input type="checkbox" data-exercise-filter="favorite"></label><details class="builder-exercise-filters"><summary>More filters</summary></details></section>
      <section class="content" id="content"><div class="exercise-selection-bar"></div></section>
    </main></body>`);
  const view = dom.window;
  const doc = view.document;
  let y = 0;
  Object.defineProperty(view, "scrollY", { configurable: true, get: () => y });
  Object.defineProperty(doc.documentElement, "scrollHeight", { configurable: true, get: () => 10000 });
  const screen = { height, width };
  Object.defineProperty(view, "innerHeight", { configurable: true, get: () => screen.height });
  Object.defineProperty(view, "innerWidth", { configurable: true, get: () => screen.width });
  view.matchMedia = (query) => ({ matches: reducedMotion && query.includes("reduce") });
  const scrolledTo = [];
  view.scrollTo = (x, top) => { scrolledTo.push(top); y = top; };
  // Measured only while the header is in its place (the module reads it then).
  const rect = ({ top, bottom }) => () => ({ top: top - y, bottom: bottom - y, height: bottom - top });
  doc.querySelector(".topbar").getBoundingClientRect = rect(topbar);
  doc.querySelector("#viewToolbar").getBoundingClientRect = rect(toolbar);
  const state = { active };
  const shifts = [];
  const setProperty = doc.body.style.setProperty.bind(doc.body.style);
  doc.body.style.setProperty = (name, value) => {
    if (name === "--exercise-header-shift") shifts.push(value);
    setProperty(name, value);
  };
  const reveal = installExerciseHeaderReveal({ view, isActive: () => state.active });
  const scrollTo = (top) => { y = top; view.dispatchEvent(new view.Event("scroll")); };
  const scrollBy = (delta, steps = 1) => { for (let index = 0; index < steps; index += 1) scrollTo(y + delta / steps); };
  return {
    dom, doc, view, reveal, state, shifts, scrolledTo, scrollTo, scrollBy, screen,
    pinned: () => doc.body.classList.contains("exercise-header-pinned"),
    cssVar: (name) => doc.body.style.getPropertyValue(name),
  };
}

test("B1/B2: scrolling down leaves the header in the page; a pull up of 16 px pins it at once, under 16 px does not", () => {
  const p = page();
  assert.equal(HEADER_REVEAL_DISTANCE, 16);
  p.scrollTo(3000);
  assert.equal(p.pinned(), false, "scrolling down: as before, it scrolled away");
  p.scrollBy(-15, 3);
  assert.equal(p.pinned(), false, "15 px up is not enough");
  p.scrollBy(10);
  p.scrollBy(-15, 5);
  assert.equal(p.pinned(), false, "a move down in between starts the count again");
  p.scrollBy(-1);
  assert.equal(p.pinned(), true, "16 px of one pull up");
  assert.equal(p.cssVar("--exercise-header-shift"), "0px", "fully in view");
  assert.equal(p.cssVar("--exercise-header-toolbar-top"), "137px", "the search row right where it is under the top bar");
  assert.equal(p.cssVar("--exercise-header-gap"), "8px");
  assert.equal(p.shifts.at(-2), "-355px", "slides in from just above the screen");
  p.dom.window.close();
});

test("B2: going on down hides it again (8 px), and it goes back into its place in the page", async () => {
  const p = page();
  assert.equal(HEADER_HIDE_DISTANCE, 8);
  p.scrollTo(3000);
  p.scrollBy(-20);
  p.scrollBy(7);
  assert.equal(p.cssVar("--exercise-header-shift"), "0px", "7 px down: still shown");
  p.scrollBy(1);
  assert.equal(p.cssVar("--exercise-header-shift"), "-355px", "slides up out of the screen");
  assert.equal(p.pinned(), true, "until the slide ends");
  await settleHide();
  assert.equal(p.pinned(), false);
  assert.equal(p.cssVar("--exercise-header-shift"), "");
  p.scrollBy(-16);
  assert.equal(p.pinned(), true, "and again");
  p.dom.window.close();
});

test("B2: with part of the header still in view it slides from where it is, and back to it", async () => {
  const p = page();
  p.scrollTo(200);
  p.scrollBy(-20);
  assert.equal(p.shifts.at(-2), "-170px", "starts where the top bar stood (10 - 180)");
  assert.equal(p.pinned(), true);
  p.scrollBy(10);
  assert.equal(p.cssVar("--exercise-header-shift"), "-180px", "back to where it stands at 190");
  await settleHide();
  assert.equal(p.pinned(), false);
  p.dom.window.close();
});

test("B2: at the very top everything is as before", () => {
  const p = page();
  p.scrollTo(3000);
  p.scrollBy(-20);
  assert.equal(p.pinned(), true);
  p.scrollTo(0);
  assert.equal(p.pinned(), false, "in its own place at once");
  assert.equal(p.doc.body.getAttribute("style") || "", "");
  p.scrollTo(30);
  p.scrollTo(10);
  assert.equal(p.pinned(), true, "a pull up near the top still counts");
  p.scrollTo(-40);
  assert.equal(p.pinned(), false, "the bounce over the top too");
  p.dom.window.close();
});

test("B2: never pinned over more than two thirds of the screen - a phone held sideways keeps the header in the page", () => {
  assert.equal(HEADER_MAX_SCREEN_SHARE, 2 / 3);
  // 740 x 360, measured in the browser: the top bar 10-86 px, the search row 94-256 px (68 %).
  const sideways = page({ height: 360, width: 740, topbar: { top: 10, bottom: 86 }, toolbar: { top: 94, bottom: 256 } });
  sideways.scrollTo(3000);
  sideways.scrollBy(-40, 4);
  assert.equal(sideways.pinned(), false);
  sideways.dom.window.close();
  // 360 x 740 upright: 355 px is 48 %.
  const upright = page({ height: 740, width: 360 });
  upright.scrollTo(3000);
  upright.scrollBy(-16);
  assert.equal(upright.pinned(), true);
  upright.dom.window.close();
  // 355 px: pinned on a 533 px screen (two thirds is 355.3), not on 532 (354.7).
  for (const [height, pinned] of [[533, true], [532, false]]) {
    const edge = page({ height });
    edge.scrollTo(3000);
    edge.scrollBy(-16);
    assert.equal(edge.pinned(), pinned, `${height} px`);
    edge.dom.window.close();
  }
});

test("B3: turning the phone while it is pinned puts it back in the page; the browser's bars or the keyboard do not", () => {
  const p = page();
  p.scrollTo(3000);
  p.scrollBy(-20);
  p.screen.height = 600;
  p.view.dispatchEvent(new p.view.Event("resize"));
  assert.equal(p.pinned(), true, "a change of height alone");
  p.screen.width = 812;
  p.screen.height = 375;
  p.view.dispatchEvent(new p.view.Event("resize"));
  assert.equal(p.pinned(), false, "turned");
  assert.equal(p.doc.body.getAttribute("style") || "", "");
  p.dom.window.close();
});

test("B2: the bounce past the end of the list (iOS) is not a pull up", () => {
  const p = page();
  p.scrollTo(9188);
  p.scrollTo(9260);
  p.scrollTo(9188);
  assert.equal(p.pinned(), false);
  p.dom.window.close();
});

test("B3: prefers-reduced-motion hides it at once, without the slide", () => {
  const p = page({ reducedMotion: true });
  p.scrollTo(3000);
  p.scrollBy(-20);
  p.scrollBy(10);
  assert.equal(p.pinned(), false);
  p.dom.window.close();
});

test("B3: typing in the search keeps the header; a tapped button or tick box does not", () => {
  const p = page();
  p.scrollTo(3000);
  p.scrollBy(-20);
  p.doc.querySelector("#exerciseSearch").focus();
  p.scrollBy(300, 6);
  assert.equal(p.cssVar("--exercise-header-shift"), "0px", "the keyboard's scroll never hides the search");
  p.doc.querySelector(".mobile-nav-toggle").focus();
  p.scrollBy(10);
  assert.notEqual(p.cssVar("--exercise-header-shift"), "0px", "a button keeps the focus after a tap, it does not hold the header");
  p.scrollBy(-20);
  p.doc.querySelector('[data-exercise-filter="favorite"]').focus();
  p.scrollBy(10);
  assert.notEqual(p.cssVar("--exercise-header-shift"), "0px");
  p.dom.window.close();
});

test("B3: the search taking the focus while the header slides away brings it back", () => {
  const p = page();
  p.scrollTo(3000);
  p.scrollBy(-20);
  p.scrollBy(10);
  assert.equal(p.cssVar("--exercise-header-shift"), "-355px");
  p.doc.querySelector("#exerciseSearch").focus();
  assert.equal(p.cssVar("--exercise-header-shift"), "0px");
  p.dom.window.close();
});

test("B3: an open menu or panel of the top bar keeps the header", () => {
  const p = page();
  p.scrollTo(3000);
  p.scrollBy(-20);
  p.doc.body.classList.add("mobile-nav-open");
  p.scrollBy(30);
  assert.equal(p.cssVar("--exercise-header-shift"), "0px");
  p.doc.body.classList.remove("mobile-nav-open");
  p.doc.querySelector(".notification-panel").hidden = false;
  p.scrollBy(30);
  assert.equal(p.cssVar("--exercise-header-shift"), "0px");
  p.doc.querySelector(".notification-panel").hidden = true;
  p.scrollBy(30);
  assert.equal(p.cssVar("--exercise-header-shift"), "-355px");
  p.dom.window.close();
});

test("B3: open More filters is never pinned over the list; opened in the pinned header it goes back into the page where it is", () => {
  const p = page();
  const details = p.doc.querySelector("details");
  details.open = true;
  p.scrollTo(3000);
  p.scrollBy(-40);
  assert.equal(p.pinned(), false, "open filters stay in the page");
  details.open = false;
  p.scrollBy(-20);
  assert.equal(p.pinned(), true);
  details.open = true;
  details.dispatchEvent(new p.view.Event("toggle"));
  assert.equal(p.pinned(), false);
  assert.deepEqual(p.scrolledTo, [10], "the page brought to the header's own place: the top bar stays at the top of the screen");
  p.dom.window.close();
});

test("B4: only on the Exercise Library; another screen puts the header back at once", () => {
  const p = page({ active: false });
  p.scrollTo(3000);
  p.scrollBy(-40);
  assert.equal(p.pinned(), false, "another screen: as before");
  p.state.active = true;
  p.reveal.sync();
  p.scrollBy(-20);
  assert.equal(p.pinned(), true);
  p.state.active = false;
  p.reveal.sync();
  assert.equal(p.pinned(), false, "leaving the library");
  assert.equal(p.doc.body.getAttribute("style") || "", "");
  p.dom.window.close();
});

test("B3: styles - sticky (never fixed, never a transform), under the menu, slide off for reduced motion, the selection bar untouched", async () => {
  const css = (await readFile(new URL("../styles.css", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const block = css.slice(css.indexOf("body.exercise-header-pinned .workspace > .topbar,"));
  // A rule whose selector starts its own line after the previous rule's "}".
  const rule = (selector) => `}\n${block}`.match(new RegExp(`\\}\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] || "";
  const shared = rule("body.exercise-header-pinned .workspace > .topbar,\nbody.exercise-header-pinned #viewToolbar");
  assert.match(shared, /position: sticky;/);
  assert.match(shared, /transition: top 180ms ease-out;/);
  assert.doesNotMatch(block.slice(0, block.indexOf("@media (prefers-reduced-motion")), /position: fixed|transform/);
  assert.match(rule("body.exercise-header-pinned .workspace > .topbar"), /top: var\(--exercise-header-shift, 0px\);\n  z-index: 31;/);
  assert.match(rule("body.exercise-header-pinned #viewToolbar"), /z-index: 30;/);
  assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{\n  body\.exercise-header-pinned \.workspace > \.topbar,\n  body\.exercise-header-pinned #viewToolbar \{\n    transition: none;/);
  // Under the athletes drawer's shade (39), the sidebar (40), the menu's
  // backdrop and popup (55, 60) and the app update notice (50).
  assert.match(css, /\.app-update-banner \{[^}]*z-index: 50;/);
  assert.match(css, /\.exercise-selection-bar \{ position: sticky; bottom: 12px; z-index: 4;/);
});

test("app.js installs it for the Exercise Library only and syncs it on every change of screen", async () => {
  const app = (await readFile(new URL("../app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(app, /exerciseHeaderReveal = installExerciseHeaderReveal\(\{ isActive: \(\) => state\.activeTab === "exercises" && !isAthleteMode\(\) \}\);/);
  const renderTabs = app.match(/function renderTabs\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(renderTabs, /exerciseHeaderReveal\?\.sync\(\);/);
});

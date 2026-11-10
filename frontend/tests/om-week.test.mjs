// Design A3: a coach's week - the days never cut off (cards that wrap on a computer, a list on a
// phone), 44 px week controls, the short week range on a phone. The athlete's app is untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
const { renderWeeklyRootHtml, scrollWeekToDay } = await import("../program-view.js");

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const host = (markup) => { const el = document.createElement("div"); el.innerHTML = markup; return el; };
const week = (weekStart, weekEnd, days = []) => renderWeeklyRootHtml({
  activeWeek: { weekStart, weekEnd, days, planId: "" },
  copyPlanModal: "",
  makeNode: () => ({}),
  renderPlanMoreMenu: () => "",
  weekSelectorMarkup: "",
});

test("the week range: the full form, and a short one for a coach's phone (full again across a new year)", () => {
  const same = host(week("2026-11-09", "2026-11-15"));
  assert.equal(same.querySelector(".week-range-full").textContent, "09.11.2026 - 15.11.2026");
  assert.equal(same.querySelector(".week-range-short").textContent, "09.11 - 15.11.2026");
  assert.equal(same.querySelector(".week-range-short").getAttribute("aria-hidden"), "true");
  const across = host(week("2026-12-28", "2027-01-03"));
  assert.equal(across.querySelector(".week-range-short").textContent, "28.12.2026 - 03.01.2027");
});

test("today's day keeps its text, with ' · Today' in a label of its own", () => {
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const el = host(week(iso, iso, [{ date: iso, slots: {} }]));
  const date = el.querySelector(".calendar-date");
  assert.match(date.textContent, /^\d\d\.\d\d · Today$/);
  assert.equal(date.querySelector(".calendar-today-label").textContent, " · Today");
});

function grid(overflowX) {
  const el = host(`<div class="calendar-grid" style="overflow-x:${overflowX}"><article data-date="2026-11-14"></article></div>`).firstElementChild;
  document.body.append(el);
  const calls = [];
  el.scrollTo = (opts) => calls.push(["scrollTo", opts.left]);
  el.querySelector("article").scrollIntoView = (opts) => calls.push(["scrollIntoView", opts.block]);
  return { el, calls };
}

test("scrollWeekToDay: a week without a sideways scroll gets no trailing space and shows the day where it is", () => {
  const { el, calls } = grid("visible");
  el.style.paddingRight = "300px";
  scrollWeekToDay(el, "2026-11-14");
  assert.equal(el.style.paddingRight, "");
  assert.deepEqual(calls, [["scrollIntoView", "nearest"]]);
});

test("scrollWeekToDay: a sideways week (the athlete's app) still scrolls to the day with trailing space", () => {
  const { el, calls } = grid("auto");
  scrollWeekToDay(el, "2026-11-14");
  assert.match(el.style.paddingRight, /^\d+px$/);
  assert.deepEqual(calls.map((c) => c[0]), ["scrollTo"]);
});

test("the A3 block: every rule but the hidden short range is a coach's, and the day grid no longer has a fixed 150 px minimum there", () => {
  const from = css.indexOf("Design: a coach's week (A3).");
  assert.ok(from > 0);
  const end = css.indexOf("\n/* =====", from + 10);
  const block = css.slice(css.lastIndexOf("/*", from), end > 0 ? end : undefined).replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...block.matchAll(/([^{}@;]+)\{/g)].map((m) => m[1].trim()).filter((s) => s && !s.startsWith("@") && !s.startsWith("media"));
  assert.ok(selectors.length > 10);
  for (const group of selectors) {
    for (const sel of group.split(",").map((s) => s.trim())) {
      if (sel === ".week-title-button .week-range-short") continue;
      assert.ok(sel.startsWith("body:not(.athlete-mode):not(.login-mode) "), sel);
    }
  }
  assert.match(block, /repeat\(7, minmax\(0, 1fr\)\)/);
  assert.match(block, /repeat\(4, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(block, /minmax\(150px/);
  for (const rule of ["week-arrow-button", "week-new-plan-button"]) {
    const body = block.slice(block.indexOf(`.week-nav-panel .${rule} {`));
    assert.match(body.slice(0, body.indexOf("}")), /min-width: var\(--om-tap-target\)/, rule);
  }
});

// Design A2: a coach's athlete header is the athlete's picture beside the shared tab row (.om-tabs);
// the athlete's own app keeps its header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
const { renderAthleteHeaderToolbarHtml } = await import("../athlete-view.js");
const { markCurrentTab } = await import("../om-tabs.js");

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = (markup) => { const host = document.createElement("div"); host.innerHTML = markup; return host; };
const athlete = { athlete_id: "1", athlete: "Ana Example" };

test("a coach's header: the picture and an .om-tabs row whose buttons renderTabs still finds", () => {
  const host = html(renderAthleteHeaderToolbarHtml(athlete, { isAthleteMode: false }));
  const row = host.querySelector(".athlete-toolbar-row.athlete-toolbar-coach");
  assert.ok(row);
  assert.equal(row.querySelector(".athlete-hero.athlete-hero-compact .athlete-hero-fallback").textContent, "AE");
  const nav = row.querySelector("nav");
  assert.equal(nav.className, "tabs athlete-tabs om-tabs");
  const tabs = [...nav.querySelectorAll("button")];
  assert.deepEqual(tabs.map((t) => [t.className, t.dataset.tab, t.textContent]), [["tab om-tab", "weekly", "Weekly plans"], ["tab om-tab", "programs", "Specific programs"]]);
  assert.equal(nav.querySelector("svg"), null);
  assert.equal(row.querySelector(".athlete-hero-copy"), null, "the name is the page's title, not repeated");
});

test("the athlete's own header is unchanged (icons, the My program eyebrow, no coach class)", () => {
  const host = html(renderAthleteHeaderToolbarHtml(athlete, { isAthleteMode: true }));
  assert.equal(host.querySelector(".athlete-toolbar-coach"), null);
  assert.equal(host.querySelector(".om-tabs"), null);
  assert.equal(host.querySelector(".athlete-hero").className.trim(), "athlete-hero");
  assert.match(host.querySelector(".athlete-hero-copy .eyebrow").textContent, /My program/);
  assert.equal(host.querySelectorAll(".athlete-tabs .tab.tab-with-icon svg").length, 2);
});

test("markCurrentTab moves aria-current=page to the current .om-tab and never touches another .tab", () => {
  const host = html(renderAthleteHeaderToolbarHtml(athlete, { isAthleteMode: false })
    + '<button class="tab" data-tab="weekly">Plain</button>');
  const all = [...host.querySelectorAll(".tab")];
  const select = (current) => all.forEach((tab) => markCurrentTab(tab, tab.dataset.tab === current));
  const weekly = host.querySelector('.om-tab[data-tab="weekly"]');
  const programs = host.querySelector('.om-tab[data-tab="programs"]');
  const plain = host.querySelector(".tab:not(.om-tab)");
  select("weekly");
  assert.equal(weekly.getAttribute("aria-current"), "page");
  assert.equal(programs.hasAttribute("aria-current"), false);
  select("programs");
  assert.equal(programs.getAttribute("aria-current"), "page");
  assert.equal(weekly.hasAttribute("aria-current"), false);
  assert.equal(plain.hasAttribute("aria-current"), false);
});

test("renderTabs uses markCurrentTab and reveals the toolbar's tab row (it is outside #content)", () => {
  const body = app.slice(app.indexOf("function renderTabs() {"), app.indexOf("function renderTabs() {") + 1200);
  assert.match(body, /tab\.classList\.toggle\("is-active", active\);\n(?:\s*\/\/[^\n]*\n)?\s+markCurrentTab\(tab, active\);/);
  assert.match(body, /revealActiveTab\(els\.toolbar\);/);
});

test("the athlete's own header markup is byte for byte the base one (its hero class included)", () => {
  const markup = renderAthleteHeaderToolbarHtml(athlete, { isAthleteMode: true });
  assert.ok(markup.includes('<section class="athlete-hero " aria-label="Selected athlete">'));
});

test("the A2 block is scoped to the coach's row and outranks the older coach rules", () => {
  const from = css.indexOf("Design: a coach's athlete header (A2).");
  const end = css.indexOf("\n/* =====", from + 10);
  const block = css.slice(css.lastIndexOf("/*", from), end > 0 ? end : undefined).replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...block.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(",").map((x) => x.trim())).filter(Boolean);
  assert.ok(selectors.length >= 5);
  for (const sel of selectors) assert.match(sel, /^body:not\(\.athlete-mode\):not\(\.login-mode\) \.athlete-toolbar-(row\.athlete-toolbar-coach|coach )/, sel);
  assert.match(block, /\.athlete-hero-compact \{[^}]*display: flex;[^}]*grid-template-columns: none;/, "the picture's box fits the picture");
});

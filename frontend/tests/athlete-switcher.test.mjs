// K6 (docs/ai/central-calendar-k6-contract.md 6.1): the shared strip, the caption rule and the search.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.document = new JSDOM("<body></body>").window.document;
const S = await import("../athlete-switcher.js");

const doc = (html) => new JSDOM(`<body>${html}</body>`).window.document;
const strip = (opts) => doc(S.renderAthleteSwitcherStripHtml({ action: "pick", keyAttr: "data-k", ...opts }));
const ITEMS = [{ key: "a", name: "Ana Kovač" }, { key: "b", name: "Ben" }, { key: "c", name: "Cara Dee" }];
const arrows = (d) => [...d.querySelectorAll(".icon-button")];

test("the caption rule: first name and the last name's initial; one word stays", () => {
  assert.equal(S.athleteCaption("Ana Kovač"), "Ana K.");
  assert.equal(S.athleteCaption("Ana Maria Kovač"), "Ana K.");
  assert.equal(S.athleteCaption("Ben"), "Ben");
});

test("the strip without All: the ends are disabled, nothing wraps, no dot, no label", () => {
  const d = strip({ items: ITEMS, currentKey: "a" });
  assert.equal(arrows(d)[0].disabled, true);
  assert.equal(arrows(d)[1].disabled, false);
  assert.equal(arrows(d)[1].dataset.k, "b");
  assert.equal(d.querySelector(".athlete-switcher-dot"), null);
  assert.equal(d.querySelector(".athlete-switcher-group-label"), null);
  assert.equal(strip({ items: ITEMS, currentKey: "c" }).querySelectorAll(".icon-button")[1].disabled, true);
});

test("the All pill is first with the key \"\": < is disabled on Everyone and > chooses the first athlete; the first athlete's < is All", () => {
  const all = { label: "Everyone", caption: "All" };
  const d = strip({ items: ITEMS, currentKey: "", allItem: all });
  const pills = [...d.querySelectorAll(".builder-batch-pill")];
  assert.equal(pills[0].dataset.k, "");
  assert.equal(pills[0].getAttribute("aria-pressed"), "true");
  assert.equal(arrows(d)[0].disabled, true);
  assert.equal(arrows(d)[1].dataset.k, "a");
  const first = strip({ items: ITEMS, currentKey: "a", allItem: all });
  assert.equal(arrows(first)[0].disabled, false);
  assert.equal(arrows(first)[0].dataset.k, "");
});

test("the dot, the team label and an escaped name", () => {
  const d = strip({ items: [{ key: "a", name: "<img src=x onerror=1>", teamColorStyle: "--cc-team-color: red", groupLabel: "U19" }], currentKey: "a" });
  assert.ok(d.querySelector(".athlete-switcher-dot"));
  assert.equal(d.querySelector(".athlete-switcher-group-label").textContent, "U19");
  assert.equal(d.querySelector("img"), null, "a name is text");
});

test("the search: accents, word starts first, the cap of 8 and the 'and N more' line", () => {
  const people = [{ key: "1", name: "Ana Kovač" }, { key: "2", name: "Marko Stone" }, { key: "3", name: "Dimar Hall" }, { key: "4", name: "Tamara Boyd", teamOrder: 0 }];
  assert.deepEqual(S.searchAthletes(people, "KOVAC").results.map((p) => p.key), ["1"]);
  assert.deepEqual(S.searchAthletes(people, "mar").results.map((p) => p.key), ["2", "3", "4"].sort((a, b) => 0), "word starts first (Marko), then inside a word");
  const many = Array.from({ length: 12 }, (_, i) => ({ key: String(i), name: `Max ${String(i).padStart(2, "0")}` }));
  const r = S.searchAthletes(many, "max");
  assert.equal(r.results.length, 8);
  assert.equal(r.more, 4);
  const html = S.renderAthleteSwitcherResultsHtml({ value: "max", results: r });
  assert.match(html, /and 4 more — keep typing/);
  assert.equal(S.searchAthletes(people, "").results.length, 0);
});

test("the highlight marks the match in text only", () => {
  assert.equal(S.highlightMatchHtml("Marko", "mar"), "<mark>Mar</mark>ko");
  assert.equal(S.highlightMatchHtml("<b>Ana", "ana"), "&lt;b&gt;<mark>Ana</mark>");
});

test("the empty result is the caller's sentence, escaped", () => {
  const html = S.renderAthleteSwitcherResultsHtml({ value: "x", results: { results: [], more: 0 }, emptySentence: "No athlete in this team matches ‘<x>’." });
  assert.match(html, /&lt;x&gt;/);
});

test("the scroll helper is safe without layout", () => {
  assert.equal(S.athleteSwitcherScrollIntoView(strip({ items: ITEMS, currentKey: "b" })), true);
  assert.equal(S.athleteSwitcherScrollIntoView(doc("")), false);
});

// The shared athlete switcher (K6 contract 1.2, 2.6): the strip with and without its opt-in parts, the caption rule,
// the ends without wrap, the scroll helper, and the search's ranking, accents, cap and empty sentence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const sw = await import("../athlete-switcher.js");
const doc = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
const items = [{ key: "a", name: "Ana Kovač" }, { key: "b", name: "Ben", imageUrl: "https://example.invalid/b.jpg" }, { key: "c", name: "Cara Lee", teamColorStyle: ' style="--cc-team-color: red"', groupLabel: "U19" }];

test("1. the caption rule: first name and the last word's initial, a single word as it is", () => {
  assert.equal(sw.athleteCaption("Ana Kovač"), "Ana K.");
  assert.equal(sw.athleteCaption("  Ana  Maria   Kovač "), "Ana K.");
  assert.equal(sw.athleteCaption("Ben"), "Ben");
});

test("2. the strip without opt-in parts draws none of them; with them, the All pill first, the dot, the group label", () => {
  const plain = sw.renderAthleteSwitcherStripHtml({ items: items.slice(0, 2), currentKey: "a", action: "x", keyAttr: "data-k" });
  assert.doesNotMatch(plain, /athlete-switcher-(dot|group-label|all|mark)|role="group"/);
  const full = doc(sw.renderAthleteSwitcherStripHtml({ items, currentKey: "", action: "x", keyAttr: "data-k", allItem: { label: "Everyone", caption: "All" }, ariaLabel: "Athletes" }));
  const pills = [...full.querySelectorAll(".builder-batch-pill")];
  assert.equal(pills[0].getAttribute("aria-label"), "Everyone");
  assert.equal(pills[0].dataset.k, "");
  assert.equal(pills[0].getAttribute("aria-pressed"), "true");
  assert.ok(full.querySelector('.builder-batch-pill[data-k="c"] .athlete-switcher-dot'));
  assert.equal(full.querySelector(".athlete-switcher-group-label").textContent, "U19");
  assert.equal(full.querySelector(".builder-batch-pills").getAttribute("aria-label"), "Athletes");
  assert.ok(full.querySelector('.builder-batch-pill[data-k="b"] img.builder-batch-photo'));
});

test("3. no wrap: ‹ disabled on the first pill (Everyone when given), › disabled on the last; with wrapArrows they go round", () => {
  const arrows = (html) => [...doc(html).querySelectorAll(".icon-button")];
  let [prev, next] = arrows(sw.renderAthleteSwitcherStripHtml({ items, currentKey: "", action: "x", keyAttr: "data-k", allItem: { label: "Everyone", caption: "All" } }));
  assert.equal(prev.disabled, true);
  assert.equal(next.dataset.k, "a");
  [prev, next] = arrows(sw.renderAthleteSwitcherStripHtml({ items, currentKey: "c", action: "x", keyAttr: "data-k" }));
  assert.equal(next.disabled, true);
  assert.equal(prev.dataset.k, "b");
  [prev, next] = arrows(sw.renderAthleteSwitcherStripHtml({ items, currentKey: "c", action: "x", keyAttr: "data-k", wrapArrows: true }));
  assert.equal(next.dataset.k, "a");
});

test("4. names are escaped everywhere (pill, label, caption, mark label)", () => {
  const html = sw.renderAthleteSwitcherStripHtml({ items: [{ key: "<k>", name: '<img src=x onerror="alert(1)">', mark: "–", markLabel: "not <here>" }], currentKey: "", action: "x", keyAttr: "data-k" });
  assert.doesNotMatch(html, /<img src=x/);
  assert.ok(doc(html).querySelector(".athlete-switcher-mark"));
});

test("5. the scroll helper brings the chosen pill into view inside its strip only", () => {
  const d = doc(sw.renderAthleteSwitcherStripHtml({ items, currentKey: "c", action: "x", keyAttr: "data-k" }));
  const pills = d.querySelector(".builder-batch-pills");
  let scrolled = null;
  pills.scrollTo = (options) => { scrolled = options; };
  Object.defineProperty(pills, "clientWidth", { value: 100 });
  const active = d.querySelector(".is-active");
  Object.defineProperty(active, "offsetLeft", { value: 300 });
  Object.defineProperty(active, "offsetWidth", { value: 76 });
  sw.athleteSwitcherScrollIntoView(d.body);
  assert.equal(scrolled.left, 300 - 12);
});

test("6. the search: accents and case ignored, a word start before a match inside, then the caller's rank, then name; 8 at most and the rest counted", () => {
  const list = [
    { key: "1", name: "Marko Šimić", rank: 1 }, { key: "2", name: "Simon Ilić", rank: 2 }, { key: "3", name: "Ana Kosimić", rank: 0 },
    ...Array.from({ length: 9 }, (_, i) => ({ key: `m${i}`, name: `Mate ${i}`, rank: 0 })),
  ];
  assert.deepEqual(sw.athleteSwitcherSearch(list, "SIM").results.map((row) => row.key), ["1", "2", "3"]);
  assert.deepEqual(sw.athleteSwitcherSearch(list, "ilic").results.map((row) => row.key), ["2"]);
  const many = sw.athleteSwitcherSearch(list, "mate");
  assert.equal(many.results.length, 8);
  assert.equal(many.more, 1);
  assert.deepEqual(sw.athleteSwitcherSearch(list, "  ").results, []);
  assert.equal(sw.athleteSearchHighlightHtml("Marko Šimić", "simi"), "Marko <mark>Šimi</mark>ć");
});

test("7. the search's body: the results, the more line, the empty sentence (escaped)", () => {
  const body = sw.renderAthleteSwitcherSearchResultsHtml({ value: "x", action: "a", results: [], emptySentence: "None of your athletes matches ‘<x>’." });
  assert.equal(doc(body).querySelector(".athlete-switcher-empty").textContent, "None of your athletes matches ‘<x>’.");
  assert.doesNotMatch(body, /<x>/);
  const more = sw.renderAthleteSwitcherSearchResultsHtml({ value: "m", action: "a", results: [{ key: "1", name: "Mate" }], more: 3 });
  assert.match(more, /and 3 more — keep typing/);
  assert.equal(sw.renderAthleteSwitcherSearchResultsHtml({ value: "", action: "a" }), "");
});

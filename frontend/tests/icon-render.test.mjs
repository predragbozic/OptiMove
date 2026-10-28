// The icon renderer (frontend/icon-render.js; Data configuration visual polish,
// PR-1, section 3.1): a stored `icon:<key>` draws the library's paths, an
// unknown key a neutral placeholder, an older Builder code its icon, and
// nothing a stored value holds ever reaches the markup unescaped. Also the
// search the gallery and the picker share, and the metric icon of the older
// screens (a library icon for a key, an image for a URL, as before).
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const {
  ICONS, iconByKey, iconKeyOfStored, isLibraryKey, renderIconSvg, renderMetricIconHtml, renderStoredIconHtml, searchIcons, storedIconValue,
} = await import("../icon-render.js");

const parse = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;

test("1. a key draws its own paths as one inline SVG, decoration unless it has a label", () => {
  const body = parse(renderIconSvg("run"));
  const svg = body.querySelector("svg");
  assert.ok(svg);
  assert.equal(svg.getAttribute("aria-hidden"), "true");
  assert.equal(svg.getAttribute("viewBox"), "0 0 24 24");
  assert.equal(svg.getAttribute("stroke"), "currentColor");
  assert.deepEqual([...svg.querySelectorAll("path")].map((p) => p.getAttribute("d")), [...iconByKey("run").paths]);
  assert.equal(body.children.length, 1);
  const labelled = parse(renderIconSvg("run", { label: `Run "fast" <b>` })).querySelector("svg");
  assert.equal(labelled.getAttribute("role"), "img");
  assert.equal(labelled.getAttribute("aria-label"), `Run "fast" <b>`);
  assert.equal(labelled.querySelector("b"), null);
});

test("2. an unknown or hostile key draws only the placeholder; nothing of the key reaches the markup", () => {
  for (const key of ["no-such-icon", `"><script>alert(1)</script>`, "constructor", "__proto__", null, 7]) {
    const html = renderIconSvg(key);
    const svg = parse(html).querySelector("svg");
    assert.ok(svg.classList.contains("om-icon-unknown"), String(key));
    assert.equal(svg.querySelectorAll("path").length, 1);
    assert.equal(parse(html).querySelector("script"), null);
    assert.equal(html.includes("alert"), false);
  }
});

test("3. a stored value draws only when it is icon:<key>; any other value draws nothing", () => {
  assert.equal(storedIconValue("run"), "icon:run");
  assert.ok(parse(renderStoredIconHtml("icon:run")).querySelector("svg:not(.om-icon-unknown)"));
  assert.ok(parse(renderStoredIconHtml("icon:gone")).querySelector("svg.om-icon-unknown"));
  for (const value of ["", null, undefined, "run", "https://example.test/x.svg", "/assets/icons/metric-default.svg", "javascript:alert(1)"]) {
    assert.equal(renderStoredIconHtml(value), "", String(value));
  }
  assert.equal(iconKeyOfStored("icon:run"), "run");
  assert.equal(iconKeyOfStored("icon:dumbbell"), "barbell");
  assert.equal(iconKeyOfStored("icon:gone"), null);
  assert.equal(iconKeyOfStored("run"), null);
});

test("4. the Builder's former glyph codes draw real icons; dumbbell is the barbell", () => {
  for (const key of ["target", "bolt", "calendar", "heart"]) assert.equal(iconByKey(key)?.key, key);
  assert.equal(iconByKey("dumbbell")?.key, "barbell");
  assert.equal(isLibraryKey("dumbbell"), false);
  assert.equal(isLibraryKey("barbell"), true);
});

test("5. the size is a whole number of pixels from 8 to 96, 24 otherwise; a class is escaped", () => {
  const size = (value) => parse(renderIconSvg("run", { size: value })).querySelector("svg").getAttribute("width");
  assert.equal(size(16), "16");
  assert.equal(size(52), "52");
  for (const bad of [0, 7, 97, 12.5, "16", `16" onload="x`]) assert.equal(size(bad), "24", String(bad));
  const svg = parse(renderIconSvg("run", { className: `a" onload="x` })).querySelector("svg");
  assert.equal(svg.getAttribute("onload"), null);
});

test("6. search: every word must start a word of the key, the search words or the category", () => {
  assert.equal(searchIcons().length, ICONS.length);
  assert.ok(searchIcons({ query: "run" }).some((icon) => icon.key === "run"));
  assert.ok(searchIcons({ query: "heart rate" }).some((icon) => icon.key === "heart-rate"));
  assert.ok(searchIcons({ query: "dumb" }).some((icon) => icon.key === "barbell"));
  assert.ok(searchIcons({ query: "recovery" }).every((icon) => icon.category === "recovery" || icon.words.some((w) => w.includes("recovery"))));
  assert.deepEqual(searchIcons({ query: "zzzz-nothing" }), []);
  const sport = searchIcons({ category: "sport" });
  assert.ok(sport.length > 5 && sport.every((icon) => icon.category === "sport"));
  assert.ok(searchIcons({ query: "ball", category: "sport" }).every((icon) => icon.category === "sport"));
});

test("7. a metric's icon in the older screens: a library icon for a key, the image for a URL, the fallback for none", () => {
  const keyed = parse(renderMetricIconHtml("icon:run", { className: "tl-metric-icon" }));
  assert.equal(keyed.querySelector("img"), null);
  assert.ok(keyed.querySelector("svg.tl-metric-icon"));
  const url = parse(renderMetricIconHtml(`/assets/icons/metric-default.svg" onerror="x`, { className: "tl-metric-icon" })).querySelector("img");
  assert.equal(url.getAttribute("src"), `/assets/icons/metric-default.svg" onerror="x`);
  assert.equal(url.getAttribute("onerror"), null);
  assert.equal(renderMetricIconHtml("", { fallback: "<span>F</span>" }), "<span>F</span>");
  assert.equal(renderMetricIconHtml(null, { fallback: "" }), "");
});

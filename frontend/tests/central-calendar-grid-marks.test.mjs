// H4 in the time grid (the owner's requirement, K5-2 contract 2.3): an event box of the week and day grids keeps the
// marks of what it holds (RPE, GPS, test), right after its time; every other card keeps them after its type's icon.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
const view = await import("../central-calendar-view.js");

const D = "2026-11-24";
const event = (overrides = {}) => ({
  key: `event:e1:${D}`, kind: "event", date: D, title: "Team training", startTime: "10:00", endTime: "11:30", teamIds: [], athleteIds: [],
  expects: ["rpe"], scheduleFold: { external: "folded", test: "folded" }, holdsImport: true, cancelled: false, canManage: true,
  eventKind: "training", eventTypeLabel: "Training", span: { from: D, to: D }, links: { eventId: "e1", activityIds: [] }, ...overrides,
});
const top = (html) => new JSDOM(`<body>${html}</body>`).window.document.querySelector(".cc-card-top");

test("1. a grid box draws the RPE, GPS and test marks after its title (time, title, marks); a list card after its type's icon", () => {
  const body = new JSDOM(`<body>${view.renderCentralCalendarCardHtml(event(), { teams: [], gridBox: true })}</body>`).window.document.querySelector(".cc-card-body");
  const order = [...body.children].map((el) => (el.getAttribute("class") || "").split(" ")[0]);
  assert.deepEqual(order.slice(0, 3), ["cc-card-top", "cc-card-title", "cc-card-marks"], `time line, title, marks: ${order.join(",")}`);
  assert.equal(body.querySelector(".cc-card-top .cc-card-marks"), null, "never in the time line");
  const marks = body.querySelector(".cc-card-marks");
  assert.deepEqual([...marks.querySelectorAll("svg")].map((svg) => [...svg.classList].find((c) => c.startsWith("cc-mark-"))), ["cc-mark-rpe", "cc-mark-gps", "cc-mark-test"]);
  assert.equal(marks.getAttribute("aria-label"), "Holds RPE, GPS data and a test");
  const card = top(view.renderCentralCalendarCardHtml(event(), { teams: [] }));
  const listOrder = [...card.children].map((el) => (el.getAttribute("class") || "").split(" ")[0]);
  assert.equal(listOrder[1], "cc-card-marks", `after the icon: ${listOrder.join(",")}`);
});

test("2. nothing held, or a cancelled event: no marks in the box", () => {
  const empty = event({ expects: [], scheduleFold: { external: null, test: null }, holdsImport: false });
  const bodyOf = (item) => new JSDOM(`<body>${view.renderCentralCalendarCardHtml(item, { teams: [], gridBox: true })}</body>`).window.document.querySelector(".cc-card-body");
  assert.equal(bodyOf(empty).querySelector(".cc-card-marks"), null);
  assert.equal(bodyOf(event({ cancelled: true })).querySelector(".cc-card-marks"), null);
});

test("3. the stylesheet shows the marks in a grid box; a one-line box drops its end time under 200 px and its marks under 140 px; any box drops them at 44 px", () => {
  const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /^\.cc-tg-box \.cc-card-marks \{\s*display: none;/m, "no unconditional hiding (a rule at the top level)");
  const block = (px) => (css.match(new RegExp(`@container \\(max-width: ${px}px\\) \\{([\\s\\S]*?)\\n\\}`)) || [])[1] || "";
  assert.doesNotMatch(block(60), /\.cc-tg-box \.cc-card-marks \{\s*display: none;/, "a tall narrow box keeps them");
  assert.match(block(200), /\.cc-tg-box\.is-short \.cc-card-when-end \{\s*display: none;/, "a one-line box under 200 px: the start only");
  assert.match(block(140), /\.cc-tg-box\.is-short \.cc-card-marks,\s*\.cc-tg-box\.is-two-line \.cc-card-marks \{\s*display: none;/, "a one- or two-line box under 140 px keeps its time and title");
  assert.match(css, /\.cc-tg-box:not\(\.is-short\) \.cc-card-body \{\s*grid-template-columns: minmax\(0, 1fr\) auto;/, "a box of several lines: the marks at the end of the title's line");
  assert.match(block(60), /\.cc-tg-box:not\(\.is-short\) \.cc-card-body \{\s*grid-template-columns: minmax\(0, 1fr\);/, "a narrow box: the marks on a line of their own");
  assert.match(block(110), /\.cc-tg-box:not\(\.is-tall\) \.cc-card-marks \{\s*display: none;/, "61 to 110 px: only a tall box keeps them");
  assert.match(block(44), /\.cc-tg-box \.cc-card-marks,\s*\.cc-tg-box:not\(\.is-short\):not\(\.is-two-line\) \.cc-card-marks \{\s*display: none;/, "dropped at 44 px, whatever the 60 px block shows");
});

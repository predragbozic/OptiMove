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

test("1. a grid box draws the RPE, GPS and test marks right after its time; a list card after its type's icon", () => {
  const box = top(view.renderCentralCalendarCardHtml(event(), { teams: [], gridBox: true }));
  const order = [...box.children].map((el) => (el.getAttribute("class") || "").split(" ")[0]);
  assert.ok(order.indexOf("cc-card-when") < order.indexOf("cc-card-marks"), `time first: ${order.join(",")}`);
  const marks = box.querySelector(".cc-card-marks");
  assert.deepEqual([...marks.querySelectorAll("svg")].map((svg) => [...svg.classList].find((c) => c.startsWith("cc-mark-"))), ["cc-mark-rpe", "cc-mark-gps", "cc-mark-test"]);
  assert.equal(marks.getAttribute("aria-label"), "Holds RPE, GPS data and a test");
  const card = top(view.renderCentralCalendarCardHtml(event(), { teams: [] }));
  const listOrder = [...card.children].map((el) => (el.getAttribute("class") || "").split(" ")[0]);
  assert.equal(listOrder[1], "cc-card-marks", `after the icon: ${listOrder.join(",")}`);
});

test("2. nothing held, or a cancelled event: no marks in the box", () => {
  const empty = event({ expects: [], scheduleFold: { external: null, test: null }, holdsImport: false });
  assert.equal(top(view.renderCentralCalendarCardHtml(empty, { teams: [], gridBox: true })).querySelector(".cc-card-marks"), null);
  assert.equal(top(view.renderCentralCalendarCardHtml(event({ cancelled: true }), { teams: [], gridBox: true })).querySelector(".cc-card-marks"), null);
});

test("3. the stylesheet shows the marks in a grid box, on their own line in a narrow box, and drops them only at 44 px", () => {
  const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /^\.cc-tg-box \.cc-card-marks \{\s*display: none;/m, "no unconditional hiding (a rule at the top level)");
  const block = (px) => (css.match(new RegExp(`@container \\(max-width: ${px}px\\) \\{([\\s\\S]*?)\\n\\}`)) || [])[1] || "";
  assert.match(block(60), /\.cc-tg-box \.cc-card-marks \{\s*flex-basis: 100%;/, "a narrow box: their own line");
  assert.doesNotMatch(block(60), /\.cc-tg-box \.cc-card-marks \{\s*display: none;/, "not dropped at 60 px");
  assert.match(block(60), /\.cc-tg-box\.is-short \.cc-card-marks \{\s*display: none;/, "a narrow one-line box keeps its time and title");
  assert.match(block(44), /\.cc-tg-box \.cc-card-marks \{\s*display: none;/, "dropped at 44 px");
});

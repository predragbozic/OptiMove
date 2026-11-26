// K7 (docs/ai/central-calendar-k7-timegrid-contract.md, section 6): the time grid laid out like a professional
// calendar. The pure layout function (cases 1-12), the drawn grid (DOM order, labels, "+N more", the band, the Day
// time grid), and the layouts K7 must leave byte for byte as they were (a snapshot made on main before K7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const tg = await import("../central-calendar-timegrid.js");
const view = await import("../central-calendar-view.js");
const { emptyCentralCalendarState, state } = await import("../state.js");
const { handleCentralCalendarAction, openCentralCalendarAt, restoreCentralCalendarPlace } = await import("../central-calendar-actions.js");
const { K7_TODAY, K7_UNCHANGED_CASES, k7CaseState } = await import("./support/central-calendar-k7-scenario.mjs");

const m = (time) => tg.centralCalendarMinutesOf(time);
const entry = (name, start, end = null, minor = false) => ({ item: { name }, start: m(start), end: end ? m(end) : null, minor });
const layout = (entries, options = {}) => tg.centralCalendarTimeLayout(entries, { startHour: 6, maxColumns: 3, ...options });
const byName = (result) => Object.fromEntries(result.placed.map((box) => [box.item.name, box]));

// --- The layout function ---------------------------------------------------------------------------------------------

test("1. minute position (09:30 at 06:00 -> 210) and the height from the end", () => {
  const { placed } = layout([entry("a", "09:30", "11:00")]);
  assert.deepEqual([placed[0].top, placed[0].height, placed[0].column, placed[0].columns, placed[0].span, placed[0].openEnd], [210, 90, 0, 1, 1, false]);
});

test("2. an item without an end: 30 minutes, the open-end flag", () => {
  const { placed } = layout([entry("a", "10:00")]);
  assert.deepEqual([placed[0].height, placed[0].openEnd], [30, true]);
});

test("3. a short event (10:00-10:10) is drawn 30 minutes; two short events 10 minutes apart take two columns", () => {
  const single = layout([entry("a", "10:00", "10:10")]).placed[0];
  assert.deepEqual([single.height, single.openEnd], [30, false], "drawn 30 minutes, but it has an end");
  const two = byName(layout([entry("a", "10:00", "10:10"), entry("b", "10:10", "10:20")]));
  assert.deepEqual([two.a.column, two.b.column, two.a.columns], [0, 1, 2], "overlap on the drawn extent: side by side, never drawn over");
});

test("4. touching is not overlapping: 10-11 and 11-12 are full width", () => {
  const boxes = byName(layout([entry("a", "10:00", "11:00"), entry("b", "11:00", "12:00")]));
  assert.deepEqual([boxes.a.columns, boxes.b.columns, boxes.a.column, boxes.b.column], [1, 1, 0, 0]);
  // An item touching a two-column cluster starts a new cluster: full width, not half.
  const after = byName(layout([entry("x", "10:00", "11:00"), entry("y", "10:00", "11:00"), entry("z", "11:00", "12:00")]));
  assert.deepEqual([after.x.columns, after.z.columns, after.z.span], [2, 1, 1], "z is alone in its own cluster");
});

test("5. the owner's pair (00:00-01:00, 00:30-01:29): side by side, and the grid starts at 00:00", () => {
  const pair = [entry("a", "00:00", "01:00"), entry("b", "00:30", "01:29")];
  const hours = tg.centralCalendarGridHours(pair, { startHour: 6, endHour: 22 });
  assert.deepEqual(hours, { startHour: 0, endHour: 22 });
  const boxes = byName(tg.centralCalendarTimeLayout(pair, { startHour: hours.startHour, maxColumns: 3 }));
  assert.deepEqual([boxes.a.top, boxes.a.column, boxes.b.top, boxes.b.column, boxes.a.columns], [0, 0, 30, 1, 2]);
  assert.deepEqual([boxes.a.height, boxes.b.height], [60, 59], "heights proportional to the times");
});

test("6. a transitive cluster (A-B and B-C overlap, A-C do not): one cluster of two columns, C reuses A's column", () => {
  const boxes = byName(layout([entry("A", "10:00", "11:00"), entry("B", "10:30", "12:00"), entry("C", "11:00", "12:30")]));
  assert.deepEqual([boxes.A.column, boxes.B.column, boxes.C.column], [0, 1, 0]);
  assert.deepEqual([boxes.A.columns, boxes.B.columns, boxes.C.columns], [2, 2, 2], "one cluster");
});

test("7. width to the right: one long item beside two that follow each other spreads only where free", () => {
  // L 10-12 (column 0); S1 10-11 (column 1); S2 11-12 (column 1); T 10:30-11:30 (column 2).
  const boxes = byName(layout([entry("L", "10:00", "12:00"), entry("S1", "10:00", "11:00"), entry("T", "10:30", "11:30"), entry("S2", "11:00", "12:00")]));
  assert.deepEqual([boxes.L.column, boxes.S1.column, boxes.T.column, boxes.S2.column], [0, 1, 2, 1]);
  assert.equal(boxes.T.span, 1, "the last column cannot spread");
  // Without T, S1 and S2 are column 1 of 2, and nothing spreads over another.
  const two = byName(layout([entry("L", "10:00", "12:00"), entry("S1", "10:00", "11:00"), entry("S2", "11:00", "12:00")]));
  assert.deepEqual([two.L.span, two.S1.span, two.S2.span], [1, 1, 1]);
  // A short item in column 0 under a long item in column 1 spreads right only where column 2 is free for its extent.
  const spread = byName(layout([entry("A", "10:00", "13:00"), entry("B", "10:00", "11:00"), entry("C", "10:30", "11:00"), entry("D", "11:30", "12:00")]));
  assert.deepEqual([spread.A.column, spread.B.column, spread.C.column, spread.D.column], [0, 1, 2, 1]);
  assert.equal(spread.D.span, 2, "D (11:30-12:00) has column 2 free for its whole extent: it spreads over it");
  assert.equal(spread.B.span, 1, "B shares its time with C in column 2: it does not spread");
});

test("8. too many at once: the week keeps 2 columns and '+N more'; the Day view 6, then 5 and '+N'", () => {
  const four = ["a", "b", "c", "d"].map((name) => entry(name, "10:00", "11:00"));
  const week = layout(four);
  assert.deepEqual(week.placed.map((box) => [box.item.name, box.column, box.columns]), [["a", 0, 3], ["b", 1, 3]]);
  assert.equal(week.more.length, 1);
  assert.deepEqual([week.more[0].items.map((item) => item.name), week.more[0].top, week.more[0].height, week.more[0].column, week.more[0].columns], [["c", "d"], 240, 60, 2, 3]);
  const six = ["a", "b", "c", "d", "e", "f"].map((name) => entry(name, "10:00", "11:00"));
  assert.deepEqual([layout(six, { maxColumns: 6 }).placed.length, layout(six, { maxColumns: 6 }).more.length], [6, 0], "six in the Day view: no +N");
  const seven = layout([...six, entry("g", "10:00", "11:00")], { maxColumns: 6 });
  assert.deepEqual([seven.placed.length, seven.more[0].items.length, seven.more[0].column], [5, 2, 5], "seven: five and +2");
  // The "+N" block runs from the earliest start to the latest drawn end of what did not fit.
  const spread = layout([entry("a", "10:00", "12:00"), entry("b", "10:00", "11:00"), entry("c", "10:15", "10:45"), entry("d", "10:30", "11:45")]);
  assert.deepEqual([spread.more[0].top, spread.more[0].height], [255, 90], "10:15 to 11:45");
});

test("9. chips move into '+N' before cards", () => {
  const boxes = layout([entry("chip1", "10:00", null, true), entry("card1", "10:00", "11:00"), entry("chip2", "10:00", null, true), entry("card2", "10:05", "11:00")]);
  assert.deepEqual(boxes.placed.map((box) => box.item.name).sort(), ["card1", "card2"], "the cards keep their columns");
  assert.deepEqual(boxes.more[0].items.map((item) => item.name).sort(), ["chip1", "chip2"]);
  // Not full: chips are laid out like any item.
  const fits = layout([entry("chip", "10:00", null, true), entry("card", "10:00", "11:00")]);
  assert.deepEqual([fits.placed.length, fits.more.length], [2, 0]);
});

test("10. the grid's hours widen to the latest drawn end, never past 24:00", () => {
  assert.deepEqual(tg.centralCalendarGridHours([entry("a", "21:10", "22:20")], { startHour: 6, endHour: 22 }), { startHour: 6, endHour: 23 });
  assert.deepEqual(tg.centralCalendarGridHours([entry("a", "23:50")], { startHour: 6, endHour: 22 }), { startHour: 6, endHour: 24 }, "a nominal 30 minutes at 23:50 ends at midnight");
  assert.deepEqual(tg.centralCalendarGridHours([entry("a", "07:00", "08:00")], { startHour: 6, endHour: 22 }), { startHour: 6, endHour: 22 }, "inside the default: unchanged");
  const late = layout([entry("a", "23:50")], { startHour: 6 }).placed[0];
  assert.equal(late.top + late.height, (24 - 6) * 60, "the drawn end stops at midnight");
});

test("12. stable order: equal starts and lengths keep the server's order; a longer item comes first", () => {
  const same = layout([entry("x", "10:00", "11:00"), entry("y", "10:00", "11:00")]);
  assert.deepEqual(same.placed.map((box) => [box.item.name, box.column]), [["x", 0], ["y", 1]]);
  const longer = layout([entry("short", "10:00", "10:45"), entry("long", "10:00", "12:00")]);
  assert.deepEqual(longer.placed.map((box) => [box.item.name, box.column]), [["long", 0], ["short", 1]], "the longer first: the earliest and the longest stay visible");
});

// --- The drawn grid (DOM) ---------------------------------------------------------------------------------------------

const k7State = (c) => k7CaseState(emptyCentralCalendarState, c);
const draw = (cal, layoutName = "wide") => new JSDOM(`<!doctype html><body>${view.renderCentralCalendarHtml(cal, { today: K7_TODAY, layout: layoutName })}</body>`).window.document;
const styleOf = (el) => Object.fromEntries([...el.getAttribute("style").matchAll(/--cc-tg-([a-z]+):([^;]+)/g)].map(([, k, v]) => [k, Number(v)]));

test("11. a multi-day event goes to the band on each of its days with 'Day N of 3', never timed; its times read from / until", () => {
  const doc = draw(k7State({ view: "week", mode: "grid" }));
  const bandKeys = [...doc.querySelectorAll(".cc-timegrid-untimed .cc-card")].map((card) => card.dataset.key);
  for (const key of ["event:camp:2", "event:camp:3", "event:camp:4"]) assert.ok(bandKeys.includes(key), `${key} in the band`);
  assert.equal(doc.querySelectorAll('.cc-tg-col [data-key^="event:camp:"]').length, 0, "never in the timed part");
  const card = (key) => doc.querySelector(`.cc-timegrid-untimed [data-key="${key}"]`);
  assert.equal(card("event:camp:2").querySelector(".cc-card-when").textContent, "from 10:00");
  assert.equal(card("event:camp:3").querySelector(".cc-card-when"), null, "a middle day: no time");
  assert.equal(card("event:camp:4").querySelector(".cc-card-when").textContent, "until 16:00");
  assert.match(card("event:camp:3").getAttribute("aria-label"), /Day 2 of 3/);
});

test("D1. reading order is day by day; each day column is a list labelled with its date and count", () => {
  const doc = draw(k7State({ view: "week", mode: "grid" }));
  const cols = [...doc.querySelectorAll(".cc-tg-col")];
  assert.equal(cols.length, 7);
  assert.ok(cols.every((col) => col.getAttribute("role") === "list"));
  assert.equal(cols[0].getAttribute("aria-label"), `${view.centralCalendarLongDate("2026-10-12")}, 2 items`);
  const order = [...doc.querySelectorAll(".cc-tg-col [data-action]")].map((el) => el.dataset.key || `more:${el.dataset.date}`);
  assert.deepEqual(order, ["event:e1:a", "event:e2:a", "event:c1:a", "event:c2:a", "more:2026-10-13", "planned:p2", "test:t1:d", "activity:a1"], "day by day; a day's '+N more' after its items");
  assert.ok(cols.every((col) => [...col.children].every((child) => child.getAttribute("role") === "listitem")));
  assert.equal(doc.querySelector(".cc-tg-gutter").getAttribute("aria-hidden"), "true");
});

test("D2. the owner's pair is side by side at its minutes; the grid opens at 00:00; an open end is marked", () => {
  const doc = draw(k7State({ view: "week", mode: "grid" }));
  assert.equal(doc.querySelector(".cc-tg-hour").textContent, "00:00");
  const box = (key) => doc.querySelector(`.cc-tg-col [data-key="${key}"]`).closest(".cc-tg-box");
  assert.deepEqual(styleOf(box("event:e1:a")), { top: 0, height: 60, left: 0, width: 0.5 });
  assert.deepEqual(styleOf(box("event:e2:a")), { top: 30, height: 59, left: 0.5, width: 0.5 });
  assert.ok(box("planned:p2").classList.contains("is-open-end"), "no end time: an open lower edge");
  assert.ok(!box("event:e1:a").classList.contains("is-open-end"));
  assert.ok(box("event:e1:a").classList.contains("is-narrow"), "a shared cluster");
  // The team colour stays on a narrow card; its start comes first and its end is a part of its own, which hides only
  // when the box itself is narrow (a container query, measured in the e2e); the whole in its tooltip and label.
  const narrow = doc.querySelector('.cc-tg-col [data-key="event:e2:a"]');
  assert.match(narrow.getAttribute("style"), /--cc-team-color/);
  assert.equal(narrow.querySelector(".cc-card-when").firstChild.textContent, "00:30");
  assert.equal(narrow.querySelector(".cc-card-when-end").textContent, "–01:29");
  assert.equal(narrow.getAttribute("title"), "00:30–01:29 Second group");
  assert.match(narrow.getAttribute("aria-label"), /00:30–01:29/);
  // No end: the start alone, nothing to hide; a box under 45 minutes puts time and title on one line.
  const open = doc.querySelector('.cc-tg-col [data-key="planned:p2"]');
  assert.equal(open.querySelector(".cc-card-when").textContent, "17:30");
  assert.equal(open.querySelector(".cc-card-when-end"), null);
  assert.ok(open.closest(".cc-tg-box").classList.contains("is-short"));
  assert.ok(!box("event:e1:a").classList.contains("is-short"), "an hour is not short");
  // "+N more": the number, then a word that hides in a narrow column.
  assert.equal(doc.querySelector(".cc-tg-col .cc-tg-more .cc-tg-more-word").textContent, " more");
});

test("D3. '+N more' opens the day as the Day view's list; its label names the count, the day and the time", async () => {
  const doc = draw(k7State({ view: "week", mode: "grid" }));
  const more = doc.querySelector('.cc-tg-col .cc-tg-more[data-date="2026-10-13"]');
  assert.equal(more.textContent, "+2 more");
  assert.equal(more.getAttribute("aria-label"), `2 more items, ${view.centralCalendarLongDate("2026-10-13")}, from 10:00: open the day`);
  assert.deepEqual([more.dataset.action, more.dataset.dayList], ["central-calendar-open-day", "1"]);
  // The action: the Day view of that day, as its list, even with the switch on Time grid.
  state.centralCalendar = k7State({ view: "week", mode: "grid" });
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: "notFound" }) });
  await handleCentralCalendarAction(fakeAction({ action: "central-calendar-open-day", date: "2026-10-13", dayList: "1" }), { render: () => {} });
  const cal = state.centralCalendar;
  assert.deepEqual([cal.view, cal.anchor, cal.dayList, view.centralCalendarDayGridShown(cal, "wide")], ["day", "2026-10-13", true, false]);
  // The day head's own click opens the Day view as the switch says (the Day time grid).
  await handleCentralCalendarAction(fakeAction({ action: "central-calendar-open-day", date: "2026-10-13" }), { render: () => {} });
  assert.deepEqual([cal.dayList, view.centralCalendarDayGridShown(cal, "wide")], [false, true]);
  // Any next view, day or mode change ends the list.
  cal.dayList = true;
  await handleCentralCalendarAction(fakeAction({ action: "central-calendar-next" }), { render: () => {} });
  assert.equal(cal.dayList, false);
  // The Day button on the Day list ends the list and draws at once (code review).
  cal.dayList = true;
  let drawn = 0;
  await handleCentralCalendarAction(fakeAction({ action: "central-calendar-view", view: "day" }), { render: () => { drawn += 1; } });
  assert.deepEqual([cal.dayList, drawn > 0], [false, true]);
  // Back and "Open in calendar" show the stored Day layout, never a list opened elsewhere.
  cal.dayList = true;
  restoreCentralCalendarPlace({ view: "day", anchor: "2026-10-13", selectedDate: "2026-10-13" });
  assert.equal(view.centralCalendarDayGridShown(cal, "wide"), true);
  cal.dayList = true;
  openCentralCalendarAt({ date: "2026-10-14" });
  assert.equal(cal.dayList, false);
});

test("D4. the band: multi-day events, cards without a time, then chips; more than 3 shows 3 and '+N more'", () => {
  const cal = k7State({ view: "week", mode: "grid" });
  const wed = cal.data.days.find((d) => d.date === "2026-10-14");
  // Wednesday: the camp's day, the slot-only training and an RPE chip without a time, plus one more card without one.
  wed.items.push({ ...wed.items[0], key: "external:x9:d", kind: "external", title: "Late RPE", startTime: null, endTime: null, span: { from: "2026-10-14", to: "2026-10-14" } });
  wed.items.push({ ...wed.items[0], key: "planned:p9", kind: "planned", title: "Spare", startTime: null, endTime: null, slot: null, span: { from: "2026-10-14", to: "2026-10-14" } });
  const doc = draw(cal);
  const cell = [...doc.querySelectorAll(".cc-timegrid-untimed")][2];
  const keys = [...cell.querySelectorAll("[data-key]")].map((el) => el.dataset.key);
  assert.deepEqual(keys, ["event:camp:2", "planned:p1", "planned:p9"], "multi-day first, then cards without a time; three shown");
  const more = cell.querySelector(".cc-tg-more");
  assert.equal(more.textContent, "+1 more");
  assert.equal(more.dataset.date, "2026-10-14");
});

test("D4b. K5-4's GPS mark is the band's last entry and counts toward its 3", async () => {
  const gps = await import("../central-calendar-gps-review.js");
  const cal = k7State({ view: "week", mode: "grid" });
  // Thursday gets one more card without a time: the camp's day, that card and the RPE chip fill its 3.
  const thu = cal.data.days.find((d) => d.date === "2026-10-15");
  thu.items.push({ ...thu.items[0], key: "planned:p8", kind: "planned", title: "Spare", startTime: null, endTime: null, slot: null, span: { from: "2026-10-15", to: "2026-10-15" } });
  const waiting = (day) => ({ day, chips: ["ready"], counts: { needs: 0, ready: 2, imported: 0, out: 0 } });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ from: cal.data.from, to: cal.data.to, days: [waiting("2026-10-14"), waiting("2026-10-15")], truncated: false }) });
  state.currentUser = { id: "coach-1" };
  state.centralCalendar = cal;
  gps.clearGpsReview();
  try {
    await gps.ensureGpsReview(cal, () => {});
    const cells = [...draw(cal).querySelectorAll(".cc-timegrid-untimed")];
    const entries = (cell) => [...cell.querySelectorAll("[data-key], .cc-daymark, .cc-tg-more")].map((el) => el.dataset.key || (el.classList.contains("cc-daymark") ? "mark" : el.textContent));
    // Wednesday: the camp's day, the slot-only training, then the mark, last.
    assert.deepEqual(entries(cells[2]), ["event:camp:2", "planned:p1", "mark"]);
    // Thursday: three entries before it, so the mark is the fourth and goes into "+1 more".
    assert.deepEqual(entries(cells[3]), ["event:camp:3", "planned:p8", "external:x1:d", "+1 more"]);
  } finally {
    gps.clearGpsReview();
  }
});

test("D5. the Day time grid only on wide with the switch on Time grid; six columns before '+N'", () => {
  const cal = k7State({ view: "day", mode: "grid" });
  cal.anchor = "2026-10-13";
  cal.selectedDate = "2026-10-13";
  cal.data = { ...cal.data, from: "2026-10-13", to: "2026-10-13", days: k7State({ view: "week", mode: "grid" }).data.days.filter((d) => d.date === "2026-10-13") };
  const doc = draw(cal);
  assert.ok(doc.querySelector(".cc-timegrid.cc-timegrid-day"), "a Day time grid");
  assert.equal(doc.querySelectorAll(".cc-tg-col").length, 1);
  assert.equal(doc.querySelectorAll(".cc-tg-col .cc-tg-more").length, 0, "four at once fit in the Day view's six columns");
  assert.equal(doc.querySelector('.cc-mode-switch').getAttribute("aria-label"), "Day layout");
  assert.equal(doc.querySelector('.cc-mode-switch [data-mode="grid"]').getAttribute("aria-pressed"), "true");
  cal.dayList = true;
  const listed = draw(cal);
  assert.equal(listed.querySelector(".cc-timegrid"), null, "'+N more' asked for the list");
  assert.equal(listed.querySelector('.cc-mode-switch [data-mode="list"]').getAttribute("aria-pressed"), "true", "and the switch says so");
  cal.dayList = false;
  cal.weekMode = "list";
  assert.equal(draw(cal).querySelector(".cc-timegrid"), null, "the switch on List: the list");
  cal.weekMode = "grid";
  assert.equal(draw(cal, "medium").querySelector(".cc-timegrid"), null, "medium: the list");
  assert.ok(draw(cal, "phone").querySelector(".cc-timegrid-day"), "phone: the time grid");
});

test("phone offers List and Time grid and renders all seven days", () => {
  const cal = k7State({ view: "week", mode: "grid" });
  const document = draw(cal, "phone");
  assert.ok(document.querySelector('.cc-mode-switch [data-mode="list"]'));
  assert.equal(document.querySelectorAll(".cc-timegrid-head").length, 7);
  cal.weekMode = "list";
  assert.equal(draw(cal, "phone").querySelector(".cc-timegrid"), null);
});

test("U. phone Month and unchanged larger layouts retain the K7 markup", () => {
  const before = JSON.parse(readFileSync(new URL("./support/central-calendar-k7-unchanged.json", import.meta.url), "utf8"));
  assert.equal(Object.keys(before).length, K7_UNCHANGED_CASES.length);
  for (const c of K7_UNCHANGED_CASES) {
    if (c.layout === "phone" && c.view !== "month") continue;
    const html = view.renderCentralCalendarHtml(k7State(c), { today: K7_TODAY, layout: c.layout });
    assert.equal(html, before[`${c.layout}/${c.view}/${c.mode}`], `${c.layout}/${c.view}/${c.mode}`);
  }
});

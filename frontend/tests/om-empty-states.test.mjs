// Design: empty states with one next step (Exercises, Tests Today, the calendar's day list).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
const { renderExerciseLibraryHtml } = await import("../exercise-library.js");
const { renderCoachTodayWeeklyHtml } = await import("../tests-view.js");
const { emptyExerciseFilters, emptyExerciseOptions, state } = await import("../state.js");

const library = (search = {}) => renderExerciseLibraryHtml({
  exercises: [], itemIds: [], markedExerciseIds: new Set(),
  search: { term: "", view: "details", filters: emptyExerciseFilters(), options: emptyExerciseOptions(), lockedPreviews: [], ...search },
  tagEditor: { open: false },
});

test("an empty exercise library offers Add exercise; a search with no match says how to widen it", () => {
  const empty = library();
  assert.match(empty, /class="om-empty exercise-library-empty" role="status"/);
  assert.match(empty, /Your exercise library is empty/);
  assert.match(empty, /class="om-btn om-btn--primary" type="button" data-action="exercise-add-open">\+ Add exercise</);
  const searched = library({ term: "squat" });
  assert.match(searched, /No exercises match/);
  assert.doesNotMatch(searched, /om-btn--primary/);
  assert.match(searched, /Try other words/);
  const filterOnly = library({ filters: { ...emptyExerciseFilters(), favorite: true } });
  assert.match(filterOnly, /No exercises match/);
  assert.doesNotMatch(filterOnly, /Try other words/);
  assert.match(filterOnly, /Remove a filter or the block above/);
  // A result with only locked previews is not "empty".
  assert.doesNotMatch(library({ term: "x", lockedPreviews: [{ name: "A", blockName: "B" }] }), /exercise-library-empty/);
});

test("the coach's empty Tests day offers Open Schedule", () => {
  const date = "2026-11-10";
  state.tests.weeklyGroupDetail = null;
  state.tests.weeklyGroupDetailLoading = false;
  state.tests.weekly.today = { loading: false, error: "", selectedDate: date, data: { weekStart: date, weekEnd: date, days: [{ date, sessions: [] }] } };
  const html = renderCoachTodayWeeklyHtml();
  assert.match(html, /class="om-empty tests-empty" role="status"><p class="om-empty__text">Nothing scheduled for this day\.<\/p>/);
  assert.match(html, /data-action="tests-section" data-section="schedule">Open Schedule</);
});

test("the calendar's empty day offers Clear filters only when filters hide its items", () => {
  const view = readFileSync(new URL("../central-calendar-view.js", import.meta.url), "utf8");
  const fn = view.slice(view.indexOf("function renderSelectedDayListHtml("), view.indexOf("\n}\n", view.indexOf("function renderSelectedDayListHtml(")));
  assert.match(fn, /const emptyAction = filtered \? `<button type="button" class="om-btn cc-clear-filters" data-action="central-calendar-clear-filters">Clear filters<\/button>` : "";/);
  assert.match(view, /if \(!items\.length && emptyAction\) return `<div class="om-empty cc-day-empty" role="status">/);
});

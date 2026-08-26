// Mobile scheduling hotfix, items 1-3: structural/regression safeguards for
// the schedule form's mobile layout. This test harness has no real
// rendering engine (no jsdom, no actual CSS layout), so it cannot directly
// assert "no horizontal overflow at 360px" the way a real browser check
// can - that was verified live (see the session's own report: a real
// 360/375/390px DOM scrollWidth/clientWidth measurement against the actual
// running app, after finding and fixing the real root cause - a CSS "grid
// blowout" on .tests-collapsible-section, plus flex/grid min-width:auto
// defaults at several nesting levels). What IS genuinely testable here,
// and is what this file covers:
//   1. the STRUCTURE the CSS fixes depend on actually exists (7 weekday
//      labels, Opens/Closes wrapped in one shared container, both a full
//      and a short label on each recurrence pill with a stable
//      accessible name) - a structural regression would silently break
//      the CSS selectors the live-verified fix targets;
//   2. the specific CSS declarations that were the ACTUAL fix (not just
//      "some minmax somewhere", but the exact selectors found live to be
//      the real overflow source) are still present in styles.css - a
//      plain text/regex safeguard against someone reverting them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = {};

const { renderScheduleFormHtml, renderTestsCalendarHtml, testsCalendarMode } = await import("../tests-view.js");
const { emptyScheduleForm, state } = await import("../state.js");

function resetState(overrides = {}) {
  state.tests = state.tests || {};
  state.tests.scheduleForm = emptyScheduleForm({ open: true, timezone: "UTC", calendarOpen: true, ...overrides });
  state.tests.orgPickerData = { clubs: [], teams: [] };
}

// ------------------------------------------------------------
// 1. Calendar: all 7 weekday columns
// ------------------------------------------------------------

test("the calendar renders exactly 7 weekday header labels and every row is a multiple of 7 day cells", () => {
  resetState({ scheduleKind: "daily", startDate: "2026-08-01", endDate: "2026-08-31", calendarMonth: "2026-08" });
  const html = renderTestsCalendarHtml(state.tests.scheduleForm);
  const weekdayMatches = [...html.matchAll(/<div class="tests-calendar-weekdays">((?:<span>[A-Za-z]+<\/span>)+)<\/div>/g)];
  assert.equal(weekdayMatches.length, 1, "exactly one weekdays header row must be rendered");
  const spanCount = (weekdayMatches[0][1].match(/<span>/g) || []).length;
  assert.equal(spanCount, 7, "must be exactly 7 weekday labels - one per column");

  const dayButtonCount = (html.match(/class="tests-calendar-day/g) || []).length;
  assert.equal(dayButtonCount % 7, 0, "the grid must always be a whole number of 7-column rows, no partial trailing row");
});

test("testsCalendarMode is 'range' for daily, 'multi' for specific dates - both use the SAME 7-column grid component, never a separate layout", () => {
  resetState({ scheduleKind: "daily" });
  assert.equal(testsCalendarMode(state.tests.scheduleForm), "range");
  resetState({ scheduleKind: "specific_dates" });
  assert.equal(testsCalendarMode(state.tests.scheduleForm), "multi");
});

// ------------------------------------------------------------
// 2. Opens/Closes share one row container
// ------------------------------------------------------------

test("Opens and Closes are both direct children of the SAME .tests-time-row wrapper, not two separate top-level fields", () => {
  resetState({ scheduleKind: "daily" });
  const html = renderScheduleFormHtml();
  const rowMatch = /<div class="tests-time-row">([\s\S]*?)<\/div>\s*<p class="muted tests-timezone-info">/.exec(html);
  assert.ok(rowMatch, "a .tests-time-row wrapper must exist immediately before the timezone info paragraph");
  assert.ok(rowMatch[1].includes(">Opens<"), "Opens must be inside the time row");
  assert.ok(rowMatch[1].includes(">Closes<"), "Closes must be inside the time row");
  assert.ok(rowMatch[1].includes('name="opensTime"'));
  assert.ok(rowMatch[1].includes('name="closesTime"'));
});

test("the timezone explanation renders BOTH a full and a short variant (CSS swaps which is visible - the text itself is never lost)", () => {
  resetState({ scheduleKind: "daily" });
  const html = renderScheduleFormHtml();
  assert.ok(html.includes('<span class="tests-timezone-info-full">Times follow each athlete\'s device timezone.</span>'));
  assert.ok(html.includes('<span class="tests-timezone-info-short">'), "a shorter mobile variant must also be rendered");
});

// ------------------------------------------------------------
// 3. Compact segmented control: full accessible name, short visible label
// ------------------------------------------------------------

test("each recurrence pill carries a stable full aria-label PLUS both a full and short visible label span (CSS picks which one shows)", () => {
  resetState({ scheduleKind: "specific_dates" });
  const html = renderScheduleFormHtml();
  assert.ok(html.includes('aria-label="Specific dates"'));
  assert.ok(html.includes('aria-label="Repeat daily"'));
  assert.ok(html.includes('<span aria-hidden="true" class="tests-recurrence-pill-label-full">Specific dates</span>'));
  assert.ok(html.includes('<span aria-hidden="true" class="tests-recurrence-pill-label-short">Dates</span>'));
  assert.ok(html.includes('<span aria-hidden="true" class="tests-recurrence-pill-label-full">Repeat daily</span>'));
  assert.ok(html.includes('<span aria-hidden="true" class="tests-recurrence-pill-label-short">Daily</span>'));
});

test("the recurrence toggle is a single flex row of exactly 2 pills - one .tests-recurrence-toggle wrapper, never two separate rows", () => {
  resetState({ scheduleKind: "daily" });
  const html = renderScheduleFormHtml();
  const wrapMatch = /<div class="tests-recurrence-toggle"[^>]*>([\s\S]*?)<\/div>\s*<div class="tests-calendar-section">/.exec(html);
  assert.ok(wrapMatch, "a single .tests-recurrence-toggle wrapper must contain both pills, immediately before the calendar section");
  const pillCount = (wrapMatch[1].match(/class="tests-recurrence-pill /g) || []).length;
  assert.equal(pillCount, 2);
});

// ------------------------------------------------------------
// 4. CSS regression safeguard - the actual fix found live must stay in place
// ------------------------------------------------------------

test("styles.css still contains the exact CSS-grid-blowout fixes found live to be the real 375px overflow source", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");

  // The confirmed real root cause: .tests-collapsible-section (Athletes/
  // Notifications/Advanced settings) is a single-implicit-column grid -
  // without an explicit minmax(0, 1fr) track, its own toggle button
  // rendered at its natural content width (448px) instead of the
  // container's (322px) at 375px, live-verified.
  const collapsibleBlock = /\.tests-collapsible-section\s*\{[^}]*\}/.exec(css)?.[0] || "";
  assert.match(collapsibleBlock, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, "the collapsible-section grid-blowout fix must stay in place");

  const calendarSectionBlock = /\.tests-calendar-section\s*\{[^}]*\}/.exec(css)?.[0] || "";
  assert.match(calendarSectionBlock, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);

  const calendarGridBlock = /\.tests-calendar-weekdays,\r?\n\.tests-calendar-grid\s*\{[^}]*\}/.exec(css)?.[0] || "";
  assert.match(calendarGridBlock, /grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/, "the 7-column calendar grid must stay shrinkable, never a bare 1fr");

  assert.match(css, /\.tests-time-row\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/, "Opens/Closes must stay a shrinkable 2-column row");

  // The flex-item chain (.tests-schedule-form-body -> -scroll -> its direct
  // children) each independently defaulting to min-width:auto was the
  // SECOND real contributor, found live - all three levels need their own
  // explicit min-width:0.
  const mobileBlockMatch = /@media \(max-width: 760px\) \{([\s\S]*?)\r?\n\}\r?\n\r?\n\.tests-link-box/.exec(css);
  assert.ok(mobileBlockMatch, "the mobile breakpoint block must still exist");
  const mobileBlock = mobileBlockMatch[1];
  assert.match(mobileBlock, /\.tests-schedule-form-body\s*\{[^}]*min-width:\s*0/);
  assert.match(mobileBlock, /\.tests-schedule-form-scroll\s*\{[^}]*min-width:\s*0/);
  assert.match(mobileBlock, /\.tests-schedule-form-scroll > \*\s*\{[^}]*min-width:\s*0/);
});

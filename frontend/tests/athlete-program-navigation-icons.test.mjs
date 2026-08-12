import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ui/athlete-program-navigation-icons: athlete-view.js's own import chain
// (organization-view.js -> navigation.js -> dom.js) touches `document` at
// module scope, so - like app.js/messages.js elsewhere in this suite - it
// cannot be imported directly under node:test. renderAthleteHeaderToolbarHtml
// itself is checked via source-pattern-guard tests over the raw file text
// instead. athlete-home.js has no such dependency and CAN be imported
// directly (see athlete-home.render.test.mjs) - used here for the real
// ICON_CALENDAR/ICON_SPECIFIC_PROGRAMS string values and a real
// renderAthleteHomeHtml() call, so the "same icon source" tests compare
// actual values, not just source text.
const { ICON_CALENDAR, ICON_SPECIFIC_PROGRAMS, renderAthleteHomeHtml } = await import("../athlete-home.js");

const athleteViewPath = fileURLToPath(new URL("../athlete-view.js", import.meta.url));
const athleteViewSource = readFileSync(athleteViewPath, "utf8");

function sliceFunction(source, name, windowSize = 900) {
  const start = source.indexOf(`function ${name}(`) >= 0 ? source.indexOf(`function ${name}(`) : source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  return source.slice(start, start + windowSize);
}

// === Icons present, reused from the same source as Home Quick actions ===

test("athlete-view.js imports ICON_CALENDAR and ICON_SPECIFIC_PROGRAMS from athlete-home.js instead of declaring its own SVG constants for them", () => {
  assert.match(athleteViewSource, /import\s*\{\s*ICON_CALENDAR,\s*ICON_SPECIFIC_PROGRAMS\s*\}\s*from\s*"\.\/athlete-home\.js";/);
  assert.ok(!athleteViewSource.includes('rx="2"></rect>'), "no second inline copy of the calendar icon's rect path should remain in athlete-view.js");
});

test("renderAthleteHeaderToolbarHtml's Weekly plans tab embeds the ${ICON_CALENDAR} template placeholder, not inline SVG markup", () => {
  const body = sliceFunction(athleteViewSource, "renderAthleteHeaderToolbarHtml", 1200);
  assert.match(body, /data-tab="weekly">\s*\$\{ICON_CALENDAR\}\s*<span>Weekly plans<\/span>/);
});

test("renderAthleteHeaderToolbarHtml's Specific programs tab embeds the ${ICON_SPECIFIC_PROGRAMS} template placeholder", () => {
  const body = sliceFunction(athleteViewSource, "renderAthleteHeaderToolbarHtml", 1200);
  assert.match(body, /data-tab="programs">\s*\$\{ICON_SPECIFIC_PROGRAMS\}\s*<span>Specific programs<\/span>/);
});

test("the Home Quick actions grid (renderAthleteHomeHtml, a real function call) actually renders the same ICON_CALENDAR/ICON_SPECIFIC_PROGRAMS values the toolbar template references", () => {
  const homeHtml = renderAthleteHomeHtml({
    data: {
      athlete: { name: "Test Athlete", imageUrl: "" },
      today: { date: "2026-08-10", hasTraining: false, planId: null, planName: "", sessionCount: 0, itemCount: 0 },
      week: { days: [{ date: "2026-08-10", isToday: true, hasTraining: false }] },
    },
    error: "",
  });
  assert.ok(homeHtml.includes(ICON_CALENDAR), "Home's calendar quick action must render the same ICON_CALENDAR string the toolbar imports");
  assert.ok(homeHtml.includes(ICON_SPECIFIC_PROGRAMS), "Home's programs quick action must render the same ICON_SPECIFIC_PROGRAMS string the toolbar imports");
});

// === Icons are decorative; visible text remains the accessible name ===

test("both reused icons are aria-hidden in their own definition, so every consumer (Home quick actions and the toolbar tabs) gets a decorative icon for free", () => {
  assert.match(ICON_CALENDAR, /aria-hidden="true"/);
  assert.match(ICON_SPECIFIC_PROGRAMS, /aria-hidden="true"/);
});

test("neither toolbar tab button carries a competing aria-label - the visible text span is the only accessible name", () => {
  const body = sliceFunction(athleteViewSource, "renderAthleteHeaderToolbarHtml", 1200);
  assert.ok(!/data-tab="weekly"[^>]*aria-label/.test(body));
  assert.ok(!/data-tab="programs"[^>]*aria-label/.test(body));
});

test("both tabs carry the tab-with-icon class consistently", () => {
  const body = sliceFunction(athleteViewSource, "renderAthleteHeaderToolbarHtml", 1200);
  assert.match(body, /class="tab tab-with-icon" data-tab="weekly">/);
  assert.match(body, /class="tab tab-with-icon" data-tab="programs">/);
});

// === data-open-calendar removed from the tab button ===

test("athlete-view.js source has zero remaining references to data-open-calendar", () => {
  assert.ok(!athleteViewSource.includes("data-open-calendar"));
});

// === app.js: clicking the tab only switches views, never auto-opens the calendar ===

function appJsSource() {
  const appPath = fileURLToPath(new URL("../app.js", import.meta.url));
  return readFileSync(appPath, "utf8");
}

test("handleGlobalClick's [data-tab] branch no longer has the weekly-tab-reclick-opens-calendar special case", () => {
  const body = sliceFunction(appJsSource(), "handleGlobalClick", 700);
  assert.ok(!/openWeeklyCalendarFromRail\(\);\s*\n\s*return;/.test(body), "the early-return branch that opened the calendar on a same-tab Weekly plans re-click must be gone");
});

test("handleGlobalClick unconditionally resets openWeekCalendarOnLoad to false when landing on the weekly tab - no dataset.openCalendar dependency left", () => {
  const body = sliceFunction(appJsSource(), "handleGlobalClick", 1100);
  assert.match(body, /if \(state\.activeTab === "weekly"\) state\.openWeekCalendarOnLoad = false;/);
  assert.ok(!body.includes("dataset.openCalendar"), "no code should still read a dataset attribute that no longer exists anywhere in the markup");
});

test("app.js source overall has zero remaining references to openCalendar dataset reads", () => {
  assert.ok(!appJsSource().includes("dataset.openCalendar"));
});

// === Existing calendar/date header trigger and prev/next nav are untouched ===

test("the Weekly header's own date/period button (week-toggle) still exists in weekly-actions.js, wired to toggle the calendar picker - completely separate from the tab click path", () => {
  const weeklyActionsPath = fileURLToPath(new URL("../weekly-actions.js", import.meta.url));
  const source = readFileSync(weeklyActionsPath, "utf8");
  assert.match(source, /if \(type === "week-toggle"\) \{\s*\n\s*state\.weekSelectorOpen = !state\.weekSelectorOpen;/);
});

test("program-view.js still renders the week-toggle date button plus untouched week-prev/week-next arrows", () => {
  const programViewPath = fileURLToPath(new URL("../program-view.js", import.meta.url));
  const source = readFileSync(programViewPath, "utf8");
  assert.match(source, /data-action="week-toggle"/);
  assert.match(source, /data-action="week-prev"/);
  assert.match(source, /data-action="week-next"/);
});

test("week-prev/week-next still call moveWeek and never touch openWeekCalendarOnLoad", () => {
  const weeklyActionsPath = fileURLToPath(new URL("../weekly-actions.js", import.meta.url));
  const source = readFileSync(weeklyActionsPath, "utf8");
  const start = source.indexOf('if (type === "week-prev" || type === "week-next")');
  const block = source.slice(start, start + 150);
  assert.match(block, /moveWeek\(type === "week-prev" \? -1 : 1\);/);
  assert.ok(!block.includes("openWeekCalendarOnLoad"));
});

// === Specific programs tab still switches to the programs view exactly as before ===

test("the Specific programs tab keeps its plain data-tab=\"programs\" wiring - same [data-tab] click path as Weekly plans, just with an icon added", () => {
  const body = sliceFunction(athleteViewSource, "renderAthleteHeaderToolbarHtml", 1200);
  assert.match(body, /<button class="tab tab-with-icon" data-tab="programs">/);
});

// === Active tab stays clearly marked ===

test("renderTabs()'s active-tab logic (toggling is-active by dataset.tab === state.activeTab) is untouched - unaffected by the icon markup added inside the button", () => {
  const body = sliceFunction(appJsSource(), "renderTabs", 400);
  assert.match(body, /tab\.classList\.toggle\("is-active", tab\.dataset\.tab === state\.activeTab\)/);
});

test("styles.css: .tab.is-active styling still exists, applying regardless of whether the tab has an icon", () => {
  const cssPath = fileURLToPath(new URL("../styles.css", import.meta.url));
  const css = readFileSync(cssPath, "utf8");
  assert.match(css, /\.tab\.is-active,\s*\n\.chip\.is-active \{/);
});

// === Mobile: both buttons fully visible, ~44px touch target, no overflow ===

test("styles.css: .athlete-tabs .tab has a minimum touch target of at least 44px", () => {
  const cssPath = fileURLToPath(new URL("../styles.css", import.meta.url));
  const css = readFileSync(cssPath, "utf8");
  const start = css.indexOf(".athlete-tabs .tab {");
  const block = css.slice(start, css.indexOf("}", start));
  const match = block.match(/min-height:\s*(\d+)px/);
  assert.ok(match, "min-height must be set on .athlete-tabs .tab");
  assert.ok(Number(match[1]) >= 44, `expected min-height >= 44px, got ${match[1]}px`);
});

test("styles.css: the mobile breakpoint keeps both tabs full-width and side by side (2-column grid with flexible minmax(0, 1fr) columns, no fixed width that could overflow)", () => {
  const cssPath = fileURLToPath(new URL("../styles.css", import.meta.url));
  const css = readFileSync(cssPath, "utf8");
  assert.match(css, /\.athlete-mode \.athlete-tabs \.tab \{\s*\n\s*min-height: 48px;/);
  assert.match(css, /\.athlete-tabs \{\s*\n\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
});

test("styles.css: the reused Home-quick-action icon is sized down to the existing 18px tab-icon dimensions when nested inside a tab, not left at the larger 30px Quick-action size", () => {
  const cssPath = fileURLToPath(new URL("../styles.css", import.meta.url));
  const css = readFileSync(cssPath, "utf8");
  const start = css.indexOf(".tab-with-icon .athlete-home-quick-action-icon {");
  assert.ok(start >= 0, "a scoped size override for the reused icon inside .tab-with-icon must exist");
  const block = css.slice(start, css.indexOf("}", start));
  assert.match(block, /width:\s*18px/);
  assert.match(block, /height:\s*18px/);
});

// === Backend/Messages/Athlete Home structure/Program Library untouched (scope guard) ===

test("scope guard: Messages source has zero references to the new icon exports (nothing in this change touched messages.js)", () => {
  const messagesPath = fileURLToPath(new URL("../messages.js", import.meta.url));
  const source = readFileSync(messagesPath, "utf8");
  assert.ok(!source.includes("ICON_CALENDAR") && !source.includes("ICON_SPECIFIC_PROGRAMS"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// feature/athlete-home-mvp: app.js runs init() - full DOM/session/network
// wiring - at import time and is deliberately never imported directly by
// this suite (same convention as organization-panel-cache.test.mjs /
// menu-cache-policy-coverage.test.mjs). These are source-pattern regression
// guards for the athlete-home-mvp glue that lives only in app.js/athlete.html/
// styles.css/builder-actions.js: proof the right wiring is still in place,
// not full behavioral tests (those live in athlete-home.render.test.mjs and
// athlete-home-cache.test.mjs for the pure/loader logic that CAN be imported
// directly).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appJsSource = await readFile(path.resolve(__dirname, "../app.js"), "utf8");
const athleteHtmlSource = await readFile(path.resolve(__dirname, "../athlete.html"), "utf8");
const stylesCssSource = await readFile(path.resolve(__dirname, "../styles.css"), "utf8");
const builderActionsSource = await readFile(path.resolve(__dirname, "../builder-actions.js"), "utf8");

function functionBody(name) {
  const marker = `function ${name}(`;
  const start = appJsSource.indexOf(marker);
  if (start < 0) return null;
  let parenDepth = 0;
  let i = start + marker.length - 1;
  for (; i < appJsSource.length; i += 1) {
    if (appJsSource[i] === "(") parenDepth += 1;
    else if (appJsSource[i] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const bodyOpen = appJsSource.indexOf("{", i);
  let depth = 0;
  for (let j = bodyOpen; j < appJsSource.length; j += 1) {
    if (appJsSource[j] === "{") depth += 1;
    else if (appJsSource[j] === "}") {
      depth -= 1;
      if (depth === 0) return appJsSource.slice(bodyOpen, j + 1);
    }
  }
  return null;
}

// === 1. Athlete Home is the initial tab after login ===

test("applyDefaultInitialTab() exists and lands an athlete-mode session on athlete-home, never weekly/coach-home", () => {
  const body = functionBody("applyDefaultInitialTab");
  assert.ok(body, "applyDefaultInitialTab() must exist in app.js");
  assert.match(body, /isAthleteMode\(\)/);
  assert.match(body, /state\.activeTab === "coach-home" \|\| state\.activeTab === "weekly"/);
  assert.match(body, /state\.activeTab = "athlete-home"/);
});

test("applyDefaultInitialTab() is called both from init()'s bootstrap path and the login-form submit handler", () => {
  const callSites = [...appJsSource.matchAll(/applyDefaultInitialTab\(\)/g)];
  assert.ok(callSites.length >= 2, "must be called at least twice: init() bootstrap and the login-form submit handler - a fresh sign-in while already on /athlete never re-runs init()");
});

// === 2. Weekly plan stays a separate, explicitly-chosen tab ===

test("the athlete-home sidebar button is the FIRST item in athlete.html's primary nav, before Weekly plan", () => {
  const primarySection = athleteHtmlSource.slice(
    athleteHtmlSource.indexOf('class="sidebar-section sidebar-primary"'),
    athleteHtmlSource.indexOf('class="search-field" hidden'),
  );
  const homeIndex = primarySection.indexOf('data-athlete-tab="athlete-home"');
  const calendarIndex = primarySection.indexOf('data-athlete-tab="calendar"');
  assert.ok(homeIndex >= 0, "athlete.html must have a data-athlete-tab=\"athlete-home\" button");
  assert.ok(calendarIndex >= 0, "athlete.html must still have the separate Weekly plan (calendar) tab");
  assert.ok(homeIndex < calendarIndex, "Home must be listed before Weekly plan in the sidebar");
});

// === 3. Today's training / week day clicks open the correct day in Weekly plan ===

test("openWeeklyPlanOnDate() mirrors weekly-actions.js's week-day-select assignment (index/viewedWeekStart/selectedWeekDay/pendingScrollDate/weekCalendarMonth)", () => {
  const body = functionBody("openWeeklyPlanOnDate");
  assert.ok(body, "openWeeklyPlanOnDate() must exist in app.js");
  assert.match(body, /weekIndexForDate\(weeks, date\)/);
  assert.match(body, /state\.selectedWeekIndex = weekIndex >= 0 \? weekIndex : 0/);
  assert.match(body, /state\.viewedWeekStart = weekMondayIso\(date\)/);
  assert.match(body, /state\.selectedWeekDay = date/);
  assert.match(body, /state\.pendingScrollDate = date/);
  assert.match(body, /state\.weekCalendarMonth = monthStartIso\(date\)/);
});

test("both athlete-home-open-today and athlete-home-open-day actions route through openWeeklyPlanOnDate", () => {
  assert.match(
    appJsSource,
    /type === "athlete-home-open-today" \|\| type === "athlete-home-open-day"\) \{\s*\n\s*await openWeeklyPlanOnDate\(action\.dataset\.date/,
  );
});

// === 4. Active program click opens the correct program; View all opens the full list ===

test("athlete-home-open-program sets state.selectedProgramId from the clicked card's real id before navigating to Specific programs", () => {
  assert.match(
    appJsSource,
    /type === "athlete-home-open-program" \|\| type === "athlete-home-view-programs"\) \{\s*\n\s*state\.selectedProgramId = type === "athlete-home-open-program" \? \(action\.dataset\.programId \|\| null\) : null;/,
  );
});

// === 5. Message button: opens the existing conversation, never a duplicate ===

test("the coach-message action guards against double-firing (checks + sets action.disabled) before posting", () => {
  const marker = 'if (type === "coach-message") {';
  const start = appJsSource.indexOf(marker);
  assert.ok(start >= 0, "the coach-message action handler must exist in handleContentClick");
  const block = appJsSource.slice(start, start + 700);
  assert.match(block, /if \(!coachUserId \|\| action\.disabled\) return;/, "must bail out if already disabled (a click already in flight)");
  assert.match(block, /action\.disabled = true;/);
  assert.match(block, /api\("\/api\/messages\/direct", \{ method: "POST"/);
  assert.match(block, /await openMessageConversation\(result\.conversationId\)/, "must open the returned conversation via the existing Messages panel, not build a new UI");
  assert.match(block, /action\.disabled = false;/, "must re-enable on completion (including failure) so a real retry is still possible");
});

test("the Message button is only ever rendered for a real, active coach relationship (is_my_coach), never a generic contact/profile button", async () => {
  const coachProfilesSource = await readFile(path.resolve(__dirname, "../coach-profiles.js"), "utf8");
  assert.match(coachProfilesSource, /isAthleteMode\(\) && profile\.is_my_coach/);
  assert.match(coachProfilesSource, /data-action="coach-message" data-coach-user-id="\$\{escapeAttr\(profile\.user_id\)\}"/);
});

// === 6. Cache invalidation: Home is invalidated at both weekly and programs mutation exit points ===

test("exitBuilderToPlanContext invalidates athlete-home on BOTH the weekly and the programs branch (Home aggregates both)", () => {
  const marker = "async function exitBuilderToPlanContext(";
  const start = builderActionsSource.indexOf(marker);
  assert.ok(start >= 0);
  const end = builderActionsSource.indexOf("\nexport async function handleBuilderPlanAction", start);
  const body = builderActionsSource.slice(start, end);
  const invalidateCalls = [...body.matchAll(/invalidateAthleteHomeCache\(\)/g)];
  assert.equal(invalidateCalls.length, 2, "exitBuilderToPlanContext must invalidate athlete-home once per branch (weekly exit, programs exit) - coach-home only needs the weekly one since it never shows programs");
});

test("builder-delete-source-plan invalidates athlete-home on BOTH the weekly and the programs branch", () => {
  const marker = 'if (type === "builder-delete-source-plan") {';
  const start = builderActionsSource.indexOf(marker);
  assert.ok(start >= 0);
  const end = builderActionsSource.indexOf("const deleteTargets = {", start);
  assert.ok(end > start);
  const block = builderActionsSource.slice(start, end);
  const invalidateCalls = [...block.matchAll(/invalidateAthleteHomeCache\(\)/g)];
  assert.equal(invalidateCalls.length, 2);
});

// === 7. Mobile nav drawer redesign (athlete-mode only, no change to coach/desktop sidebar) ===

// styles.css uses CRLF line endings - markers here deliberately avoid
// embedding a raw "\n" (which never matches "\r\n") by locating the unique
// inner rule first, then backtracking to its own @media wrapper.
function mobileMediaBlock() {
  const innerMarker = "body:not(.login-mode) .mobile-nav-toggle {";
  const innerStart = stylesCssSource.indexOf(innerMarker);
  assert.ok(innerStart >= 0, "the mobile-nav-toggle rule must still exist");
  const start = stylesCssSource.lastIndexOf("@media (max-width: 760px) {", innerStart);
  assert.ok(start >= 0, "the mobile nav @media block must still exist");
  let depth = 0;
  for (let i = start; i < stylesCssSource.length; i += 1) {
    if (stylesCssSource[i] === "{") depth += 1;
    else if (stylesCssSource[i] === "}") {
      depth -= 1;
      if (depth === 0) return stylesCssSource.slice(start, i + 1);
    }
  }
  return null;
}

test("the base (coach) drawer rule is untouched: still right-anchored, still min(320px, 90vw), still opaque white", () => {
  const block = mobileMediaBlock();
  assert.match(block, /body:not\(\.login-mode\) \.sidebar \{[^}]*right: 10px !important;/s);
  assert.match(block, /body:not\(\.login-mode\) \.sidebar \{[^}]*width: min\(320px, 90vw\) !important;/s);
  assert.match(block, /body:not\(\.login-mode\) \.sidebar \{[^}]*background: #ffffff !important;/s);
});

test("the athlete-mode override exists, is left-anchored, respects safe-area-inset-left, and caps width at min(260px, 82vw)", () => {
  const block = mobileMediaBlock();
  const marker = "body.mobile-nav-open.athlete-mode:not(.login-mode) .sidebar {";
  const start = block.indexOf(marker);
  assert.ok(start >= 0, "the athlete-mode-scoped drawer override must exist");
  const rule = block.slice(start, block.indexOf("}", start) + 1);
  assert.match(rule, /left: max\(10px, env\(safe-area-inset-left\)\) !important;/);
  assert.match(rule, /right: auto !important;/);
  assert.match(rule, /width: min\(260px, 82vw\) !important;/);
  assert.match(rule, /env\(safe-area-inset-bottom\)/, "max-height must account for the bottom safe area so the panel is never clipped behind a home indicator");
});

test("the athlete-mode override sets a translucent (92-96% opacity) white background with a backdrop blur, never fully opaque", () => {
  const block = mobileMediaBlock();
  const marker = "body.mobile-nav-open.athlete-mode:not(.login-mode) .sidebar {";
  const rule = block.slice(block.indexOf(marker), block.indexOf("}", block.indexOf(marker)) + 1);
  const opacityMatch = rule.match(/background: rgba\(255, 255, 255, (0\.\d+)\) !important;/);
  assert.ok(opacityMatch, "must set an rgba white background, not a flat #ffffff");
  const opacity = Number(opacityMatch[1]);
  assert.ok(opacity >= 0.92 && opacity <= 0.96, `background opacity ${opacity} must be within the required 92-96% band`);
  assert.match(rule, /backdrop-filter: blur\(\d+px\) !important;/);
});

test("the mobile drawer locks background scroll while open (no page scroll/shift behind it)", () => {
  const block = mobileMediaBlock();
  assert.match(block, /body\.mobile-nav-open:not\(\.login-mode\) \{\s*\n\s*overflow: hidden !important;\s*\n\s*\}/);
});

test("Escape closes the mobile nav drawer without navigating - checked before any navigation-triggering logic in the keydown handler", () => {
  const marker = 'document.addEventListener("keydown", (event) => {';
  const start = appJsSource.indexOf(marker);
  assert.ok(start >= 0);
  const block = appJsSource.slice(start, start + 400);
  assert.match(block, /if \(state\.mobileNavOpen\) closeMobileNav\(\);/);
});

test("closeMobileNav() only toggles state/re-renders - it never sets state.activeTab or calls loadActiveTab (Escape/backdrop must never navigate)", () => {
  const body = functionBody("closeMobileNav");
  assert.ok(body, "closeMobileNav() must exist");
  assert.ok(!body.includes("state.activeTab"), "closeMobileNav must never change the active tab");
  assert.ok(!body.includes("loadActiveTab"), "closeMobileNav must never trigger navigation/loading");
});

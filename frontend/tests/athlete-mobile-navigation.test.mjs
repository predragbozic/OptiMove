import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// hotfix/athlete-mobile-navigation: app.js/athlete-view.js/program-view.js
// all touch `document`/state at module scope through their import chains,
// so - same as every other app.js-adjacent test in this suite (see
// athlete-programs-profile-integration.test.mjs's own header comment) -
// they are checked via source-pattern-guard tests over the raw file text,
// never imported directly.

function readSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const appJsSource = readSource("../app.js");
const cssSource = readSource("../styles.css");
const athleteHtmlSource = readSource("../athlete.html");
const athleteViewSource = readSource("../athlete-view.js");
const athleteHomeSource = readSource("../athlete-home.js");
const programViewSource = readSource("../program-view.js");

function sliceFunction(source, name, windowSize = 1200) {
  const marker = source.includes(`function ${name}(`) ? `function ${name}(` : `export function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must exist`);
  return source.slice(start, start + windowSize);
}

function cssBlock(css, selectorStart) {
  const start = css.indexOf(selectorStart);
  assert.ok(start >= 0, `${selectorStart} must exist in styles.css`);
  return css.slice(start, css.indexOf("}", start) + 1);
}

// Several selectors below (.athlete-mode .athlete-topbar, .athlete-settings-identity,
// .week-nav-panel) are declared twice: once as a hidden/desktop-only base
// rule, once again inside the mobile @media (max-width: 760px) block with
// the actual sticky/visible behavior. The mobile one is always the LAST
// occurrence in the file (appended later), so grab that one specifically
// rather than relying on a single (fragile, since the file has many
// separate @media (max-width: 760px) blocks) media-query slice.
function cssBlockLast(css, selectorStart) {
  const start = css.lastIndexOf(selectorStart);
  assert.ok(start >= 0, `${selectorStart} must exist in styles.css`);
  return css.slice(start, css.indexOf("}", start) + 1);
}

// === Root cause fix: Specific programs card click listeners must be wired on initial render, not only from the search box ===

test("wireAthleteProgramsPanel calls renderRail() unconditionally after defining it - not only from the search input's own \"input\" listener", () => {
  const body = sliceFunction(appJsSource, "wireAthleteProgramsPanel", 2600);
  // "renderRail();" appears twice: once nested 6-space-deep inside the
  // search input's own "input" listener callback, and once at 2-space
  // top-level indentation, directly inside wireAthleteProgramsPanel's own
  // body (not nested in any callback) - i.e. it always runs on every call
  // to wireAthleteProgramsPanel, not only when the athlete types a search
  // keystroke.
  const occurrences = (body.match(/renderRail\(\);/g) || []).length;
  assert.equal(occurrences, 2, "renderRail() must be called exactly twice: once from the search input listener, once unconditionally");
  assert.match(body, /\r?\n {2}renderRail\(\);\r?\n\}/, "a top-level (2-space indented, not nested in any callback) renderRail() call must exist directly inside wireAthleteProgramsPanel's own body");
});

test("renderRail() (where the athlete-program-open click listeners actually get attached) is defined only once, and is the single source of card wiring for both initial mount and search re-filter", () => {
  const body = sliceFunction(appJsSource, "wireAthleteProgramsPanel", 1400);
  const occurrences = (body.match(/function renderRail\(\)/g) || []).length;
  assert.equal(occurrences, 1, "renderRail must be defined exactly once");
  assert.match(body, /railContainer\.querySelectorAll\("\[data-action='athlete-program-open'\]"\)\.forEach\(\(button\) => \{\s*button\.addEventListener\("click"/);
});

// === Goal 1: sticky mobile athlete topbar ===

test("styles.css: .athlete-mode .athlete-topbar is sticky (not fixed) inside the mobile @media (max-width: 760px) block, so it never overlaps content below it", () => {
  const block = cssBlockLast(cssSource, ".athlete-mode .athlete-topbar {");
  assert.match(block, /position:\s*sticky;/);
  assert.match(block, /top:\s*0;/);
  assert.match(block, /flex-direction:\s*row;/);
  assert.match(block, /backdrop-filter:\s*blur\(/);
  assert.match(block, /env\(safe-area-inset-top,\s*0px\)/);
});

test("styles.css: the desktop (non-mobile) .athlete-topbar rule keeps background: transparent - untouched by the mobile sticky override", () => {
  const block = cssBlock(cssSource, ".athlete-mode .athlete-topbar {");
  assert.match(block, /background:\s*transparent;/);
  assert.ok(!block.includes("position: sticky"), "the base (desktop) rule must not itself declare sticky positioning");
});

test("athlete.html: the topbar has a data-action=\"home\" brand button - the same action the sidebar's own .brand-mark already uses, so it's a true home shortcut not new navigation logic", () => {
  assert.match(athleteHtmlSource, /<button class="plain-button athlete-topbar-brand" type="button" data-action="home" aria-label="Home">/);
});

test("styles.css: the topbar brand icon is sized by height only (width: auto), preserving brand-logo.png's native aspect ratio instead of stretching it into a forced square", () => {
  const block = cssBlock(cssSource, ".athlete-topbar-brand-icon {");
  assert.match(block, /width:\s*auto;/);
  assert.match(block, /height:\s*23px;/);
});

test("styles.css: the workspace switcher pill is hidden on mobile for single-role athletes (no data-action means non-interactive/single-workspace) and only compacted, not hidden, when it IS interactive", () => {
  const start = cssSource.indexOf("@media (max-width: 760px) {");
  const mobileBlock = cssSource.slice(start);
  assert.match(mobileBlock, /\.athlete-mode \.workspace-toggle:not\(\[data-action\]\) \{\s*display:\s*none;\s*\}/);
  const compactStart = mobileBlock.indexOf('.athlete-mode .workspace-toggle[data-action="workspace-toggle"] {');
  assert.ok(compactStart >= 0);
  const compactBlock = mobileBlock.slice(compactStart, mobileBlock.indexOf("}", compactStart) + 1);
  assert.ok(!compactBlock.includes("display: none"), "the interactive (multi-role) workspace toggle must stay visible, just compacted");
});

test("styles.css: the mobile-nav drawer's brand row is left-aligned once the drawer is open, matching every other left-aligned menu row below it", () => {
  assert.match(cssSource, /body\.mobile-nav-open:not\(\.login-mode\) \.brand \{\s*justify-content:\s*flex-start\s*!important;\s*\}/);
});

// === Found during final visual pass: Account page showed the athlete's name/photo up to 3x (toolbar hero+tabs, compact identity row, Profile heading) ===

test("app.js: renderAthleteSettings() clears the toolbar instead of populating it with the Weekly/Specific hero+tabs (renderAthleteHeader) - that toolbar exists to switch between those two views, which doesn't apply once already on Account", () => {
  const body = sliceFunction(appJsSource, "renderAthleteSettings", 700);
  assert.match(body, /els\.toolbar\.innerHTML = "";/);
  assert.ok(!body.includes("renderAthleteHeader({});"), "must not populate the toolbar with the Weekly/Specific hero+tabs anymore");
});

test("athlete-view.js: the compact identity row is labeled \"Profile\" - not \"My program\", which belonged to the now-removed toolbar hero", () => {
  const body = sliceFunction(athleteViewSource, "renderAthleteSettingsIdentityHtml", 900);
  assert.match(body, /<span class="athlete-settings-identity-eyebrow">Profile<\/span>/);
});

test("athlete-view.js: renderAthleteSettingsHtml's own Profile+name heading was removed from the .athlete-settings-card panel - the sticky identity row above is now the only place that shows it, not a second copy right below", () => {
  const body = sliceFunction(athleteViewSource, "renderAthleteSettingsHtml", 700);
  assert.ok(!/<p class="eyebrow">Profile<\/p>\s*<h3>\$\{escapeHtml\(athlete/.test(body), "the panel must no longer render its own Profile eyebrow+name heading");
  assert.match(body, /Your coach controls program assignment/, "the descriptive intro text must still be there, just without the redundant heading above it");
});

// === Goal 2: Athlete Settings compact sticky identity row ===

test("athlete-view.js: renderAthleteSettingsHtml renders the compact identity row before the full-size hero card, not in place of it", () => {
  const body = sliceFunction(athleteViewSource, "renderAthleteSettingsHtml", 300);
  assert.match(body, /\$\{renderAthleteSettingsIdentityHtml\(athlete, profile\)\}/);
});

test("athlete-view.js: the compact identity row prefers the athlete's own edited profile photo/name over the coach-managed athlete row, falling back only when profile is missing or errored", () => {
  const body = sliceFunction(athleteViewSource, "renderAthleteSettingsIdentityHtml", 900);
  assert.match(body, /profile && !profile\.error \? profile\.imageUrl : athlete\?\.athlete_image_url/);
});

test("athlete-view.js: the identity row falls back to initials (not a broken <img>) when there is no photo, using the same initialsFor/renderImage pattern as the rest of the app", () => {
  const body = sliceFunction(athleteViewSource, "renderAthleteSettingsIdentityHtml", 900);
  assert.match(body, /avatar-fallback athlete-settings-identity-avatar/);
});

test("styles.css: .athlete-settings-identity is hidden by default (desktop) and only made sticky inside the mobile @media block, stacked directly under the topbar's own ~57px height", () => {
  const baseBlock = cssBlock(cssSource, ".athlete-settings-identity {");
  assert.match(baseBlock, /display:\s*none;/);
  const mobileRule = cssBlockLast(cssSource, ".athlete-settings-identity {");
  assert.match(mobileRule, /position:\s*sticky;/);
  assert.match(mobileRule, /top:\s*calc\(57px \+ env\(safe-area-inset-top, 0px\)\);/);
});

test("styles.css: the big existing .athlete-settings-card hero is never made sticky - only the new compact identity row is", () => {
  assert.ok(!cssSource.includes(".athlete-settings-card {\n  position: sticky"));
  const occurrences = (cssSource.match(/\.athlete-settings-card\s*\{[^}]*position:\s*sticky/g) || []).length;
  assert.equal(occurrences, 0);
});

// === Athlete "Settings" renamed to "Account" (label only - route/id untouched) ===

test("athlete.html: the sidebar nav button label reads Account, but its data-athlete-tab id is untouched", () => {
  assert.match(athleteHtmlSource, /data-athlete-tab="athlete-settings" type="button" title="Account">/);
  assert.match(athleteHtmlSource, /<span>Account<\/span>/);
  assert.ok(!athleteHtmlSource.includes("<span>Settings</span>"), "no athlete-shell nav label should still read Settings");
});

test("athlete-home.js: the Home quick action for athlete-settings is labeled Account, while its target-tab id (athlete-settings) is untouched - reuses the existing data-athlete-tab click handling, no new route", () => {
  assert.match(athleteHomeSource, /\["athlete-settings", "Account", ICON_ACCOUNT\]/);
});

test("athlete-home.js and athlete.html both use a person/profile icon (head + shoulders) for Account, not the settings gear - the quick action mirrors the sidebar's own Account icon, same convention as every other quick action", () => {
  assert.match(athleteHomeSource, /const ICON_ACCOUNT = `<svg[^`]*<circle cx="12" cy="8" r="4"><\/circle><path d="M4 20c0-4\.4 3\.6-7 8-7s8 2\.6 8 7"><\/path><\/svg>`;/);
  assert.match(athleteHtmlSource, /<circle cx="12" cy="8" r="4"><\/circle>\s*\n\s*<path d="M4 20c0-4\.4 3\.6-7 8-7s8 2\.6 8 7"><\/path>/);
});

test("app.js: renderAthleteSettings() sets the screen title to Account, and the coach shell's separate renderOrganizationPanel() Settings title is untouched", () => {
  const settingsBody = sliceFunction(appJsSource, "renderAthleteSettings", 700);
  assert.match(settingsBody, /els\.title\.textContent = "Account";/);
  const orgBody = sliceFunction(appJsSource, "renderOrganizationPanel", 400);
  assert.match(orgBody, /els\.title\.textContent = "Settings";/);
});

// === Goal 3/4 (already covered by athlete-program-navigation-icons.test.mjs) - active tab must never be a solid green/accent fill ===

test("styles.css: the athlete Weekly/Specific tabs' active state uses a border-only signal (matching Home's own .athlete-home-day.is-today pattern), overriding the generic solid-fill .tab.is-active just for tab-with-icon", () => {
  const block = cssBlock(cssSource, ".athlete-tabs .tab-with-icon.is-active {");
  assert.match(block, /border-color:\s*var\(--accent\);/);
  assert.match(block, /background:\s*var\(--surface\);/);
  assert.ok(!/background:\s*var\(--accent\)/.test(block), "the active tab must not fill with the accent color");
});

test("styles.css: the generic .tab.is-active solid-fill rule (used by coach chip toolbars/template tabs elsewhere) is untouched", () => {
  assert.match(cssSource, /\.tab\.is-active,\s*\n\.chip\.is-active \{\s*\n\s*border-color:\s*var\(--accent\);\s*\n\s*background:\s*var\(--accent\);/);
});

// === Goal 4 (found during browser verification): Home's "Weekly plan" quick action must not auto-open the calendar either ===

test("app.js: the athlete-home-quick-tab handler never opens the calendar, even for the \"calendar\"-named quick action tile (whose visible label is \"Weekly plan\", not \"Calendar\") - it used to set openWeekCalendarOnLoad = true immediately after setting weekSelectorOpen = false on the very line above it", () => {
  const start = appJsSource.indexOf('if (type === "athlete-home-quick-tab")');
  assert.ok(start >= 0);
  const block = appJsSource.slice(start, start + 1400);
  assert.match(block, /state\.weekSelectorOpen = false;/);
  assert.match(block, /state\.openWeekCalendarOnLoad = false;/);
  assert.ok(!block.includes("state.openWeekCalendarOnLoad = targetTab"), "openWeekCalendarOnLoad must never be derived from targetTab again - this quick action must never auto-open the calendar regardless of its internal tab id");
});

test("app.js: the els.athleteTabs sidebar/drawer nav link handler (data-athlete-tab, a completely separate click path from handleGlobalClick's [data-tab] toolbar handler - a different dataset attribute, never caught by that fix) has the exact same bug fixed the same way - found live in the drawer's own \"Weekly plan\" link during browser verification", () => {
  const start = appJsSource.indexOf("els.athleteTabs.forEach((button) => {");
  assert.ok(start >= 0);
  const block = appJsSource.slice(start, start + 700);
  assert.match(block, /state\.weekSelectorOpen = false;/);
  assert.match(block, /state\.openWeekCalendarOnLoad = false;/);
  assert.ok(!block.includes("state.openWeekCalendarOnLoad = targetTab"), "the sidebar/drawer Weekly plan link must never auto-open the calendar either");
});

test("app.js: no code anywhere still derives openWeekCalendarOnLoad from a tab id equal to \"calendar\" - the only remaining targetTab === \"calendar\" comparisons are the harmless tab-id-to-\"weekly\"-remap, not a calendar-open trigger", () => {
  assert.ok(!appJsSource.includes('openWeekCalendarOnLoad = targetTab === "calendar"'));
});

// === Goal 6: sticky contextual rows for Weekly plan / open Specific program ===

test("styles.css: .week-nav-wrap is display: contents on mobile so .week-nav-panel's containing block becomes .content-section (tall enough to actually have room to stick), not the wrap itself (exactly as tall as the nav row alone whenever the calendar picker is closed)", () => {
  const block = cssBlock(cssSource, ".athlete-mode .week-nav-wrap {");
  assert.match(block, /display:\s*contents;/);
});

test("styles.css: .week-nav-panel sticks at the same offset as the Settings identity row (directly under the topbar), only on mobile", () => {
  const block = cssBlock(cssSource, ".athlete-mode .week-nav-panel {");
  assert.match(block, /position:\s*sticky;/);
  assert.match(block, /top:\s*calc\(57px \+ env\(safe-area-inset-top, 0px\)\);/);
});

test("styles.css: .week-calendar-picker sticks directly below .week-nav-panel (not left in normal flow, which rendered it near the top of the page - disconnected from wherever the nav row was actually pinned once scrolled) - found live: opening the calendar while scrolled down left the athlete unsure it had opened at all", () => {
  const block = cssBlock(cssSource, ".athlete-mode .week-calendar-picker {");
  assert.match(block, /position:\s*sticky;/);
  assert.match(block, /top:\s*calc\(118px \+ env\(safe-area-inset-top, 0px\)\);/);
});

// Programs overhaul item 2: the Specific Program detail is now a real
// full-overlay (program-preview-overlay/-backdrop/-modal, same convention
// as the Template preview modal), for BOTH the athlete card rail and the
// coach chip toolbar - not an athlete-only inline back-header sharing the
// same scroll position as the list. See app.js's openSpecificProgramOverlay/
// closeSpecificProgramOverlay and program-view.js's renderProgramRootHtml.
// fix/specific-program-overlay-node-scroll: the overlay/backdrop/modal
// markup itself now lives in the shared renderProgramOverlayShellHtml
// helper (used by both renderProgramRootHtml's root day/block view AND
// renderProgramNodeOverlayHtml's drilled-in node view - see the pure-
// function tests in specific-program-overlay.test.mjs for actual rendered
// output from both), so the literal markup is checked on the helper here,
// with renderProgramRootHtml itself checked only for delegating to it.
test("program-view.js: renderProgramRootHtml delegates to the shared overlay/backdrop/modal shell, with a close action available for both coach and athlete (no isAthleteMode() gate)", () => {
  const shellBody = sliceFunction(programViewSource, "renderProgramOverlayShellHtml", 1400);
  assert.match(shellBody, /class="program-preview-overlay specific-program-overlay"/);
  assert.match(shellBody, /data-action="specific-program-close"/);
  assert.match(shellBody, /role="dialog" aria-modal="true"/);
  assert.ok(!shellBody.includes("isAthleteMode"), "the overlay itself must not be athlete-only - both shells get the same close affordance");

  const rootBody = sliceFunction(programViewSource, "renderProgramRootHtml", 1400);
  assert.match(rootBody, /renderProgramOverlayShellHtml\(/, "the root view must render through the shared shell, not its own copy of the overlay markup");
});

test("styles.css: the Specific Program overlay is edge-to-edge on mobile (practically the whole screen), not just the template preview's 12px-margin sizing", () => {
  const block = cssBlockLast(cssSource, ".specific-program-modal {");
  assert.match(block, /width:\s*100vw;/);
  assert.match(block, /height:\s*100dvh;/);
  assert.match(block, /border:\s*0;/);
});

test("styles.css: opening the Specific Program overlay locks background scroll (body.specific-program-open)", () => {
  const block = cssBlock(cssSource, "body.specific-program-open {");
  assert.match(block, /overflow:\s*hidden;/);
});

test("app.js: specific-program-close routes through closeSpecificProgramOverlay(), which never issues a network request", () => {
  const start = appJsSource.indexOf('if (type === "specific-program-close")');
  assert.ok(start >= 0);
  const block = appJsSource.slice(start, start + 200);
  assert.match(block, /closeSpecificProgramOverlay\(\);/);
  const fnBody = sliceFunction(appJsSource, "closeSpecificProgramOverlay", 700);
  assert.ok(!fnBody.includes("api("), "closing the overlay must never issue a network request");
  assert.ok(!fnBody.includes("state.selectedProgramId ="), "closing the overlay must not clear or change the open program's selection - the list keeps highlighting it");
  assert.ok(!fnBody.includes("els.toolbar"), "closing must never touch els.toolbar - that's what keeps the list's filter/search/scroll state intact for free");
});

test("app.js: wireAthleteProgramsPanel opens the overlay on card click (openSpecificProgramOverlay), replacing the old scroll-capture-only behavior", () => {
  const body = sliceFunction(appJsSource, "wireAthleteProgramsPanel", 2600);
  assert.match(body, /openSpecificProgramOverlay\(\);/);
  assert.ok(!body.includes("athleteProgramsListScrollY"), "the old manual scroll-position bookkeeping is gone - the fixed-position overlay + body scroll-lock preserves the background scroll position for free");
});

test("app.js: the coach chip toolbar also opens the overlay on click (openSpecificProgramOverlay), matching the athlete rail exactly", () => {
  const start = appJsSource.indexOf('els.toolbar.querySelectorAll(".program-toolbar .chip")');
  assert.ok(start >= 0);
  const block = appJsSource.slice(start, start + 400);
  assert.match(block, /openSpecificProgramOverlay\(\);/);
});

// fix/specific-program-overlay-node-scroll: closeSpecificProgramOverlay()
// used to run BEFORE the navStack-pop check, so Back from a node drilled
// into from inside the overlay (a domain/category/section) skipped straight
// past "step up one level" and closed the whole overlay instead - reported
// live as exercises "disappearing" after drilling in and pressing Back
// (or Escape, which shares this same function). navStack must now be
// popped first so the overlay only fully closes once the user is already
// back at its own root (day/block) list.
test("app.js: handleAppBack() steps up one navStack level (staying inside an open Specific Program overlay) before ever closing the overlay itself", () => {
  const start = appJsSource.indexOf("function handleAppBack()");
  assert.ok(start >= 0);
  const block = appJsSource.slice(start, start + 2200);
  assert.match(block, /if \(closeSpecificProgramOverlay\(\)\) return true;/);
  const navStackPopIndex = block.search(/if \(state\.navStack\.length\) \{\s*state\.navStack\.pop\(\);/);
  const closeOverlayIndex = block.indexOf("if (closeSpecificProgramOverlay()) return true;");
  assert.ok(navStackPopIndex >= 0, "navStack.pop() branch must exist in handleAppBack()");
  assert.ok(navStackPopIndex < closeOverlayIndex, "popping navStack must be checked before closing the overlay, or Back from a drilled-in node closes the overlay instead of stepping up one level");
});

// fix/specific-program-overlay-node-scroll: renderNode() (reached by
// clicking any domain/category/section tile - the same "node" action used
// by Weekly, Templates, AND the Specific Program overlay) used to always
// replace els.content with the bare node-detail markup. That is still
// correct for Weekly/Templates (full-page, no overlay), but for the
// Specific Program overlay it silently dropped the overlay's own
// backdrop/modal/scroll-container wrapper - reported live as broken scroll
// and, once drilled deeper, exercises not being visible at all. renderNode
// must now keep using that wrapper (renderProgramNodeOverlayHtml) whenever
// state.specificProgramOverlayOpen is true, and only fall back to the bare
// markup otherwise.
test("app.js: renderNode() keeps the Specific Program overlay's own chrome when drilling into a node, falling back to bare markup only outside the overlay", () => {
  const body = sliceFunction(appJsSource, "renderNode", 1400);
  assert.match(body, /state\.specificProgramOverlayOpen/, "renderNode must branch on whether the overlay is open");
  assert.match(body, /renderProgramNodeOverlayHtml\(/, "must render through the shared overlay-chrome helper when the overlay is open");
  const bareAssignIndex = body.search(/els\.content\.innerHTML = detailHtml;/);
  const overlayAssignIndex = body.search(/els\.content\.innerHTML = renderProgramNodeOverlayHtml\(/);
  assert.ok(bareAssignIndex >= 0 && overlayAssignIndex >= 0 && overlayAssignIndex < bareAssignIndex, "the overlay-wrapped render must be attempted before falling back to the bare (non-overlay) markup");
});

// === Scope guard: coach shell (index.html) untouched by any athlete-only change ===

test("scope guard: index.html has no athlete-topbar-brand / athlete-settings-identity markup - these are athlete-shell only", () => {
  const indexHtmlSource = readSource("../index.html");
  assert.ok(!indexHtmlSource.includes("athlete-topbar-brand"));
  assert.ok(!indexHtmlSource.includes("athlete-settings-identity"));
});

test("scope guard: index.html's own Settings label (organization/coach settings) is untouched - still reads Settings, not Account", () => {
  const indexHtmlSource = readSource("../index.html");
  assert.match(indexHtmlSource, /<span>Settings<\/span>/);
});

// === Found during final visual pass: Coach profiles card image was a fixed 145px-tall strip, then (still too big per user feedback) a full-width square - now a small avatar beside the text, matching the detail modal's own 76px photo scale ===

test("styles.css: .coach-card-media is a small fixed avatar (64px, smaller than the 76px .coach-profile-photo used in the detail view it opens), not a full-width image", () => {
  const mediaBlock = cssBlock(cssSource, ".coach-card-media {");
  assert.match(mediaBlock, /width:\s*64px;/);
  assert.match(mediaBlock, /height:\s*64px;/);
  const profilePhotoBlock = cssBlockLast(cssSource, ".coach-profile-photo {");
  assert.match(profilePhotoBlock, /width:\s*76px;/);
});

test("styles.css: .coach-card-hit lays the photo out beside the text (flex row), not stacked above it", () => {
  const hitBlock = cssBlockLast(cssSource, ".coach-card-hit {");
  assert.match(hitBlock, /display:\s*flex;/);
});

test("styles.css: the card's border/background moved to .coach-card itself, so the Message button (its own sibling below .coach-card-hit) reads as part of the same bordered card, not a floating element under it", () => {
  const cardBlock = cssBlock(cssSource, ".coach-card {");
  assert.match(cardBlock, /border:\s*1px solid var\(--line\);/);
  const hitBlock = cssBlockLast(cssSource, ".coach-card-hit {");
  assert.match(hitBlock, /border:\s*0;/);
});

test("coach-profiles.js: the compact card caps visible tags at 2 (was 4) to avoid ragged wrapping now that the card is narrow - the full tag list is still shown in the detail modal, untouched", () => {
  const coachProfilesSource = readSource("../coach-profiles.js");
  assert.match(coachProfilesSource, /const tags = \(profile\.tags \|\| \[\]\)\.slice\(0, 2\);/);
});

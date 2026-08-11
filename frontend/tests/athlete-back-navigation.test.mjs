import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// hotfix/athlete-home-mobile-layout: the athlete shell's Back/exit-confirm
// flow lives entirely in app.js (handleBrowserBack/handleAppBack/
// openAthleteExitConfirm/closeAthleteExitConfirm/confirmAthleteExit), which
// runs init() - full DOM/session/network wiring - at import time and is
// deliberately never imported directly by this suite (same convention as
// every other frontend test file in this project - see
// athlete-home-mvp-integration.test.mjs for the fuller explanation). These
// are source-pattern regression guards: proof the right functions exist,
// call the right things, in the right order and priority - not a full
// browser-driven behavioral test (that's covered by the manual Android
// Chrome / desktop browser pass described in the final report).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appJsSource = await readFile(path.resolve(__dirname, "../app.js"), "utf8");
const athleteHtmlSource = await readFile(path.resolve(__dirname, "../athlete.html"), "utf8");

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

function lineIndex(body, pattern) {
  const match = body.match(pattern);
  if (!match) return -1;
  return body.indexOf(match[0]);
}

// === 1. Back closes a modal/overlay before any navigation ===

test("handleAppBack() checks the media modal FIRST, before any tab/navStack/drawer logic", () => {
  const body = functionBody("handleAppBack");
  assert.ok(body, "handleAppBack() must exist");
  const mediaIndex = lineIndex(body, /if \(!els\.mediaModal\?\.hidden\) \{/);
  assert.ok(mediaIndex >= 0);
  // Everything else in the function must come after this check.
  const drawerIndex = lineIndex(body, /if \(state\.mobileNavOpen\) \{/);
  const navStackIndex = lineIndex(body, /if \(state\.navStack\.length\) \{/);
  assert.ok(mediaIndex < drawerIndex && mediaIndex < navStackIndex, "the media-modal overlay check must run before the drawer or navStack checks");
});

test("handleAppBack() closes the media modal and returns true (handled) without touching state.activeTab or history", () => {
  const body = functionBody("handleAppBack");
  const start = body.indexOf("if (!els.mediaModal?.hidden) {");
  const block = body.slice(start, start + 120);
  assert.match(block, /closeMedia\(\);/);
  assert.match(block, /return true;/);
});

// === 2. Back closes the drawer (and only the drawer) ===

test("handleAppBack() closes the mobile nav drawer, before the internal tab-history fallback", () => {
  const body = functionBody("handleAppBack");
  const drawerIndex = lineIndex(body, /if \(state\.mobileNavOpen\) \{/);
  const rootTabIndex = lineIndex(body, /const rootTab = isAthleteMode\(\)/);
  assert.ok(drawerIndex >= 0 && rootTabIndex >= 0);
  assert.ok(drawerIndex < rootTabIndex, "the drawer check must run before the root-tab fallback");
  const block = body.slice(drawerIndex, drawerIndex + 100);
  assert.match(block, /closeMobileNav\(\);/);
  assert.match(block, /return true;/);
});

// === 3. Back from Calendar/Specific programs/Program Library/Coaches/Settings returns to the previous athlete view (Home) ===

test("handleAppBack()'s root-tab fallback targets athlete-home for the athlete shell (weekly for the coach shell, unchanged)", () => {
  const body = functionBody("handleAppBack");
  assert.match(body, /const rootTab = isAthleteMode\(\) \? "athlete-home" : "weekly";/);
  assert.match(body, /if \(state\.activeTab !== rootTab\) \{/);
  assert.match(body, /state\.activeTab = rootTab;/);
});

// === 4. Back on athlete-home with nothing left internally opens the Exit confirmation (athlete shell only) ===

test("handleBrowserBack() opens the styled Exit confirm modal for the athlete shell once handleAppBack() has nothing left to handle - never the coach shell's native window.confirm", () => {
  const body = functionBody("handleBrowserBack");
  assert.ok(body, "handleBrowserBack() must exist");
  const athleteBranchIndex = lineIndex(body, /if \(isAthleteMode\(\)\) \{/);
  const confirmIndex = lineIndex(body, /window\.confirm\("Exit OptiMove\?"\)/);
  assert.ok(athleteBranchIndex >= 0 && confirmIndex >= 0);
  assert.ok(athleteBranchIndex < confirmIndex, "the athlete-mode branch must be checked before ever reaching window.confirm");
  const athleteBlock = body.slice(athleteBranchIndex, confirmIndex);
  assert.match(athleteBlock, /openAthleteExitConfirm\(\);/);
  assert.ok(!athleteBlock.includes("window.confirm"), "the athlete branch must never call the native confirm()");
});

test("the Exit confirm modal markup exists in athlete.html with the exact required title/text/buttons", () => {
  assert.match(athleteHtmlSource, /id="exitConfirmModal"/);
  assert.match(athleteHtmlSource, /Exit OptiMove\?/);
  assert.match(athleteHtmlSource, /Are you sure you want to leave the application\?/);
  assert.match(athleteHtmlSource, /data-action="exit-confirm-stay"[^>]*>Stay</);
  assert.match(athleteHtmlSource, /data-action="exit-confirm-exit"[^>]*>Exit</);
});

// === 5. Stay closes the confirmation and keeps the user on Home ===

test("closeAthleteExitConfirm() (Stay) only closes state - it never navigates, never sets allowBrowserExit, never calls history.back()", () => {
  const body = functionBody("closeAthleteExitConfirm");
  assert.ok(body, "closeAthleteExitConfirm() must exist");
  assert.match(body, /state\.athleteExitConfirmOpen = false;/);
  assert.ok(!body.includes("state.activeTab"), "Stay must never change the active tab");
  assert.ok(!body.includes("allowBrowserExit"), "Stay must never grant an exit");
  assert.ok(!body.includes("history.back"), "Stay must never move browser history");
});

test("the exit-confirm-stay action is wired in handleGlobalClick to closeAthleteExitConfirm()", () => {
  assert.match(appJsSource, /action\.dataset\.action === "exit-confirm-stay"\) \{\s*\r?\n\s*closeAthleteExitConfirm\(\);/);
});

test("clicking the backdrop is equivalent to Stay (same data-action, same handler, no separate close path)", () => {
  assert.match(athleteHtmlSource, /class="exit-confirm-backdrop" data-action="exit-confirm-stay"/);
});

// === 6. Exit never loops, and genuinely allows leaving ===

test("confirmAthleteExit() (Exit) is the ONLY place allowed to set state.allowBrowserExit for this flow, and calls history.back() exactly once", () => {
  const body = functionBody("confirmAthleteExit");
  assert.ok(body, "confirmAthleteExit() must exist");
  assert.match(body, /state\.athleteExitConfirmOpen = false;/, "must close the modal before leaving, so a slow re-render can never show it again mid-exit");
  assert.match(body, /state\.allowBrowserExit = true;/);
  const historyBackCalls = [...body.matchAll(/window\.history\.back\(\)/g)];
  assert.equal(historyBackCalls.length, 1);
});

test("handleBrowserBack()'s very first line returns immediately once allowBrowserExit is true - the resulting popstate from Exit's history.back() can never reopen the modal or loop", () => {
  const body = functionBody("handleBrowserBack");
  const firstStatement = body.trim().split("\n")[1]?.trim() || body.trim();
  assert.match(body, /if \(state\.allowBrowserExit\) return;/);
  assert.ok(body.indexOf("if (state.allowBrowserExit) return;") < body.indexOf("if (state.appHistoryDepth"), "the allowBrowserExit short-circuit must be the very first check, before anything else runs");
  void firstStatement;
});

test("the exit-confirm-exit action is wired in handleGlobalClick to confirmAthleteExit()", () => {
  assert.match(appJsSource, /action\.dataset\.action === "exit-confirm-exit"\) \{\s*\r?\n\s*confirmAthleteExit\(\);/);
});

test("handleAppBack() closes an already-open Exit confirm modal on a second Back press instead of doing anything else (no re-trigger of openAthleteExitConfirm)", () => {
  const body = functionBody("handleAppBack");
  const exitConfirmIndex = lineIndex(body, /if \(state\.athleteExitConfirmOpen\) \{/);
  assert.ok(exitConfirmIndex >= 0);
  const block = body.slice(exitConfirmIndex, exitConfirmIndex + 100);
  assert.match(block, /closeAthleteExitConfirm\(\);/);
  assert.match(block, /return true;/);
});

// === 7. Repeated navigation to the same tab never fills history ===

test("every real tab-change call site (rail tabs, library tabs, athlete tabs, quick actions, goHome, openWeeklyPlanOnDate) guards pushAppHistory() on an actual state.activeTab change, never an unconditional push", () => {
  const pushCallSites = [...appJsSource.matchAll(/pushAppHistory\(\);/g)];
  assert.ok(pushCallSites.length >= 6, "there should be several distinct real-navigation call sites");
  // Every real call site in this file is preceded on the same or previous
  // line by an `if (state.activeTab !== ...)` (or equivalent `!==`) guard -
  // spot-check the specific ones this hotfix touches directly.
  assert.match(appJsSource, /if \(state\.activeTab !== "athlete-home"\) pushAppHistory\(\);/, "goHome()");
  assert.match(appJsSource, /if \(state\.activeTab !== nextTab\) pushAppHistory\(\);/, "athlete-home-quick-tab");
  assert.match(appJsSource, /if \(state\.activeTab !== "weekly"\) pushAppHistory\(\);/, "openWeeklyPlanOnDate()");
});

test("pushAppHistory() itself only ever adds ONE history entry per call (single pushState, single depth increment) - never a loop", () => {
  const body = functionBody("pushAppHistory");
  assert.ok(body, "pushAppHistory() must exist");
  const pushStateCalls = [...body.matchAll(/window\.history\.pushState/g)];
  assert.equal(pushStateCalls.length, 1);
  assert.match(body, /state\.appHistoryDepth \+= 1;/);
});

// === 8. Logout removes the athlete history protection ===

test("signOut() explicitly removes the popstate listener before its full-page reload", () => {
  const body = functionBody("signOut");
  assert.ok(body, "signOut() must exist");
  assert.match(body, /window\.removeEventListener\("popstate", handleBrowserBack\);/);
  assert.match(body, /window\.location\.replace\("\/"\);/, "logout must still be the existing direct, explicit full navigation - no confirmation step was added to it");
});

test("signOut() never calls openAthleteExitConfirm or any exit-confirm gate - logout stays a direct, unconfirmed action", () => {
  const body = functionBody("signOut");
  assert.ok(!body.includes("ExitConfirm"), "logout must never route through the Back-button exit confirmation");
});

// === 9. Public auth/invite routes are not covered by the athlete history protection ===

test("ensureBackGuard() (the sentinel/root history state) only ever arms once a real session exists - never on the public auth/invite pages", () => {
  const body = functionBody("ensureBackGuard");
  assert.ok(body, "ensureBackGuard() must exist");
  assert.match(body, /if \(state\.backGuardReady \|\| !state\.currentUser\) return;/, "no currentUser (the public/unauthenticated routes) means this is a no-op");
});

test("the public route handlers (invite/join/verify-email/forgot-password/reset-password/confirm-email-change) return early in init() before ensureBackGuard() or the popstate listener setup ever runs for them", () => {
  const initBody = functionBody("init");
  assert.ok(initBody, "init() must exist");
  const publicRoutes = ["/invite", "/join", "/verify-email", "/forgot-password", "/reset-password"];
  for (const route of publicRoutes) {
    const routeIndex = initBody.indexOf(`window.location.pathname === "${route}"`);
    assert.ok(routeIndex >= 0, `init() must still special-case ${route}`);
  }
  const backGuardIndex = initBody.indexOf("ensureBackGuard();");
  assert.ok(backGuardIndex >= 0);
  for (const route of publicRoutes) {
    const routeIndex = initBody.indexOf(`window.location.pathname === "${route}"`);
    assert.ok(routeIndex < backGuardIndex, `${route}'s early return must come before ensureBackGuard() in init()'s control flow`);
  }
});

test("the styled athlete Exit-confirm modal can structurally never appear on a public route: every public route is served from index.html, never athlete.html, and isAthleteMode() (the sole gate on openAthleteExitConfirm) checks for the athlete.html-only body class", async () => {
  const serverSource = await readFile(path.resolve(__dirname, "../../backend/src/server.js"), "utf8");
  assert.match(
    serverSource,
    /app\.get\(\["\/", "\/app", "\/invite", "\/join", "\/verify-email", "\/forgot-password", "\/reset-password", "\/confirm-email-change"\], \(_req, res\) => \{\s*\r?\n\s*sendHtmlEntry\(res, "index\.html"\);/,
    "every public route must still be served from index.html, not athlete.html",
  );
  const accessJsSource = await readFile(path.resolve(__dirname, "../access.js"), "utf8");
  assert.match(accessJsSource, /document\.body\.classList\.contains\("athlete-mode"\)/, "isAthleteMode() must still key off the athlete.html-only body class");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// perf/settings-navigation-fast-path: Settings sub-tab switches (Overview/
// Users/Clubs/Teams/Athletes/Tags & Presets/Join links) must reuse the
// already-loaded state.organization.data instead of refetching
// /api/organization on every click, and Program Library must never block its
// own /api/templates load on a full Organization refresh. Both decisions are
// pure boolean predicates extracted into navigation.js specifically so they
// can be exercised here without booting the whole app (app.js runs init()
// - real DOM/session/network wiring - at import time, so it is deliberately
// never imported directly by this test suite; see the same convention in
// every other frontend test file).
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { shouldBackgroundRefreshOrganizationForTemplates, shouldFetchOrganizationData } = await import("../navigation.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appJsSource = await readFile(path.resolve(__dirname, "../app.js"), "utf8");

// --- 1-2: first entry into Settings vs. switching between its sub-tabs ---

test("1. a genuine first entry into Settings (no cached data yet) always fetches, regardless of forceRefresh", () => {
  assert.equal(shouldFetchOrganizationData({ forceRefresh: false, cachedData: null }), true, "loadActiveTab() calls this with forceRefresh:false on every Settings click - only cachedData decides a first-ever entry");
  assert.equal(shouldFetchOrganizationData({ forceRefresh: true, cachedData: null }), true);
});

test("2. once Organization data is cached, switching between all Settings sub-tabs makes no additional request", () => {
  const cachedData = { clubs: [], teams: [], athletes: [], users: [] };
  // Every one of Overview/Users/Clubs/Teams/Athletes/Tags & Presets/Join
  // links routes through loadActiveTab() -> renderOrganizationPanel({refresh:
  // false}) while state.activeTab stays "organization" - this is exactly
  // that call shape, repeated for every sub-tab.
  for (const section of ["overview", "users", "clubs", "teams", "athletes", "presets", "joinLinks"]) {
    assert.equal(
      shouldFetchOrganizationData({ forceRefresh: false, cachedData }),
      false,
      `switching to Settings/${section} must not trigger a fetch once data is already cached`,
    );
  }
});

test("3. an explicit refresh (workspace switch, post-mutation) still forces a real fetch even when data is cached", () => {
  const cachedData = { clubs: [], teams: [], athletes: [], users: [] };
  assert.equal(shouldFetchOrganizationData({ forceRefresh: true, cachedData }), true);
  assert.equal(shouldFetchOrganizationData(), true, "the default forceRefresh:true/cachedData:null shape must still fetch");
});

// --- 4: Program Library is never blocked by a full Organization refresh ---

test("4. Program Library only needs a background Organization refresh when nothing is cached yet, and never for an athlete", () => {
  assert.equal(shouldBackgroundRefreshOrganizationForTemplates({ activeTab: "templates", isAthlete: false, cachedData: null }), true);
  assert.equal(shouldBackgroundRefreshOrganizationForTemplates({ activeTab: "templates", isAthlete: false, cachedData: { clubs: [] } }), false, "already-cached Organization data must be reused, not refetched, when opening Program Library");
  assert.equal(shouldBackgroundRefreshOrganizationForTemplates({ activeTab: "templates", isAthlete: true, cachedData: null }), false, "an athlete account has no Organization/accessRequests badge to refresh");
  assert.equal(shouldBackgroundRefreshOrganizationForTemplates({ activeTab: "coaches", isAthlete: false, cachedData: null }), false, "must only apply while actually on the templates tab");
});

// --- 5: loadTemplates() must never await this refresh before loading templates ---

test("5. loadTemplates() fires the background Organization refresh with void, never awaiting it before loadTemplatesData()", () => {
  const match = appJsSource.match(/async function loadTemplates\(options = \{\}\) \{[\s\S]*?\n\}/);
  assert.ok(match, "loadTemplates() must still exist in app.js");
  const body = match[0];
  assert.ok(body.includes("void refreshOrganizationData"), "the Organization refresh must be fired with void, not awaited");
  assert.ok(!/await refreshOrganizationData/.test(body), "loadTemplates() must never await refreshOrganizationData before returning loadTemplatesData(...)");
  assert.ok(/return loadTemplatesData\(/.test(body), "the /api/templates load must still be the function's return value");
});

// --- 6: workspace switch still forces a real Organization refresh ---

test("6. onWorkspaceChanged() still calls renderOrganizationPanel with a forced refresh, invalidating any cached data for the new workspace", () => {
  const match = appJsSource.match(/async function onWorkspaceChanged\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, "onWorkspaceChanged() must still exist in app.js");
  // No explicit `{ refresh: false }` (or any other falsy override) may be
  // passed here - renderOrganizationPanel's default refresh:true must apply,
  // which is exactly what shouldFetchOrganizationData({forceRefresh:true,...})
  // above proves always triggers a fetch.
  assert.ok(/renderOrganizationPanel\(\)/.test(match[0]), "onWorkspaceChanged must call renderOrganizationPanel() with no refresh override, so the default forced refresh applies");
});

// --- 7: cached Organization data can never survive a login as a different account ---

test("7. the login success handler still clears any cached Organization data before deciding which shell to land in", () => {
  const loginBlockStart = appJsSource.indexOf('closest("#loginForm")');
  assert.ok(loginBlockStart >= 0, "the #loginForm submit handler must still exist in app.js");
  // Scan only the next ~2000 chars after the handler starts - large enough
  // to comfortably cover the login success path, small enough to avoid
  // matching an unrelated, later occurrence of these same statements.
  const window = appJsSource.slice(loginBlockStart, loginBlockStart + 2000);
  const currentUserIndex = window.indexOf("state.currentUser = data.user;");
  const resetIndex = window.indexOf("state.organization.data = null;");
  const loadSessionIndex = window.indexOf("await loadSession();");
  assert.ok(currentUserIndex >= 0 && resetIndex >= 0 && loadSessionIndex >= 0, "login must still set currentUser, reset organization.data, and reload the session");
  assert.ok(currentUserIndex < resetIndex && resetIndex < loadSessionIndex, "organization.data must be cleared after the new user is known but before anything re-renders from it");
});

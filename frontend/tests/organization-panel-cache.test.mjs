import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// perf/main-navigation-cache: Settings/Organization, Coaches, Program
// Library, and Exercise Library are all now backed by view-cache.js (see
// view-cache.test.mjs for the generic cache mechanics, and
// coaches-view-cache.test.mjs/program-library-view-cache.test.mjs/
// exercise-library-view-cache.test.mjs for real behavioral coverage of the
// standalone modules). renderOrganizationPanel/refreshOrganizationData/
// onWorkspaceChanged/signOut/the login handler all live in app.js, which
// runs init() - full DOM/session/network wiring - at import time and is
// deliberately never imported directly by this test suite (same convention
// as every other frontend test file). These are source-pattern regression
// guards for that specific glue code: proof the right functions are still
// called, in the right order, not full behavioral tests.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appJsSource = await readFile(path.resolve(__dirname, "../app.js"), "utf8");

function functionBody(name) {
  const marker = `async function ${name}(`;
  const start = appJsSource.indexOf(marker);
  if (start < 0) return null;
  // First scan (paren depth) past the parameter list - which may itself
  // contain a destructured default object, e.g. `({ refresh = true } = {})`
  // - to the `{` that actually opens the function BODY, not the parameter
  // pattern's own brace. Only then start the brace-depth scan for the body.
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
  let j = bodyOpen;
  for (; j < appJsSource.length; j += 1) {
    if (appJsSource[j] === "{") depth += 1;
    else if (appJsSource[j] === "}") {
      depth -= 1;
      if (depth === 0) return appJsSource.slice(bodyOpen, j + 1);
    }
  }
  return null;
}

// --- 1-2: renderOrganizationPanel routes through loadCachedView ---

test("1. renderOrganizationPanel still exists and routes /api/organization through loadCachedView, not a raw fetch", () => {
  const body = functionBody("renderOrganizationPanel");
  assert.ok(body, "renderOrganizationPanel must still exist in app.js");
  assert.ok(body.includes("loadCachedView("), "the fetch must go through the shared view cache, not a bare api() call");
  assert.ok(body.includes('namespace: ORGANIZATION_CACHE_NAMESPACE'), "must use the dedicated organization cache namespace");
  assert.ok(body.includes("forceRefresh: refresh"), "the existing refresh:true/false parameter must still control whether a fetch is forced");
  assert.ok(body.includes("getCurrentContextKey"), "must pass a race guard so a late response for an abandoned workspace/account is never applied");
});

// --- 3: an explicit refresh (workspace switch, post-mutation) still forces a real fetch ---

test("3. onWorkspaceChanged still calls renderOrganizationPanel with a forced refresh when Settings is the active tab", () => {
  const body = functionBody("onWorkspaceChanged");
  assert.ok(body, "onWorkspaceChanged must still exist in app.js");
  assert.ok(/renderOrganizationPanel\(\)/.test(body), "must call renderOrganizationPanel() with no refresh override, so its default forced refresh applies");
});

test("3b. onWorkspaceChanged also refreshes Coaches/Program Library/Exercise Library when THEY are the active tab, each with forceRefresh", () => {
  const body = functionBody("onWorkspaceChanged");
  assert.ok(body.includes('loadCoaches({ forceRefresh: true })'));
  assert.ok(body.includes('loadTemplates({ forceRefresh: true })'));
  assert.ok(/loadExercises\([^)]*\{\s*forceRefresh:\s*true\s*\}\)/.test(body), "Exercise Library's forceRefresh must be passed through on workspace change");
});

// --- 4: refreshOrganizationData keeps its exact existing name/contract, now cache-aware ---

test("4. refreshOrganizationData keeps its exact existing signature/behavior (every organization-actions.js mutation handler calls it by this name) and now also writes the fresh result into the cache", () => {
  const body = functionBody("refreshOrganizationData");
  assert.ok(body, "refreshOrganizationData must still exist under this exact name - organization-actions.js calls it by name after every mutation (grant/revoke roles, login-status, archive/restore, invite/join-link actions, club/team/athlete/user CRUD)");
  assert.ok(body.includes("silent"), "the existing silent:true/false contract must be preserved");
  assert.ok(body.includes("setCacheData("), "a successful refresh must write into the cache so the next Settings/Program-Library-badge read sees it immediately");
  assert.ok(body.includes("setCacheError("), "a failed refresh must still be recorded in the cache (background-refresh-failure semantics), not silently dropped");
});

test("4b. refreshOrganizationData never lets a late response overwrite state.organization.data/error once the account/workspace has moved on", () => {
  // loadTemplates() fires this in the background with `void`, unawaited (see
  // test 8 below) - a workspace/account switch can complete before it
  // resolves. Unlike renderOrganizationPanel (which gets this for free via
  // loadCachedView's own getCurrentContextKey guard), refreshOrganizationData
  // writes into state.organization.data/error directly and must re-check the
  // context itself, on BOTH the success and failure paths, before doing so.
  const body = functionBody("refreshOrganizationData");
  assert.ok(body, "refreshOrganizationData must still exist");
  const setCacheDataIndex = body.indexOf("setCacheData(");
  const stateWriteIndex = body.indexOf("state.organization.data = data;");
  assert.ok(setCacheDataIndex >= 0 && stateWriteIndex >= 0 && setCacheDataIndex < stateWriteIndex, "the cache write (always correct - it's keyed by the request's own captured context) must happen before the guarded live-state write");
  const guardBeforeStateWrite = body.slice(setCacheDataIndex, stateWriteIndex);
  assert.ok(/organizationContextKey\(\)\s*!==\s*contextKey/.test(guardBeforeStateWrite), "a context re-check must sit between the cache write and the state.organization.data write on the success path");

  const setCacheErrorIndex = body.indexOf("setCacheError(");
  const errorStateWriteIndex = body.indexOf("state.organization.error = error.message");
  assert.ok(setCacheErrorIndex >= 0 && errorStateWriteIndex >= 0 && setCacheErrorIndex < errorStateWriteIndex);
  const guardBeforeErrorWrite = body.slice(setCacheErrorIndex, errorStateWriteIndex);
  assert.ok(/organizationContextKey\(\)\s*!==\s*contextKey/.test(guardBeforeErrorWrite), "a context re-check must sit between the cache error write and the state.organization.error write on the failure path too");
});

// --- 5: workspace switch invalidates old data structurally, via a different context key ---

test("5. organizationContextKey/loadTemplates/loadCoaches/searchExercises all key off currentUserWorkspaceContextParts, so a workspace switch can never read the old workspace's cache", () => {
  assert.ok(appJsSource.includes("function organizationContextKey()"));
  assert.ok(appJsSource.includes("currentUserWorkspaceContextParts()"), "app.js's own organizationContextKey must include the account+workspace parts");
});

// --- 6: logout/login fully clears the cache ---

test("6. signOut clears the entire view cache before/alongside its hard reload", () => {
  const start = appJsSource.indexOf("async function signOut()");
  assert.ok(start >= 0, "signOut must still exist in app.js");
  const window = appJsSource.slice(start, start + 1000);
  assert.ok(window.includes("clearAllViewCache()"), "signOut must clear the view cache, not just state.currentUser");
  const clearIndex = window.indexOf("clearAllViewCache()");
  // Searches for the redirect starting AFTER clearIndex - a comment earlier
  // in this same function also mentions window.location.replace("/") by
  // name (explaining why the explicit clear is defensive, not load-bearing)
  // and must not be mistaken for the real call.
  const replaceIndex = window.indexOf('window.location.replace("/")', clearIndex);
  assert.ok(clearIndex >= 0 && replaceIndex >= 0 && clearIndex < replaceIndex, "the cache must be cleared before (or at latest alongside) the redirect, never left for \"later\"");
});

test("7. the login success handler clears the view cache (and organization.data) before deciding which shell to land in", () => {
  const loginBlockStart = appJsSource.indexOf('closest("#loginForm")');
  assert.ok(loginBlockStart >= 0, "the #loginForm submit handler must still exist in app.js");
  const window = appJsSource.slice(loginBlockStart, loginBlockStart + 2000);
  const currentUserIndex = window.indexOf("state.currentUser = data.user;");
  const clearCacheIndex = window.indexOf("clearAllViewCache();");
  const loadSessionIndex = window.indexOf("await loadSession();");
  assert.ok(currentUserIndex >= 0 && clearCacheIndex >= 0 && loadSessionIndex >= 0, "login must still set currentUser, clear the view cache, and reload the session");
  assert.ok(currentUserIndex < clearCacheIndex && clearCacheIndex < loadSessionIndex, "the cache must be cleared after the new user is known but before anything re-renders from it");
});

// --- 8: Program Library is never blocked by a full Organization refresh ---

test("8. loadTemplates() fires the background Organization refresh with void, never awaiting it before loadTemplatesData()", () => {
  const match = appJsSource.match(/async function loadTemplates\(options = \{\}\) \{[\s\S]*?\n\}/);
  assert.ok(match, "loadTemplates() must still exist in app.js");
  const body = match[0];
  assert.ok(body.includes("void refreshOrganizationData"), "the Organization refresh must be fired with void, not awaited");
  assert.ok(!/await refreshOrganizationData/.test(body), "loadTemplates() must never await refreshOrganizationData before returning loadTemplatesData(...)");
  assert.ok(/return loadTemplatesData\(/.test(body), "the /api/templates load must still be the function's return value");
});

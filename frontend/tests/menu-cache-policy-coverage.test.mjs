import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MENU_CACHE_POLICIES } from "../menu-cache-policy.js";

// perf/calendar-and-menu-cache-policy: this is the guard the task asked
// for - it must fail in development the moment someone adds a new
// `state.activeTab === "..."` branch to loadActiveTab() (app.js) without
// also adding a matching entry to menu-cache-policy.js. It intentionally
// does NOT hand-maintain a second list of tab ids to compare against -
// loadActiveTab() itself IS the real, authoritative navigation dispatch
// (a menu item that isn't dispatched there can never actually render), so
// this reads app.js's own source and extracts the real ids directly from
// it, the same source-pattern-guard convention already used by
// organization-panel-cache.test.mjs/builder-drafts-view-cache.test.mjs for
// app.js-only glue that can't be imported directly (app.js runs init() -
// full DOM/session/network wiring - at module-import time).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appJsSource = await readFile(path.resolve(__dirname, "../app.js"), "utf8");

function loadActiveTabBody() {
  const marker = "async function loadActiveTab()";
  const start = appJsSource.indexOf(marker);
  if (start < 0) return null;
  const bodyOpen = appJsSource.indexOf("{", start + marker.length - 1);
  let depth = 0;
  for (let i = bodyOpen; i < appJsSource.length; i += 1) {
    if (appJsSource[i] === "{") depth += 1;
    else if (appJsSource[i] === "}") {
      depth -= 1;
      if (depth === 0) return appJsSource.slice(bodyOpen, i + 1);
    }
  }
  return null;
}

// Every `if (state.activeTab === "xxx") return ...` branch is an explicit,
// real menu id. The function's final line is an unconditional fallback
// (`return loadExercises(...)`) rather than an `if` check - i.e. "exercises"
// is real but never appears as a literal `state.activeTab === "exercises"`
// string - so it's added separately below instead of via the regex, without
// hand-listing any of the OTHER ids the regex already finds on its own.
const FALLBACK_TAB_ID = "exercises";

test("loadActiveTab() must still exist and dispatch on state.activeTab", () => {
  const body = loadActiveTabBody();
  assert.ok(body, "loadActiveTab() must still exist in app.js - if this fails, the extraction below needs updating, not menu-cache-policy.js");
  assert.ok(body.includes('return loadExercises('), "the trailing unconditional fallback branch must still exist and still be Exercise Library - if this changed, FALLBACK_TAB_ID above must be updated too");
});

test("every real state.activeTab id dispatched by loadActiveTab() has an explicit entry in MENU_CACHE_POLICIES", () => {
  const body = loadActiveTabBody();
  const matches = [...body.matchAll(/state\.activeTab === "([^"]+)"/g)].map((m) => m[1]);
  const realTabIds = new Set([...matches, FALLBACK_TAB_ID]);
  assert.ok(realTabIds.size >= 9, "sanity check: loadActiveTab should dispatch at least the known 9-10 tabs - if this is lower, the regex/extraction broke, not the registry");

  const missing = [...realTabIds].filter((id) => !Object.prototype.hasOwnProperty.call(MENU_CACHE_POLICIES, id));
  assert.deepEqual(missing, [], `every menu item loadActiveTab() actually dispatches to must have an explicit cache policy in menu-cache-policy.js - missing: ${missing.join(", ")}`);
});

test("every MENU_CACHE_POLICIES entry declares a valid policy and, for \"cached\"/\"local-draft\", a namespace", () => {
  const validPolicies = new Set(["cached", "always-refresh", "local-draft", "static"]);
  for (const [id, entry] of Object.entries(MENU_CACHE_POLICIES)) {
    assert.ok(validPolicies.has(entry.policy), `${id}: policy "${entry.policy}" is not one of cached/always-refresh/local-draft/static`);
    assert.ok(entry.rationale && entry.rationale.length > 10, `${id}: must carry a real rationale, not a placeholder`);
    if (entry.policy === "cached" || entry.policy === "local-draft") {
      assert.ok(entry.namespace, `${id}: policy "${entry.policy}" must declare a cache namespace`);
    }
  }
});

test("Builder is explicitly local-draft, never plain \"cached\" - an open draft must never be silently refetched/overwritten on re-entry (see builder-drafts-view-cache.test.mjs tests 3 and 7 for the actual behavioral proof)", () => {
  assert.equal(MENU_CACHE_POLICIES.builder.policy, "local-draft");
  assert.equal(MENU_CACHE_POLICIES.builder.namespace, "builderDrafts");
});

test("Calendar (weekly) is registered as cached under the weekly namespace", () => {
  assert.equal(MENU_CACHE_POLICIES.weekly.policy, "cached");
  assert.equal(MENU_CACHE_POLICIES.weekly.namespace, "weekly");
});

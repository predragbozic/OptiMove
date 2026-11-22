import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Production: an athlete's Calendar (screen "weekly") reported a lost answer (no_response) and then an unhandled
// rejection (TypeError). The weekly loader itself was already safe; what was left: "Open training" from the athlete's
// calendar went on to draw a blank week over the error line the loader had just shown, and three async listeners
// (submit, change, global submit) were the only ones not wrapped in guardHandler, so a rejection there was never caught.

const { loadWeekly } = await import("../weekly-data.js");
const { state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

function signedInAthlete() {
  clearAllViewCache();
  state.currentUser = { id: "u1", activeWorkspace: { type: "athlete", scopeId: null } };
  state.selectedAthleteId = "athlete-1";
  state.lastWeeklyData = null;
  state.viewedWeekStart = "";
  state.navStack = [];
}

test("1. a lost answer with nothing cached ends in the error line, tells the caller so, and leaks no rejection", async () => {
  signedInAthlete();
  const leaks = [];
  const onLeak = (reason) => leaks.push(reason);
  process.on("unhandledRejection", onLeak);
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  const errors = [];
  const roots = [];
  try {
    const result = await loadWeekly({
      setLoading: () => {}, renderEmpty: () => {}, renderAthleteHeader: () => {},
      renderError: (error) => errors.push(error.message),
      renderWeeklyRoot: (data) => roots.push(data),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(result?.outcome, "error", "the caller can tell the load failed");
  } finally {
    process.off("unhandledRejection", onLeak);
  }
  assert.deepEqual(errors, ["Failed to fetch"]);
  assert.deepEqual(roots, [], "no week is drawn");
  assert.deepEqual(leaks, []);
});

const appJs = readFileSync(fileURLToPath(new URL("../app.js", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const sourceOf = (start) => {
  const from = appJs.indexOf(start);
  assert.ok(from >= 0, start);
  return appJs.slice(from, appJs.indexOf("\n}\n", from) + 2);
};

function openWeeklyHarness(loadOutcome) {
  const calls = [];
  const scope = {
    state,
    loadWeekly: async () => { calls.push("loadWeekly"); return loadOutcome; },
    renderWeeklyRoot: () => calls.push("renderWeeklyRoot"),
    weekIndexForDate: () => -1,
    weekMondayIso: (date) => date,
    monthStartIso: (date) => date,
  };
  const proxy = new Proxy(scope, {
    has: (target, key) => typeof key === "string" && (key in target || !(key in globalThis)),
    get: (target, key) => (key in target ? target[key] : typeof key === "string" ? () => undefined : undefined),
  });
  // eslint-disable-next-line no-new-func
  const { openWeeklyPlanOnDate } = new Function("scope", `with (scope) { ${sourceOf("async function openWeeklyPlanOnDate(")}\nreturn { openWeeklyPlanOnDate }; }`)(proxy);
  return { openWeeklyPlanOnDate, calls };
}

test("2. Open training after a failed load leaves the error line: no blank week is drawn over it", async () => {
  state.activeTab = "athlete-calendar";
  const failed = openWeeklyHarness({ outcome: "error" });
  await failed.openWeeklyPlanOnDate("2026-11-19");
  assert.deepEqual(failed.calls, ["loadWeekly"], "the week is not rendered over the error");
  state.activeTab = "athlete-calendar";
  const loaded = openWeeklyHarness({ outcome: "loaded" });
  await loaded.openWeeklyPlanOnDate("2026-11-19");
  assert.deepEqual(loaded.calls, ["loadWeekly", "renderWeeklyRoot"], "a good load still lands on the day");
  assert.equal(state.selectedWeekDay, "2026-11-19");
});

test("3. the async submit and change listeners are wrapped like the click ones, so a rejection is reported, not left unhandled", () => {
  for (const [event, handler] of [["submit", "handleContentSubmit"], ["change", "handleContentChange"]]) {
    assert.ok(appJs.includes(`els.content.addEventListener("${event}", guardHandler(${handler}));`), `${handler} is guarded`);
  }
  assert.ok(appJs.includes('document.addEventListener("submit", guardHandler(handleGlobalSubmit));'), "handleGlobalSubmit is guarded");
});

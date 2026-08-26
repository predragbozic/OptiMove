// Item 2 correction: the athlete device-timezone report (POST /api/tests/
// athlete/timezone) must complete BEFORE the first athlete Tests/Today
// request that can trigger server-side materialization (GET /athlete/
// today, coach Today, check-in's my-assignment) - otherwise that GET can
// materialize an assignment using the stale/fallback timezone, permanently
// snapshotting the wrong one (see the DB-enforced immutability trigger in
// migrations_v2/202608300900_..._phase4_assignment_timezone_window.sql).
// A failed report must still never block the app. See tests-data.js's
// reportDeviceTimezone for the full reasoning.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = {
  body: { classList: { contains: (cls) => cls === "athlete-mode" } },
  querySelector: () => null,
  querySelectorAll: () => [],
};

// reportDeviceTimezone() de-dupes by the ACTUAL resolved timezone value
// within one module session (globalThis.Intl is never reset between
// tests) - each test below fakes a DISTINCT timezone string so every test
// genuinely exercises a real POST attempt, never a cache hit left over
// from an earlier test in this same file.
function withFakeTimezone(tz, fn) {
  const original = globalThis.Intl;
  globalThis.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: tz }) }) };
  return Promise.resolve()
    .then(fn)
    .finally(() => { globalThis.Intl = original; });
}

const { loadTests, reportDeviceTimezone } = await import("../tests-data.js");
const { state, emptyTestsState } = await import("../state.js");

function resetState() {
  state.tests = emptyTestsState();
  state.athletes = [];
}

test("1. the timezone POST is awaited BEFORE the athlete Today GET fires, even when the POST is deliberately held", async () => {
  resetState();
  const callOrder = [];
  let releaseTimezonePost;
  const held = new Promise((resolve) => { releaseTimezonePost = resolve; });
  globalThis.fetch = async (url) => {
    if (url.includes("/api/tests/athlete/timezone")) {
      callOrder.push("timezone-post-started");
      await held;
      callOrder.push("timezone-post-resolved");
      return { ok: true, status: 200, json: async () => ({ ok: true, timezone: "Pacific/Kiritimati-test1" }) };
    }
    if (url.includes("/api/tests/athlete/today")) {
      callOrder.push("today-get");
      return { ok: true, status: 200, json: async () => ({ assignments: [] }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  state.tests.section = "today";
  const loadPromise = withFakeTimezone("Pacific/Kiritimati-test1", () => loadTests({ renderTests: () => {} }));

  // Let the timezone POST actually start, but never let it resolve yet -
  // if the Today GET fired before we release it, it would already be in
  // callOrder here.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(callOrder, ["timezone-post-started"], "the Today GET must NOT have fired yet - it's still waiting on the held timezone POST");

  releaseTimezonePost();
  await loadPromise;

  assert.deepEqual(
    callOrder,
    ["timezone-post-started", "timezone-post-resolved", "today-get"],
    "Today GET must only fire AFTER the timezone POST resolves, in exactly this order",
  );
});

test("2. a FAILED timezone POST never blocks the app - Today still loads normally on the schedule's fallback", async () => {
  resetState();
  const callOrder = [];
  globalThis.fetch = async (url) => {
    if (url.includes("/api/tests/athlete/timezone")) {
      callOrder.push("timezone-post-failed");
      return { ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({ error: "boom" }) };
    }
    if (url.includes("/api/tests/athlete/today")) {
      callOrder.push("today-get");
      return { ok: true, status: 200, json: async () => ({ assignments: [] }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  state.tests.section = "today";
  await withFakeTimezone("Asia/Dubai-test2", () => loadTests({ renderTests: () => {} }));

  assert.deepEqual(callOrder, ["timezone-post-failed", "today-get"], "Today must still load even though the timezone report failed");
  assert.equal(state.tests.error, "", "a failed timezone report must never surface as a Tests-tab error banner");
});

test("3. repeated calls with the SAME resolved timezone never re-POST within one session", async () => {
  resetState();
  let postCount = 0;
  globalThis.fetch = async (url) => {
    if (url.includes("/api/tests/athlete/timezone")) {
      postCount += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ assignments: [] }) };
  };

  await withFakeTimezone("Europe/Belgrade-test3", () => reportDeviceTimezone());
  await withFakeTimezone("Europe/Belgrade-test3", () => reportDeviceTimezone());
  await withFakeTimezone("Europe/Belgrade-test3", () => reportDeviceTimezone());

  assert.equal(postCount, 1, "the same timezone value must only ever be POSTed once per session, no matter how many times it's reported");
});

test("4. a DIFFERENT resolved timezone (device timezone genuinely changed) does trigger a new POST", async () => {
  resetState();
  const posted = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.includes("/api/tests/athlete/timezone")) {
      posted.push(JSON.parse(options.body).timezone);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ assignments: [] }) };
  };

  await withFakeTimezone("America/Los_Angeles-test4", () => reportDeviceTimezone());
  await withFakeTimezone("Pacific/Auckland-test4", () => reportDeviceTimezone());

  assert.deepEqual(posted, ["America/Los_Angeles-test4", "Pacific/Auckland-test4"]);
});

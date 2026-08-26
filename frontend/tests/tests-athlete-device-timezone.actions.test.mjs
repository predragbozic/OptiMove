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

// Round 3 hardening (item 3): reportDeviceTimezone() no longer de-dupes at
// all (globalThis.Intl is never reset between tests, and there is no more
// session cache to reset either) - each test below still fakes a DISTINCT
// timezone string per test purely so assertions can tell one test's POSTs
// apart from another's, not because a shared cache would otherwise leak
// between them.
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

test("3. repeated calls with the SAME resolved timezone always POST again - round 3 removed the session cache entirely (correctness over dedup: no reliable per-account identity exists at every call site, e.g. check-in-actions.js never populates state.currentUser - see reportDeviceTimezone's own header)", async () => {
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

  assert.equal(postCount, 3, "every call must POST - the backend's own IS DISTINCT FROM guard (tests.js's POST /athlete/timezone), not a frontend cache, is what avoids an unnecessary DB write for an unchanged value");
});

test("4. two consecutive athlete accounts on the SAME browser session, reporting the SAME timezone value, both genuinely POST - the bug a stale session-keyed-by-value-only cache used to cause (athlete A logs out, athlete B logs in on the same device/zone, B's own report gets silently skipped because the cached string still matches A's)", async () => {
  resetState();
  const posted = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.includes("/api/tests/athlete/timezone")) {
      posted.push(JSON.parse(options.body).timezone);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ assignments: [] }) };
  };

  // Athlete A's own session bootstrap.
  await withFakeTimezone("Europe/Belgrade-test5", () => reportDeviceTimezone());
  // Athlete A logs out, athlete B logs in on the SAME device, in the SAME
  // real timezone - this module's own state was never reset by a logout in
  // production either (there is no more cache to reset now), so this is
  // exactly the scenario the bug lived in: the SAME resolved timezone
  // string, reported again, for a genuinely different account.
  await withFakeTimezone("Europe/Belgrade-test5", () => reportDeviceTimezone());

  assert.deepEqual(posted, ["Europe/Belgrade-test5", "Europe/Belgrade-test5"], "both accounts' own reports must genuinely reach the backend - never silently skipped because the value happened to match a previous account's");
});

test("5. a DIFFERENT resolved timezone (device timezone genuinely changed) does trigger a new POST", async () => {
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

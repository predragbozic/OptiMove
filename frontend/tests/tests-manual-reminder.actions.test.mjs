// Mobile scheduling hotfix, items 4-6: Coach Today's manual reminder UI
// (checkbox list of not-yet-completed athletes, Select all/Clear, Send
// reminder (N), Copy for Viber) - frontend state/action logic. Same
// minimal-DOM-double pattern as tests-schedule-management.actions.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

let queried = {};
globalThis.document = {
  querySelector: (sel) => queried[sel] || null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = { confirm: () => true, location: { origin: "http://localhost" } };
// Node's own built-in `navigator` global (Node 24+) is a getter-only
// property on globalThis - a bare assignment throws. Override it properly
// so each test can still swap in its own clipboard.writeText spy.
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true, writable: true });

let fetchCalls;
function installFetchMock(responder) {
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    fetchCalls.push(call);
    const result = await responder(call);
    return { ok: result.status < 300, status: result.status, json: async () => result.body };
  };
}

const { handleTestsAction } = await import("../tests-actions.js");
const { assignmentSetFingerprint, incompleteAthletesFor, remindableAthletesFor, reminderSelectedSet } = await import("../tests-view.js");
const { emptyTestsState, state } = await import("../state.js");

function fakeAction(dataset) {
  return { dataset };
}

function makeGroup(scheduleId, athletes) {
  return {
    schedule: { id: scheduleId, testName: "WELLNESS", opensTime: "00:00", closesTime: "23:59" },
    anyOpen: true,
    allClosed: false,
    counts: { total: athletes.length, completed: athletes.filter((a) => a.status === "completed").length, missed: 0, pending: athletes.length, injuries: 0 },
    athletes,
  };
}

function resetState() {
  state.tests = emptyTestsState();
  state.tests.coachToday = [];
  queried = {};
}

// Item 3 correction: reminderSelectedSet's own DEFAULT selection now
// requires an athlete's assignment to be CURRENTLY inside its own
// opens_at/closes_at window (never just "incomplete") - these fixtures
// need a real, currently-open window for that default to still include
// them, matching what a real live/open Coach Today session actually looks
// like. window() below is deliberately Date.now()-anchored, not a fixed
// literal, so this file never goes stale.
function window_() {
  return { opensAt: new Date(Date.now() - 3600000).toISOString(), closesAt: new Date(Date.now() + 3600000).toISOString() };
}

const ATHLETES = [
  { assignmentId: "asg-1", athleteId: "ath-1", athleteName: "Ana Anić", status: "pending", wellnessScore: null, injury: false, ...window_() },
  { assignmentId: "asg-2", athleteId: "ath-2", athleteName: "Bojan Bojić", status: "pending", wellnessScore: null, injury: false, ...window_() },
  { assignmentId: "asg-3", athleteId: "ath-3", athleteName: "Cvijeta Cvić", status: "completed", wellnessScore: 5, injury: false, ...window_() },
];

// ------------------------------------------------------------
// 1. Only incomplete athletes appear as candidates
// ------------------------------------------------------------

test("incompleteAthletesFor excludes completed athletes - the checkbox list only ever offers not-yet-completed rows", () => {
  const group = makeGroup("sched-1", ATHLETES);
  const incomplete = incompleteAthletesFor(group);
  assert.deepEqual(incomplete.map((a) => a.assignmentId), ["asg-1", "asg-2"]);
});

test("reminderSelectedSet defaults to every incomplete athlete when no explicit selection exists yet", () => {
  resetState();
  const group = makeGroup("sched-1", ATHLETES);
  const selected = reminderSelectedSet(group);
  assert.deepEqual([...selected].sort(), ["asg-1", "asg-2"]);
});

// ------------------------------------------------------------
// 2. Toggling / select-all / clear
// ------------------------------------------------------------

test("toggling one athlete off leaves the rest of the default selection intact (materializes the implicit default into an explicit override, stamped with the current fingerprint)", async () => {
  resetState();
  const group = makeGroup("sched-1", ATHLETES);
  state.tests.coachToday = [group];
  await handleTestsAction(fakeAction({ action: "tests-reminder-toggle-athlete", scheduleId: "sched-1", assignmentId: "asg-1" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.reminderSelection["sched-1"], { fingerprint: assignmentSetFingerprint(group), ids: ["asg-2"] });
});

test("toggling an athlete back on restores them", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", ATHLETES)];
  await handleTestsAction(fakeAction({ action: "tests-reminder-toggle-athlete", scheduleId: "sched-1", assignmentId: "asg-1" }), { renderTests: () => {} });
  await handleTestsAction(fakeAction({ action: "tests-reminder-toggle-athlete", scheduleId: "sched-1", assignmentId: "asg-1" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.reminderSelection["sched-1"].ids.sort(), ["asg-1", "asg-2"]);
});

test("Clear empties the selection, Select all restores every incomplete athlete", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", ATHLETES)];
  await handleTestsAction(fakeAction({ action: "tests-reminder-clear", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.reminderSelection["sched-1"].ids, []);
  await handleTestsAction(fakeAction({ action: "tests-reminder-select-all", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.reminderSelection["sched-1"].ids.sort(), ["asg-1", "asg-2"]);
});

// ------------------------------------------------------------
// 2c. Correction: reminder ELIGIBILITY (not completed, appropriate
// status, currently inside its own opens_at/closes_at window) must be
// enforced everywhere - default selection, stored-selection intersection,
// manual toggle, Select all, Send, and Copy for Viber - not just the
// default. Previously only the default selection was window-gated: a
// manual click, Select all, or a stored selection carried over from an
// earlier interaction could all still re-arm Send/Copy for a future or
// already-closed assignment.
// ------------------------------------------------------------

function futureWindow() {
  return { opensAt: new Date(Date.now() + 3600000).toISOString(), closesAt: new Date(Date.now() + 7200000).toISOString() };
}
function closedWindow() {
  return { opensAt: new Date(Date.now() - 7200000).toISOString(), closesAt: new Date(Date.now() - 3600000).toISOString() };
}

const MIXED_ATHLETES = [
  { assignmentId: "asg-open", athleteId: "ath-open", athleteName: "Open Ana", status: "pending", wellnessScore: null, injury: false, ...window_() },
  { assignmentId: "asg-future", athleteId: "ath-future", athleteName: "Future Bojan", status: "pending", wellnessScore: null, injury: false, ...futureWindow() },
  { assignmentId: "asg-closed", athleteId: "ath-closed", athleteName: "Closed Cvijeta", status: "pending", wellnessScore: null, injury: false, ...closedWindow() },
];

test("remindableAthletesFor excludes a not-yet-open and an already-closed assignment, keeping only the currently-open one", () => {
  const group = makeGroup("sched-1", MIXED_ATHLETES);
  const remindable = remindableAthletesFor(group);
  assert.deepEqual(remindable.map((a) => a.assignmentId), ["asg-open"]);
});

test("a manual click can never select a NOT-YET-OPEN (future) assignment - toggling it is a silent no-op", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", MIXED_ATHLETES)];
  await handleTestsAction(fakeAction({ action: "tests-reminder-toggle-athlete", scheduleId: "sched-1", assignmentId: "asg-future" }), { renderTests: () => {} });
  assert.ok(!state.tests.reminderSelection["sched-1"], "toggling a non-remindable assignment must not even create a stored selection");
});

test("a manual click can never select an ALREADY-CLOSED assignment either", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", MIXED_ATHLETES)];
  await handleTestsAction(fakeAction({ action: "tests-reminder-toggle-athlete", scheduleId: "sched-1", assignmentId: "asg-closed" }), { renderTests: () => {} });
  assert.ok(!state.tests.reminderSelection["sched-1"]);
});

test("Select all only ever selects the currently-remindable subset, never a future or closed assignment", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", MIXED_ATHLETES)];
  await handleTestsAction(fakeAction({ action: "tests-reminder-select-all", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.reminderSelection["sched-1"].ids, ["asg-open"]);
});

test("a previously-stored selection that included a since-closed/not-yet-open assignment drops it on the next resolve, without a new interaction", () => {
  resetState();
  const group = makeGroup("sched-1", MIXED_ATHLETES);
  // Coach had explicitly selected all three at some earlier point (the
  // fingerprint matches the CURRENT set of assignment ids - only their
  // windows have since changed, e.g. time has simply passed).
  state.tests.reminderSelection["sched-1"] = { fingerprint: assignmentSetFingerprint(group), ids: ["asg-open", "asg-future", "asg-closed"] };
  const selected = reminderSelectedSet(group);
  assert.deepEqual([...selected], ["asg-open"], "the stored selection must be intersected with the CURRENT remindable set, not merely the incomplete set");
});

test("Send reminder can never include a future/closed assignment even if it somehow made it into the stored selection", async () => {
  resetState();
  const group = makeGroup("sched-1", MIXED_ATHLETES);
  state.tests.coachToday = [group];
  state.tests.reminderSelection["sched-1"] = { fingerprint: assignmentSetFingerprint(group), ids: ["asg-open", "asg-future", "asg-closed"] };
  installFetchMock((call) => {
    if (call.url === "/api/tests/schedules/sched-1/remind") return { status: 200, body: { results: [{ assignmentId: "asg-open", outcome: "notified" }], notifiedCount: 1, noUserCount: 0 } };
    return { status: 404, body: {} };
  });
  await handleTestsAction(fakeAction({ action: "tests-send-reminder", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.deepEqual(fetchCalls[0].body.assignmentIds, ["asg-open"]);
});

test("Copy for Viber can never include a future/closed assignment's name even if it somehow made it into the stored selection", async () => {
  resetState();
  const group = makeGroup("sched-1", MIXED_ATHLETES);
  state.tests.coachToday = [group];
  state.tests.reminderSelection["sched-1"] = { fingerprint: assignmentSetFingerprint(group), ids: ["asg-open", "asg-future", "asg-closed"] };
  let copied = "";
  globalThis.navigator.clipboard.writeText = async (text) => { copied = text; };
  installFetchMock((call) => {
    if (call.url === "/api/tests/schedules/sched-1") return { status: 200, body: { link: { id: "link-1", publicToken: "TOKEN123" } } };
    return { status: 404, body: {} };
  });
  await handleTestsAction(fakeAction({ action: "tests-copy-viber", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.ok(copied.includes("Open Ana"));
  assert.ok(!copied.includes("Future Bojan") && !copied.includes("Closed Cvijeta"));
});

// ------------------------------------------------------------
// 2b. Item 4 correction: staleness - fingerprint-based reset
// ------------------------------------------------------------

test("Clear stays genuinely empty across re-renders of the SAME assignment set - never silently reverts to select-all", () => {
  resetState();
  const group = makeGroup("sched-1", ATHLETES);
  state.tests.reminderSelection["sched-1"] = { fingerprint: assignmentSetFingerprint(group), ids: [] };
  assert.deepEqual(reminderSelectedSet(group), new Set());
});

test("a daily schedule's NEW day (same scheduleId, entirely different assignment ids) discards yesterday's selection and defaults to today's own incomplete athletes", () => {
  resetState();
  const yesterday = makeGroup("daily-sched", ATHLETES);
  // Coach explicitly narrowed yesterday's selection to just one athlete.
  state.tests.reminderSelection["daily-sched"] = { fingerprint: assignmentSetFingerprint(yesterday), ids: ["asg-2"] };

  // Today's occurrence: SAME scheduleId, brand-new assignment ids (a real
  // daily-schedule rollover - see testsOccurrenceService.js).
  const today = makeGroup("daily-sched", [
    { assignmentId: "asg-101", athleteId: "ath-1", athleteName: "Ana Anić", status: "pending", wellnessScore: null, injury: false, ...window_() },
    { assignmentId: "asg-102", athleteId: "ath-2", athleteName: "Bojan Bojić", status: "pending", wellnessScore: null, injury: false, ...window_() },
  ]);
  const selected = reminderSelectedSet(today);
  assert.deepEqual([...selected].sort(), ["asg-101", "asg-102"], "yesterday's stale ids must never leak into today's count/POST - must default to today's own incomplete athletes");
});

test("an athlete who completes their check-in AFTER a selection was made drops out of it immediately, without a new interaction", () => {
  resetState();
  const beforeCompletion = makeGroup("sched-1", ATHLETES);
  // Coach explicitly selected BOTH incomplete athletes.
  state.tests.reminderSelection["sched-1"] = { fingerprint: assignmentSetFingerprint(beforeCompletion), ids: ["asg-1", "asg-2"] };

  // asg-1's athlete completes their check-in - a fresh Today load reflects
  // this as a status change on the SAME assignment id (not a new id), so
  // the fingerprint (built from ALL assignment ids, not just incomplete
  // ones) stays the SAME, but the athlete must still drop out.
  const afterCompletion = makeGroup("sched-1", [
    { ...ATHLETES[0], status: "completed" },
    ATHLETES[1],
    ATHLETES[2],
  ]);
  const selected = reminderSelectedSet(afterCompletion);
  assert.deepEqual([...selected], ["asg-2"], "the now-completed athlete must never remain counted/selected");
});

test("a stale selection with NO overlap at all against the current incomplete set (e.g. everyone since completed) correctly shows zero selected, not a crash", () => {
  resetState();
  const group = makeGroup("sched-1", ATHLETES);
  state.tests.reminderSelection["sched-1"] = { fingerprint: assignmentSetFingerprint(group), ids: ["asg-1", "asg-2"] };
  const allCompleted = makeGroup("sched-1", [
    { ...ATHLETES[0], status: "completed" },
    { ...ATHLETES[1], status: "completed" },
    ATHLETES[2],
  ]);
  assert.deepEqual(reminderSelectedSet(allCompleted), new Set());
});

// ------------------------------------------------------------
// 3. Send reminder - only selected ids, double-click guard, confirmation message
// ------------------------------------------------------------

test("Send reminder posts ONLY the currently selected assignment ids, never the full incomplete list if narrowed", async () => {
  resetState();
  const group = makeGroup("sched-1", ATHLETES);
  state.tests.coachToday = [group];
  state.tests.reminderSelection["sched-1"] = { fingerprint: assignmentSetFingerprint(group), ids: ["asg-2"] };
  installFetchMock((call) => {
    if (call.url === "/api/tests/schedules/sched-1/remind") return { status: 200, body: { results: [{ assignmentId: "asg-2", outcome: "notified" }], notifiedCount: 1, noUserCount: 0 } };
    return { status: 404, body: {} };
  });
  await handleTestsAction(fakeAction({ action: "tests-send-reminder", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(fetchCalls[0].body.assignmentIds, ["asg-2"]);
});

test("the confirmation message matches the exact required format, including the no-account count", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", ATHLETES)];
  installFetchMock(() => ({ status: 200, body: { results: [], notifiedCount: 8, noUserCount: 1 } }));
  await handleTestsAction(fakeAction({ action: "tests-send-reminder", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.equal(state.tests.reminderResult.message, "Reminder sent to 8 athletes. 1 athlete has no app account.");
});

test("a zero-no-account result omits the second sentence entirely", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", ATHLETES)];
  installFetchMock(() => ({ status: 200, body: { results: [], notifiedCount: 3, noUserCount: 0 } }));
  await handleTestsAction(fakeAction({ action: "tests-send-reminder", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.equal(state.tests.reminderResult.message, "Reminder sent to 3 athletes.");
});

test("item 6: a 0-notified result still explains WHY when rows were skipped for cooldown - never a bare 'Reminder sent to 0 athletes.'", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", ATHLETES)];
  installFetchMock(() => ({
    status: 200,
    body: {
      results: [{ assignmentId: "asg-1", outcome: "skippedCooldown" }, { assignmentId: "asg-2", outcome: "skippedCooldown" }],
      notifiedCount: 0, noUserCount: 0,
    },
  }));
  await handleTestsAction(fakeAction({ action: "tests-send-reminder", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.equal(state.tests.reminderResult.message, "Reminder sent to 0 athletes. 2 already reminded in the last few minutes.");
});

test("item 6: a 0-notified result explains WHY when rows were skipped for being outside their own window (closed or not yet open)", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", ATHLETES)];
  installFetchMock(() => ({
    status: 200,
    body: {
      results: [{ assignmentId: "asg-1", outcome: "skippedClosed" }, { assignmentId: "asg-2", outcome: "skippedNotOpen" }],
      notifiedCount: 0, noUserCount: 0,
    },
  }));
  await handleTestsAction(fakeAction({ action: "tests-send-reminder", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.equal(state.tests.reminderResult.message, "Reminder sent to 0 athletes. 2 outside their own open check-in window.");
});

test("double-click guard: a second Send reminder click while one is already in flight makes no second request", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", ATHLETES)];
  let releaseFirst;
  const held = new Promise((resolve) => { releaseFirst = resolve; });
  installFetchMock(async () => {
    await held;
    return { status: 200, body: { results: [], notifiedCount: 2, noUserCount: 0 } };
  });
  const firstCall = handleTestsAction(fakeAction({ action: "tests-send-reminder", scheduleId: "sched-1" }), { renderTests: () => {} });
  // The button must already be in its "sending" (disabled) state before the
  // first request resolves - a second click routed through the SAME
  // handler while remindingScheduleId is already set must be a no-op.
  await Promise.resolve();
  assert.equal(state.tests.remindingScheduleId, "sched-1");
  await handleTestsAction(fakeAction({ action: "tests-send-reminder", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.equal(fetchCalls.length, 1, "the second (double-click) call must never fire a real request while one is already in flight");
  releaseFirst();
  await firstCall;
  assert.equal(state.tests.remindingScheduleId, "", "the guard must clear once the request settles");
});

test("a failed send surfaces the error message and still clears the sending guard", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", ATHLETES)];
  installFetchMock(() => ({ status: 400, body: { error: "This schedule is paused - athletes can't submit right now, so a reminder would be pointless." } }));
  await handleTestsAction(fakeAction({ action: "tests-send-reminder", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.equal(state.tests.reminderResult.message, "This schedule is paused - athletes can't submit right now, so a reminder would be pointless.");
  assert.equal(state.tests.remindingScheduleId, "");
});

// ------------------------------------------------------------
// 4. Copy for Viber - exact text with names + real link
// ------------------------------------------------------------

test("Copy for Viber copies the exact required message shape with the selected athletes' real names and a real group link", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", ATHLETES)];
  let copied = "";
  globalThis.navigator.clipboard.writeText = async (text) => { copied = text; };
  installFetchMock((call) => {
    if (call.url === "/api/tests/schedules/sched-1") return { status: 200, body: { link: { id: "link-1", publicToken: "TOKEN123" } } };
    return { status: 404, body: {} };
  });
  await handleTestsAction(fakeAction({ action: "tests-copy-viber", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.equal(copied, "WELLNESS još nisu popunili: Ana Anić, Bojan Bojić. Molimo popunite anketu: http://localhost/tests/check-in/TOKEN123");
});

test("Copy for Viber creates a group link via the existing secure mechanism when none exists yet", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", ATHLETES)];
  let copied = "";
  globalThis.navigator.clipboard.writeText = async (text) => { copied = text; };
  installFetchMock((call) => {
    if (call.url === "/api/tests/schedules/sched-1" && call.method === "GET") return { status: 200, body: { link: null } };
    if (call.url === "/api/tests/schedules/sched-1/link" && call.method === "POST") return { status: 201, body: { link: { id: "link-2", publicToken: "FRESHTOKEN" } } };
    return { status: 404, body: {} };
  });
  await handleTestsAction(fakeAction({ action: "tests-copy-viber", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.ok(copied.includes("http://localhost/tests/check-in/FRESHTOKEN"), "must have created and used the fresh link");
  assert.ok(fetchCalls.some((c) => c.url === "/api/tests/schedules/sched-1/link" && c.method === "POST"));
});

test("Copy for Viber falls back to a linkless message (never a fabricated public URL) when the link mechanism is unavailable", async () => {
  resetState();
  state.tests.coachToday = [makeGroup("sched-1", ATHLETES)];
  let copied = "";
  globalThis.navigator.clipboard.writeText = async (text) => { copied = text; };
  installFetchMock(() => { throw new Error("network down"); });
  await handleTestsAction(fakeAction({ action: "tests-copy-viber", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.equal(copied, "WELLNESS još nisu popunili: Ana Anić, Bojan Bojić.");
  assert.ok(!copied.includes("http"), "must never fabricate a link");
});

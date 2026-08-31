// Training load (RPE/sRPE), first complete phase - frontend state/action
// logic. Same minimal-DOM-double pattern as tests-weekly-calendar.actions.
// test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

let queried = {};
globalThis.document = {
  querySelector: (sel) => queried[sel] || null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

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

// Deferred-resolution mock, same shape as tests-weekly-calendar.actions.
// test.mjs's installDeferredFetchMock - for deterministic request-race
// tests (rapid week-nav / rapid filter change).
function installDeferredFetchMock() {
  const deferreds = [];
  fetchCalls = [];
  globalThis.fetch = (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    fetchCalls.push(call);
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    deferreds.push({ call, resolve: (result) => resolve({ ok: result.status < 300, status: result.status, json: async () => result.body }) });
    return promise;
  };
  return deferreds;
}

const { handleTrainingLoadAction, resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
const { loadTrainingLoadWeekly, loadPlannedRpeSetting } = await import("../training-load-data.js");
const {
  formatFeedbackSummary,
  formatSrpe,
  renderTrainingLoadHomeCardHtml,
  renderTrainingLoadResultsHtml,
  renderTrainingLoadScheduleHtml,
  renderTrainingLoadTodayHtml,
  renderTrainingLoadSessionListHtml,
  renderTrainingLoadFilterPickerHtml,
  renderRpeFormHtml,
  renderExternalScheduleFormHtml,
  renderPlannedRpeMasterToggleHtml,
  isRpeFormValid,
  externalScheduleSubmitDisabled,
  externalScheduleSubmitLabel,
} = await import("../training-load-view.js");
const { emptyTrainingLoadState, emptyRpeForm, emptyExternalScheduleForm, state } = await import("../state.js");

function fakeAction(dataset, value) {
  return { dataset, value };
}

function resetState() {
  state.trainingLoad = emptyTrainingLoadState();
  state.athletes = [];
  queried = {};
}

let renderCount;
function renderTrainingLoad() {
  renderCount += 1;
}

function weekPayload(weekStart, sessionsByDate = {}) {
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(`${weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    days.push({ date, sessions: sessionsByDate[date] || [] });
  }
  const end = new Date(`${weekStart}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return { weekStart, weekEnd: end.toISOString().slice(0, 10), days };
}

function session(overrides = {}) {
  const merged = {
    sessionId: "sess-1",
    sessionName: "Session",
    amPm: "AM",
    bta: "",
    sessionTime: "08:00:00",
    planId: "plan-1",
    planName: "Weekly plan",
    athleteId: "ath-1",
    athleteName: "Ana Anić",
    rated: false,
    feedback: null,
    historical: false,
    rpeEnabled: true,
    // (v9) workspace master toggle - defaults to "on" so every EXISTING
    // fixture/test that never mentions it keeps behaving exactly like a
    // normal, actionable planned session.
    workspacePlannedRpeEnabled: true,
    source: "planned",
    externalAssignmentId: null,
    scheduleId: null,
    ...overrides,
  };
  // actionable mirrors what the REAL backend always computes it as
  // (rpe_enabled !== false AND workspace_planned_rpe_enabled) UNLESS a
  // test overrides it explicitly - so overriding just rpeEnabled/
  // workspacePlannedRpeEnabled alone (the common case) still produces a
  // consistent, realistic combination, never rpeEnabled:false +
  // actionable:true (impossible from the real backend).
  if (overrides.actionable === undefined) {
    merged.actionable = merged.rpeEnabled !== false && merged.workspacePlannedRpeEnabled !== false;
  }
  return merged;
}

// An RPE session scheduled OUTSIDE any Weekly plan - the mirror-image
// identity shape (externalAssignmentId set, sessionId/planId null).
function externalSession(overrides = {}) {
  return session({
    sessionId: null,
    planId: null,
    planName: null,
    sessionName: "National team camp",
    amPm: "",
    bta: "",
    source: "scheduled_external",
    externalAssignmentId: "asg-1",
    scheduleId: "sched-1",
    // Explicit lifecycle fields GET /weekly now always sends for an
    // external row - an unrated default row is a normal, currently-open
    // request (active schedule, pending assignment).
    scheduleStatus: "active",
    assignmentStatus: "pending",
    actionable: true,
    ...overrides,
  });
}

// ------------------------------------------------------------
// A. Formatting
// ------------------------------------------------------------

test("A1. formatSrpe / formatFeedbackSummary render the exact required format", () => {
  assert.equal(formatSrpe(420), "420 AU");
  assert.equal(formatFeedbackSummary({ rpe: 7, durationMinutes: 60, srpe: 420 }), "RPE 7 · 60 min · sRPE 420 AU");
});

// ------------------------------------------------------------
// B. Athlete Home card - 0 / 1 / >1 unrated sessions
// ------------------------------------------------------------

test("B1. zero unrated sessions renders no card at all - it must disappear once everything is rated", () => {
  const html = renderTrainingLoadHomeCardHtml({ date: "2026-08-24", sessions: [session({ rated: true, feedback: { rpe: 5, durationMinutes: 30, srpe: 150 } })] });
  assert.equal(html, "");
});

test("B2. exactly one unrated session shows a direct 'Rate session' card naming it, with the session id on the action", () => {
  const html = renderTrainingLoadHomeCardHtml({ date: "2026-08-24", sessions: [session({ sessionId: "sess-1", rated: false })] });
  assert.ok(html.includes("Rate session"));
  assert.ok(html.includes('data-session-id="sess-1"'));
  assert.ok(html.includes('data-count="1"'));
});

test("B3. more than one unrated session shows a count and opens a list, never deep-links directly", () => {
  const html = renderTrainingLoadHomeCardHtml({
    date: "2026-08-24",
    sessions: [session({ sessionId: "sess-1" }), session({ sessionId: "sess-2" })],
  });
  assert.ok(html.includes("2 sessions waiting"));
  assert.ok(html.includes("View all"));
  assert.ok(!html.includes("Rate session"));
});

// ------------------------------------------------------------
// C. Athlete: opening the card / list / RPE form
// ------------------------------------------------------------

test("C1. a single-session card click opens the RPE form directly (no intermediate list)", async () => {
  resetState();
  renderCount = 0;
  state.trainingLoad.athleteToday = { date: "2026-08-24", sessions: [session({ sessionId: "sess-1", sessionName: "Tempo run" })], loading: false, error: "" };
  await handleTrainingLoadAction(fakeAction({ action: "training-load-home-card-open", count: "1", sessionId: "sess-1" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.showSessionList, false);
  assert.equal(state.trainingLoad.rpeForm.sessionId, "sess-1");
  assert.equal(state.trainingLoad.rpeForm.sessionName, "Tempo run");
  assert.equal(renderCount, 1);
});

test("C2. a multi-session card click opens the list, not a form", async () => {
  resetState();
  renderCount = 0;
  state.trainingLoad.athleteToday = { date: "2026-08-24", sessions: [session({ sessionId: "sess-1" }), session({ sessionId: "sess-2" })], loading: false, error: "" };
  await handleTrainingLoadAction(fakeAction({ action: "training-load-home-card-open", count: "2" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.showSessionList, true);
  assert.equal(state.trainingLoad.rpeForm, null);
});

test("C3. picking a session from the list opens its RPE form", async () => {
  resetState();
  renderCount = 0;
  state.trainingLoad.athleteToday = { date: "2026-08-24", sessions: [session({ sessionId: "sess-2", sessionName: "Evening lift" })], loading: false, error: "" };
  state.trainingLoad.showSessionList = true;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-open-rpe-form", sessionId: "sess-2" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.showSessionList, false);
  assert.equal(state.trainingLoad.rpeForm.sessionId, "sess-2");
});

// ------------------------------------------------------------
// D. RPE form: validity, live inputs, submit, saved confirmation
// ------------------------------------------------------------

test("D1. the form is invalid with no duration entered, and valid once a real duration is set", () => {
  const form = emptyRpeForm({ sessionId: "sess-1", rpe: 5, durationMinutes: "" });
  assert.equal(isRpeFormValid(form), false);
  form.durationMinutes = 45;
  assert.equal(isRpeFormValid(form), true);
});

test("D2. duration outside 1-600, or a non-integer, is invalid", () => {
  assert.equal(isRpeFormValid(emptyRpeForm({ rpe: 5, durationMinutes: 0 })), false);
  assert.equal(isRpeFormValid(emptyRpeForm({ rpe: 5, durationMinutes: 601 })), false);
  assert.equal(isRpeFormValid(emptyRpeForm({ rpe: 5, durationMinutes: 45.5 })), false);
  assert.equal(isRpeFormValid(emptyRpeForm({ rpe: 5, durationMinutes: 600 })), true);
});

test("D3. the slider input mutates rpe and never triggers a full re-render (targeted DOM patch only)", async () => {
  resetState();
  renderCount = 0;
  state.trainingLoad.rpeForm = emptyRpeForm({ sessionId: "sess-1", rpe: 3, durationMinutes: 30 });
  const sliderBlock = { innerHTML: "" };
  const preview = { innerHTML: "" };
  queried["[data-training-load-slider-block]"] = sliderBlock;
  queried["[data-training-load-srpe-preview]"] = preview;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-rpe-slider-input" }, "8"), { renderTrainingLoad });
  assert.equal(state.trainingLoad.rpeForm.rpe, 8);
  assert.ok(sliderBlock.innerHTML.includes(">8<"), "the slider block itself is patched with the new value");
  assert.ok(preview.innerHTML.includes("240"), "8 x 30 = 240, the live preview is patched too");
  assert.equal(renderCount, 0, "must never fully re-render on a slider drag - that would lose slider focus");
});

test("D4. the duration input updates the live sRPE preview without a full re-render", async () => {
  resetState();
  renderCount = 0;
  state.trainingLoad.rpeForm = emptyRpeForm({ sessionId: "sess-1", rpe: 6, durationMinutes: "" });
  const preview = { innerHTML: "" };
  queried["[data-training-load-srpe-preview]"] = preview;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-rpe-duration-input" }, "50"), { renderTrainingLoad });
  assert.equal(state.trainingLoad.rpeForm.durationMinutes, 50);
  assert.ok(preview.innerHTML.includes("300"));
  assert.equal(renderCount, 0);
});

test("D5. the note input mutates state without any DOM patch or re-render (never fights the user's own cursor)", async () => {
  resetState();
  renderCount = 0;
  state.trainingLoad.rpeForm = emptyRpeForm({ sessionId: "sess-1" });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-rpe-note-input" }, "Felt strong today"), { renderTrainingLoad });
  assert.equal(state.trainingLoad.rpeForm.note, "Felt strong today");
  assert.equal(renderCount, 0);
});

test("D6. submitting sends ONLY rpe/durationMinutes/note - never a client-computed sRPE - and shows the saved confirmation on success", async () => {
  resetState();
  renderCount = 0;
  state.trainingLoad.rpeForm = emptyRpeForm({ sessionId: "sess-1", sessionName: "Tempo run", rpe: 7, durationMinutes: 60, note: "good" });
  installFetchMock((call) => {
    if (call.url === "/api/training-load/sessions/sess-1/rpe") return { status: 201, body: { feedback: { rpe: 7, durationMinutes: 60, srpe: 420, note: "good", submittedAt: "2026-08-24T10:00:00Z" } } };
    return { status: 404, body: {} };
  });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-rpe-submit" }), { renderTrainingLoad });
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(Object.keys(fetchCalls[0].body).sort(), ["durationMinutes", "note", "rpe"]);
  assert.equal(fetchCalls[0].body.rpe, 7);
  assert.equal(fetchCalls[0].body.durationMinutes, 60);
  assert.equal(state.trainingLoad.rpeForm.savedFeedback.srpe, 420);
  assert.equal(state.trainingLoad.rpeForm.saving, false);
});

test("D7. a failed submit surfaces an error and clears the saving guard, without closing the form", async () => {
  resetState();
  state.trainingLoad.rpeForm = emptyRpeForm({ sessionId: "sess-1", rpe: 5, durationMinutes: 30 });
  installFetchMock(() => ({ status: 409, body: { error: "This session already has a submitted result." } }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-rpe-submit" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.rpeForm.error, "This session already has a submitted result.");
  assert.equal(state.trainingLoad.rpeForm.saving, false);
  assert.equal(state.trainingLoad.rpeForm.savedFeedback, null);
});

test("D8. a double-submit while one is already in flight is a no-op - never a second request", async () => {
  resetState();
  const form = emptyRpeForm({ sessionId: "sess-1", rpe: 5, durationMinutes: 30 });
  form.saving = true;
  state.trainingLoad.rpeForm = form;
  installFetchMock(() => ({ status: 201, body: { feedback: { rpe: 5, durationMinutes: 30, srpe: 150, note: "", submittedAt: "" } } }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-rpe-submit" }), { renderTrainingLoad });
  assert.equal(fetchCalls.length, 0);
});

test("D9. closing the form after a successful save re-fetches Today (so the Home card reflects the new rated status)", async () => {
  resetState();
  state.trainingLoad.rpeForm = emptyRpeForm({ sessionId: "sess-1" });
  state.trainingLoad.rpeForm.savedFeedback = { rpe: 5, durationMinutes: 30, srpe: 150, note: "", submittedAt: "" };
  installFetchMock((call) => (call.url === "/api/training-load/athlete/today" ? { status: 200, body: { date: "2026-08-24", sessions: [] } } : { status: 404, body: {} }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-close-rpe-form" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.rpeForm, null);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/api/training-load/athlete/today");
});

test("D10. closing the form WITHOUT having saved never re-fetches anything", async () => {
  resetState();
  state.trainingLoad.rpeForm = emptyRpeForm({ sessionId: "sess-1" });
  installFetchMock(() => { throw new Error("must not fetch"); });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-close-rpe-form" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.rpeForm, null);
});

// ------------------------------------------------------------
// E. Coach: section switch, week navigation, request-race guard
// ------------------------------------------------------------

// Correction (item 3 - "always-refresh" policy): switching sections must
// ALWAYS issue a real fetch, even back to a section that already has data
// from earlier this session - menu-cache-policy.js declares this tab
// "always-refresh" for the same reason Tests' own weekly nav never skips
// a fetch either (rated/not-rated status changes on nearly every visit).
test("E1. switching sections ALWAYS fetches that section's own week fresh - never skipped just because it already has data from an earlier visit", async () => {
  resetState();
  let calls = 0;
  // (v9) Switching INTO "schedule" also fetches the master-toggle
  // setting (that's the only tab it renders on) - one extra call each
  // time, never fired for any other section.
  installFetchMock((call) => { calls += 1; return { status: 200, body: call.url === "/api/training-load/planned-rpe-setting" ? { enabled: false, enabledAt: null } : weekPayload("2026-08-24") }; });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "schedule" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.section, "schedule");
  assert.equal(calls, 2, "the weekly fetch AND the master-toggle setting fetch, entering schedule");
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "today" }), { renderTrainingLoad });
  assert.equal(calls, 3, "only the weekly fetch - today never fetches the schedule-only setting");
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "schedule" }), { renderTrainingLoad });
  assert.equal(calls, 5, "switching back to schedule must fetch both again, even though it already has data from the first visit");
});

test("E2. Prev/Next/Today shift the week exactly 7 days, matching the Tests weekly nav contract", async () => {
  resetState();
  state.trainingLoad.weekly.today.weekStart = "2026-08-24";
  state.trainingLoad.weekly.today.selectedDate = "2026-08-24";
  installFetchMock(() => ({ status: 200, body: weekPayload("2026-08-31") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "today" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.weekly.today.weekStart, "2026-08-31");
  assert.equal(state.trainingLoad.weekly.today.selectedDate, "2026-08-31");
});

test("E3. a rapid double Next-week click - the newer response resolving first still wins, the stale older one is dropped", async () => {
  resetState();
  state.trainingLoad.weekly.today.weekStart = "2026-08-24";
  state.trainingLoad.weekly.today.selectedDate = "2026-08-24";
  const deferreds = installDeferredFetchMock();
  const first = loadTrainingLoadWeekly("today");
  const second = loadTrainingLoadWeekly("today");
  assert.equal(deferreds.length, 2);
  deferreds[1].resolve({ status: 200, body: weekPayload("2026-09-07") });
  await second;
  deferreds[0].resolve({ status: 200, body: weekPayload("2026-08-31") });
  await first;
  assert.equal(state.trainingLoad.weekly.today.data.weekStart, "2026-09-07");
  assert.equal(state.trainingLoad.weekly.today.loading, false);
});

// ------------------------------------------------------------
// F. Coach: Club/Team/Athletes filter picker
// ------------------------------------------------------------

test("F1. opening the filter picker snapshots the current filter; Cancel restores it exactly", async () => {
  resetState();
  state.trainingLoad.filter.clubIds = ["club-1"];
  installFetchMock(() => ({ status: 200, body: { clubs: [], teams: [], athletes: [] } }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-open" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-toggle", kind: "club", id: "club-2" }), { renderTrainingLoad });
  assert.deepEqual(state.trainingLoad.filter.clubIds.sort(), ["club-1", "club-2"]);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-cancel" }), { renderTrainingLoad });
  assert.deepEqual(state.trainingLoad.filter.clubIds, ["club-1"], "Cancel must revert to exactly what it was before the picker opened");
  assert.equal(state.trainingLoad.filterPicker.open, false);
});

test("F2. Confirm applies the (already-live) filter change and re-fetches the current section", async () => {
  resetState();
  state.trainingLoad.section = "today";
  installFetchMock((call) => {
    if (call.url === "/api/organization") return { status: 200, body: { clubs: [], teams: [], athletes: [] } };
    return { status: 200, body: weekPayload("2026-08-24") };
  });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-open" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-toggle", kind: "athlete", id: "ath-9" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-confirm" }), { renderTrainingLoad });
  assert.deepEqual(state.trainingLoad.filter.athleteIds, ["ath-9"]);
  assert.equal(state.trainingLoad.filterPicker.open, false);
  assert.ok(fetchCalls.some((c) => c.url.includes("athleteIds=ath-9")), "the confirmed filter must be sent on the next weekly fetch");
});

test("F3. Select all / Clear all operate on the currently-visible (search-filtered) athletes only", async () => {
  resetState();
  state.trainingLoad.orgPickerData = {
    clubs: [],
    teams: [],
    athletes: [
      { id: "a1", name: "Ana Anić", athlete_id: "1" },
      { id: "a2", name: "Bojan Bojić", athlete_id: "2" },
    ],
  };
  state.trainingLoad.filterPicker.search = "ana";
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-select-all", kind: "athlete" }), { renderTrainingLoad });
  assert.deepEqual(state.trainingLoad.filter.athleteIds, ["a1"], "only the search-matched athlete is selected");
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-clear", kind: "athlete" }), { renderTrainingLoad });
  assert.deepEqual(state.trainingLoad.filter.athleteIds, []);
});

// ------------------------------------------------------------
// G. Results: client-side aggregates (daily/weekly sRPE, avg RPE, rated-vs-planned)
// ------------------------------------------------------------

test("G1. Results shows the correct weekly sRPE sum, average RPE, total duration, and rated/planned count across multiple athletes and sessions", () => {
  resetState();
  const date = "2026-08-24";
  state.trainingLoad.weekly.results.data = weekPayload(date, {
    [date]: [
      session({ sessionId: "s1", athleteName: "Ana", rated: true, feedback: { rpe: 6, durationMinutes: 50, srpe: 300 } }),
      session({ sessionId: "s2", athleteName: "Bojan", rated: true, feedback: { rpe: 8, durationMinutes: 40, srpe: 320 } }),
      session({ sessionId: "s3", athleteName: "Ana", rated: false }),
    ],
  });
  state.trainingLoad.weekly.results.selectedDate = date;
  const html = renderTrainingLoadResultsHtml();
  assert.ok(html.includes("620 AU"), "weekly sRPE sum: 300 + 320 = 620");
  assert.ok(html.includes("7.0"), "average RPE across rated sessions: (6+8)/2 = 7.0");
  assert.ok(html.includes("90 min"), "total duration: 50 + 40 = 90");
  assert.ok(html.includes("2/3"), "2 rated out of 3 planned");
});

test("G2. Results only ever lists RATED sessions in the agenda - an unrated planned session never appears there", () => {
  resetState();
  const date = "2026-08-24";
  state.trainingLoad.weekly.results.data = weekPayload(date, {
    [date]: [session({ sessionId: "s1", rated: true, feedback: { rpe: 5, durationMinutes: 30, srpe: 150 } }), session({ sessionId: "s2", rated: false })],
  });
  state.trainingLoad.weekly.results.selectedDate = date;
  const html = renderTrainingLoadResultsHtml();
  assert.equal((html.match(/training-load-session-row/g) || []).length > 0, true);
  assert.ok(!html.includes("Not rated"), "Results never shows an unrated row at all");
});

test("G3. a disabled+unrated session never counts toward the rated/planned denominator, but a disabled session that already has a result still counts (and contributes to sRPE)", () => {
  resetState();
  const date = "2026-08-24";
  state.trainingLoad.weekly.results.data = weekPayload(date, {
    [date]: [
      session({ sessionId: "s1", rated: true, feedback: { rpe: 6, durationMinutes: 50, srpe: 300 } }),
      session({ sessionId: "s2", rated: false, rpeEnabled: false }),
      session({ sessionId: "s3", rated: true, rpeEnabled: false, feedback: { rpe: 4, durationMinutes: 20, srpe: 80 } }),
    ],
  });
  state.trainingLoad.weekly.results.selectedDate = date;
  const html = renderTrainingLoadResultsHtml();
  assert.ok(html.includes("2/2"), "s2 (disabled, unrated) must be excluded from the denominator entirely - 2 rated out of 2 counted, not out of 3");
  assert.ok(html.includes("380 AU"), "s3's already-recorded result (disabled or not) must still contribute to the weekly sRPE total: 300 + 80 = 380");
});

test("G4. a paused/cancelled, never-rated OUTSIDE-PLAN row never counts toward the rated/planned denominator, mirroring the disabled-planned-session rule exactly", () => {
  resetState();
  const date = "2026-08-24";
  state.trainingLoad.weekly.results.data = weekPayload(date, {
    [date]: [
      session({ sessionId: "s1", rated: true, feedback: { rpe: 6, durationMinutes: 50, srpe: 300 } }),
      externalSession({ externalAssignmentId: "asg-paused", rated: false, actionable: false, scheduleStatus: "paused" }),
      externalSession({ externalAssignmentId: "asg-cancelled", rated: false, actionable: false, scheduleStatus: "cancelled" }),
    ],
  });
  state.trainingLoad.weekly.results.selectedDate = date;
  const html = renderTrainingLoadResultsHtml();
  assert.ok(html.includes("1/1"), "neither never-rated external row (paused or cancelled) may count toward the denominator - 1 rated out of 1, not out of 3");
});

test("G5. a completed OUTSIDE-PLAN result still counts toward sRPE/the denominator even after its schedule was later cancelled - a completed result is never actionable again, but it always stays counted", () => {
  resetState();
  const date = "2026-08-24";
  state.trainingLoad.weekly.results.data = weekPayload(date, {
    [date]: [
      externalSession({ externalAssignmentId: "asg-done", rated: true, actionable: false, scheduleStatus: "cancelled", feedback: { rpe: 6, durationMinutes: 40, srpe: 240 } }),
    ],
  });
  state.trainingLoad.weekly.results.selectedDate = date;
  const html = renderTrainingLoadResultsHtml();
  assert.ok(html.includes("1/1"), "a completed result must always count, regardless of its schedule's current status");
  assert.ok(html.includes("240 AU"));
});

test("G6. Today's grouping omits a paused/cancelled, never-rated OUTSIDE-PLAN row entirely - it never renders as a pending group at all", () => {
  resetState();
  state.trainingLoad.weekly.today.data = weekPayload("2026-08-24", {
    "2026-08-24": [externalSession({ externalAssignmentId: "asg-paused", rated: false, actionable: false, scheduleStatus: "paused", sessionName: "Paused camp" })],
  });
  const html = renderTrainingLoadTodayHtml();
  assert.ok(!html.includes("Paused camp"), "a paused, never-rated external row must not appear on Today at all - not even as a non-clickable/informational row");
});

test("G7. Today's grouping still shows a completed OUTSIDE-PLAN result even after its schedule is cancelled", () => {
  resetState();
  state.trainingLoad.weekly.today.data = weekPayload("2026-08-24", {
    "2026-08-24": [externalSession({ externalAssignmentId: "asg-done", rated: true, actionable: false, scheduleStatus: "cancelled", sessionName: "Now-cancelled camp", feedback: { rpe: 5, durationMinutes: 30, srpe: 150 } })],
  });
  const html = renderTrainingLoadTodayHtml();
  assert.ok(html.includes("Now-cancelled camp"), "a completed result must keep showing on Today even after its schedule is cancelled");
  assert.ok(html.includes("1/1"));
});

test("G8. the Schedule tab (management view) still shows a paused/cancelled row, unlike Today - explicitly labeled, never omitted", () => {
  resetState();
  state.trainingLoad.weekly.schedule.data = weekPayload("2026-08-24", {
    "2026-08-24": [
      externalSession({ externalAssignmentId: "asg-paused", rated: false, actionable: false, scheduleStatus: "paused", athleteName: "Paused Athlete" }),
      externalSession({ externalAssignmentId: "asg-cancelled", rated: false, actionable: false, scheduleStatus: "cancelled", athleteName: "Cancelled Athlete" }),
    ],
  });
  const html = renderTrainingLoadScheduleHtml();
  assert.ok(html.includes("Paused Athlete") && html.includes("Paused"), "a paused row must still be visible on Schedule (for management), explicitly labeled Paused");
  assert.ok(html.includes("Cancelled Athlete") && html.includes("Cancelled"), "a cancelled row must still be visible on Schedule, explicitly labeled Cancelled");
});

// ------------------------------------------------------------
// H. Correction: filter Confirm invalidates ALL THREE sections, and a
// combined Club + Athlete filter is sent as a genuine union on the wire.
// ------------------------------------------------------------

test("H1. Confirm drops the OTHER two sections' cached data too, not just the currently-open one - a later switch into them must fetch fresh, never show stale pre-filter data", async () => {
  resetState();
  state.trainingLoad.section = "today";
  state.trainingLoad.weekly.today.data = weekPayload("2026-08-24");
  state.trainingLoad.weekly.schedule.data = weekPayload("2026-08-24");
  state.trainingLoad.weekly.results.data = weekPayload("2026-08-24");
  installFetchMock((call) => (call.url === "/api/organization" ? { status: 200, body: { clubs: [], teams: [], athletes: [] } } : { status: 200, body: weekPayload("2026-08-24") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-open" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-toggle", kind: "athlete", id: "ath-1" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-confirm" }), { renderTrainingLoad });
  assert.ok(state.trainingLoad.weekly.today.data, "the current section was refetched immediately, so it has fresh data again");
  assert.equal(state.trainingLoad.weekly.schedule.data, null, "schedule's stale pre-filter data must be dropped, even though it isn't the open sub-tab");
  assert.equal(state.trainingLoad.weekly.results.data, null, "results' stale pre-filter data must be dropped too");
});

test("H2. a combined Club + Athlete filter sends BOTH params on the same request - a real union, not one replacing the other", async () => {
  resetState();
  installFetchMock((call) => (call.url === "/api/organization" ? { status: 200, body: { clubs: [], teams: [], athletes: [] } } : { status: 200, body: weekPayload("2026-08-24") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-open" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-toggle", kind: "club", id: "club-1" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-toggle", kind: "athlete", id: "ath-9" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-confirm" }), { renderTrainingLoad });
  const finalCall = fetchCalls[fetchCalls.length - 1];
  assert.ok(finalCall.url.includes("clubIds=club-1"));
  assert.ok(finalCall.url.includes("athleteIds=ath-9"));
});

// ------------------------------------------------------------
// I. Correction: workspace switch reset - filter/org-picker/weekly
// payload for the OLD workspace must never leak into the new one, and a
// late response from before the switch must never land afterward.
// ------------------------------------------------------------

test("I1. resetTrainingLoadForWorkspaceChange clears the filter, the org-picker roster, and every section's cached weekly payload", () => {
  resetState();
  state.trainingLoad.filter.clubIds = ["club-1"];
  state.trainingLoad.filter.athleteIds = ["ath-1"];
  state.trainingLoad.orgPickerData = { clubs: [{ id: "club-1", name: "Old club" }], teams: [], athletes: [] };
  state.trainingLoad.weekly.today.data = weekPayload("2026-08-24");
  state.trainingLoad.weekly.schedule.data = weekPayload("2026-08-24");
  state.trainingLoad.weekly.results.data = weekPayload("2026-08-24");
  state.trainingLoad.athleteWeekly.data = weekPayload("2026-08-24");
  state.trainingLoad.filterPicker.open = true;

  resetTrainingLoadForWorkspaceChange();

  assert.deepEqual(state.trainingLoad.filter, { clubIds: [], teamIds: [], athleteIds: [] });
  assert.equal(state.trainingLoad.orgPickerData, null);
  assert.equal(state.trainingLoad.weekly.today.data, null);
  assert.equal(state.trainingLoad.weekly.schedule.data, null);
  assert.equal(state.trainingLoad.weekly.results.data, null);
  assert.equal(state.trainingLoad.athleteWeekly.data, null);
  assert.equal(state.trainingLoad.filterPicker.open, false);
});

test("I2. a response already in flight when the workspace switch happens is dropped as stale, even though nothing re-fetched that section afterward", async () => {
  resetState();
  const deferreds = installDeferredFetchMock();
  const inFlight = loadTrainingLoadWeekly("today");
  assert.equal(deferreds.length, 1);
  // The workspace switch happens WHILE the request above is still
  // in flight - no new fetch for "today" is issued as part of this
  // particular switch (Training load isn't necessarily the active tab).
  resetTrainingLoadForWorkspaceChange();
  deferreds[0].resolve({ status: 200, body: weekPayload("2026-08-24") });
  await inFlight;
  assert.equal(state.trainingLoad.weekly.today.data, null, "the stale in-flight response must never overwrite the just-reset state");
  assert.equal(state.trainingLoad.weekly.today.loading, false, "and must never leave loading stuck either");
});

// ------------------------------------------------------------
// J. Correction (item 4): a rated session can never re-open a blank RPE
// form - from either the Home list or the weekly overlay.
// ------------------------------------------------------------

test("J1. clicking a RATED row in the Home session list is a no-op - never opens a form that would only 409", async () => {
  resetState();
  state.trainingLoad.athleteToday = {
    date: "2026-08-24",
    sessions: [{ sessionId: "s1", sessionName: "Rated session", amPm: "", bta: "", sessionTime: "", rated: true, feedback: { rpe: 5, durationMinutes: 30, srpe: 150 } }],
    loading: false,
    error: "",
  };
  await handleTrainingLoadAction(fakeAction({ action: "training-load-open-rpe-form", sessionId: "s1" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.rpeForm, null);
});

test("J2. a rated row never renders as a clickable button in the session list - a plain, non-interactive summary instead", () => {
  const html = renderTrainingLoadSessionListHtml({
    date: "2026-08-24",
    sessions: [{ sessionId: "s1", sessionName: "Rated session", amPm: "", bta: "", sessionTime: "", rated: true, feedback: { rpe: 5, durationMinutes: 30, srpe: 150 } }],
  });
  assert.ok(!html.includes('data-action="training-load-open-rpe-form" data-session-id="s1"'));
  assert.ok(html.includes("is-rated"));
});

test("J3. clicking a RATED row from the weekly overlay (not just today's Home list) is also a no-op", async () => {
  resetState();
  state.trainingLoad.athleteWeekly.data = weekPayload("2026-08-24", {
    "2026-08-24": [{ sessionId: "s1", sessionName: "Rated session", amPm: "", bta: "", sessionTime: "", rated: true, feedback: { rpe: 5, durationMinutes: 30, srpe: 150 } }],
  });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-open-rpe-form", sessionId: "s1" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.rpeForm, null);
});

// ------------------------------------------------------------
// K. Athlete "This week" weekly overlay (item 4) - opening, nav, and
// resolving a PAST unrated session that Home's own today-only card would
// never surface.
// ------------------------------------------------------------

test("K1. opening the weekly overlay always fetches fresh, even if it was already loaded from an earlier open", async () => {
  resetState();
  let calls = 0;
  installFetchMock(() => { calls += 1; return { status: 200, body: weekPayload("2026-08-24") }; });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-athlete-weekly-open" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.athleteWeeklyOpen, true);
  assert.equal(calls, 1);
  assert.ok(state.trainingLoad.athleteWeekly.data);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-athlete-weekly-close" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.athleteWeeklyOpen, false);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-athlete-weekly-open" }), { renderTrainingLoad });
  assert.equal(calls, 2, "a second open must fetch again, never skip just because .data already exists from the first open");
});

test("K1b. a stale response from an earlier open never overwrites a fresher one already applied - close, a changed response, then reopen shows the new data", async () => {
  resetState();
  state.trainingLoad.athleteWeekly.data = weekPayload("2026-08-24", { "2026-08-24": [session({ sessionId: "old-session", rated: false })] });
  const deferreds = installDeferredFetchMock();
  const openPromise = handleTrainingLoadAction(fakeAction({ action: "training-load-athlete-weekly-open" }), { renderTrainingLoad });
  // A slow first open's response resolves AFTER the coach changed the plan
  // and reopened - the newer open's own response must win.
  await handleTrainingLoadAction(fakeAction({ action: "training-load-athlete-weekly-close" }), { renderTrainingLoad });
  const secondOpenPromise = handleTrainingLoadAction(fakeAction({ action: "training-load-athlete-weekly-open" }), { renderTrainingLoad });
  deferreds[1].resolve({ status: 200, body: weekPayload("2026-08-24", { "2026-08-24": [session({ sessionId: "new-session", rated: false })] }) });
  await secondOpenPromise;
  deferreds[0].resolve({ status: 200, body: weekPayload("2026-08-24", { "2026-08-24": [session({ sessionId: "old-session", rated: false })] }) });
  await openPromise;
  const sessionIds = state.trainingLoad.athleteWeekly.data.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.deepEqual(sessionIds, ["new-session"], "the stale first-open response must be dropped, never overwrite the fresher reopen");
});

test("K2. Prev/Next/Today on the athlete's own weekly overlay shift by 7 days, same contract as the coach nav", async () => {
  resetState();
  state.trainingLoad.athleteWeekly.weekStart = "2026-08-24";
  state.trainingLoad.athleteWeekly.selectedDate = "2026-08-24";
  installFetchMock(() => ({ status: 200, body: weekPayload("2026-08-31") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-athlete-weekly-next-week" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.athleteWeekly.weekStart, "2026-08-31");
});

test("K3. a not-yet-rated session from an EARLIER day (never shown on Home's today-only card) opens the RPE form correctly from the weekly overlay", async () => {
  resetState();
  state.trainingLoad.athleteWeekly.data = weekPayload("2026-08-24", {
    "2026-08-25": [{ sessionId: "s-yesterday", sessionName: "Yesterday's session", amPm: "", bta: "", sessionTime: "", rated: false, feedback: null }],
  });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-open-rpe-form", sessionId: "s-yesterday" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.rpeForm.sessionId, "s-yesterday");
  assert.equal(state.trainingLoad.rpeForm.date, "2026-08-25", "the form's date comes from the weekly overlay's own day, not Home's today");
});

test("K4. closing the overlay after a successful save also refreshes the weekly overlay's own data, not just Home's today card", async () => {
  resetState();
  state.trainingLoad.athleteWeeklyOpen = true;
  state.trainingLoad.athleteWeekly.weekStart = "2026-08-24";
  state.trainingLoad.rpeForm = emptyRpeForm({ sessionId: "s1" });
  state.trainingLoad.rpeForm.savedFeedback = { rpe: 5, durationMinutes: 30, srpe: 150, note: "", submittedAt: "" };
  const calledUrls = [];
  installFetchMock((call) => { calledUrls.push(call.url); return { status: 200, body: call.url.includes("athlete/today") ? { date: "2026-08-24", sessions: [] } : weekPayload("2026-08-24") }; });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-close-rpe-form" }), { renderTrainingLoad });
  assert.ok(calledUrls.some((u) => u.includes("/athlete/today")));
  assert.ok(calledUrls.some((u) => u.includes("/weekly")));
});

// ------------------------------------------------------------
// L. Correction: the Athletes tab of the filter picker is workspace-scoped
// (state.trainingLoad.orgPickerData, from /api/organization), never the
// account-wide global roster - one account with two workspaces must see
// only the active workspace's own athletes, with no leakage after a switch.
// ------------------------------------------------------------

test("L1. switching workspaces swaps the picker's Athletes tab roster entirely - no old name or selection lingers", async () => {
  resetState();
  state.trainingLoad.filterPicker.tab = "athletes";
  installFetchMock((call) => (call.url === "/api/organization"
    ? { status: 200, body: { clubs: [], teams: [], athletes: [{ id: "a1", name: "Ana (Club A)", athlete_id: "1" }] } }
    : { status: 200, body: weekPayload("2026-08-24") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-open" }), { renderTrainingLoad });
  let html = renderTrainingLoadFilterPickerHtml();
  assert.ok(html.includes("Ana (Club A)"), "Club A's athlete must be shown while Club A is active");
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-toggle", kind: "athlete", id: "a1" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-confirm" }), { renderTrainingLoad });
  assert.deepEqual(state.trainingLoad.filter.athleteIds, ["a1"]);

  // Simulate switching the active workspace (Club A -> Club B): the app's
  // workspace-switch handler always calls this before anything re-fetches.
  resetTrainingLoadForWorkspaceChange();
  state.trainingLoad.filterPicker.tab = "athletes";
  installFetchMock((call) => (call.url === "/api/organization"
    ? { status: 200, body: { clubs: [], teams: [], athletes: [{ id: "b1", name: "Boris (Club B)", athlete_id: "9" }] } }
    : { status: 200, body: weekPayload("2026-08-24") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-open" }), { renderTrainingLoad });
  html = renderTrainingLoadFilterPickerHtml();
  assert.ok(html.includes("Boris (Club B)"), "Club B's athlete must be shown once Club B is active");
  assert.ok(!html.includes("Ana (Club A)"), "Club A's athlete must never leak into Club B's picker");
  assert.deepEqual(state.trainingLoad.filter.athleteIds, [], "the old workspace's selection must not linger after the switch");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-select-all", kind: "athlete" }), { renderTrainingLoad });
  assert.deepEqual(state.trainingLoad.filter.athleteIds, ["b1"], "Select all after a switch only takes the currently-shown workspace's athletes");
});

// ------------------------------------------------------------
// P. Training Load Schedule tab: the quick RPE ON/OFF toggle.
// ------------------------------------------------------------

test("P1. turning RPE off (no existing results) sends rpeEnabled: false with no confirmation dialog, then refetches the current section", async () => {
  resetState();
  state.trainingLoad.section = "schedule";
  installFetchMock(() => ({ status: 200, body: weekPayload("2026-08-24") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-toggle-session-rpe", sessionId: "sess-1", currentlyEnabled: "true" }), { renderTrainingLoad });
  assert.equal(fetchCalls.length, 2, "one PATCH toggle call, then one GET refetch of the current section");
  assert.equal(fetchCalls[0].method, "PATCH");
  assert.match(fetchCalls[0].url, /\/sessions\/sess-1\/rpe-enabled$/);
  assert.equal(fetchCalls[0].body.rpeEnabled, false);
  assert.equal(fetchCalls[0].body.confirmDisableWithResults, undefined, "no confirmation flag on the first attempt");
});

test("P2. turning RPE on never needs confirmation, regardless of existing results", async () => {
  resetState();
  state.trainingLoad.section = "schedule";
  installFetchMock(() => ({ status: 200, body: weekPayload("2026-08-24") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-toggle-session-rpe", sessionId: "sess-1", currentlyEnabled: "false" }), { renderTrainingLoad });
  assert.equal(fetchCalls[0].body.rpeEnabled, true);
});

test("P3. a 409 hasExistingResults shows a confirm dialog - Cancel leaves rpe_enabled untouched and never retries", async () => {
  resetState();
  state.trainingLoad.section = "schedule";
  const originalConfirm = globalThis.window.confirm;
  globalThis.window.confirm = () => false;
  try {
    installFetchMock((call) => (call.method === "PATCH" ? { status: 409, body: { error: "hasExistingResults", resultCount: 2 } } : { status: 200, body: weekPayload("2026-08-24") }));
    await handleTrainingLoadAction(fakeAction({ action: "training-load-toggle-session-rpe", sessionId: "sess-1", currentlyEnabled: "true" }), { renderTrainingLoad });
    assert.equal(fetchCalls.length, 1, "Cancel must never retry the request or refetch anything");
    assert.equal(fetchCalls[0].method, "PATCH");
  } finally {
    globalThis.window.confirm = originalConfirm;
  }
});

test("P4. a 409 hasExistingResults, then Confirm, retries with confirmDisableWithResults: true and refetches on success", async () => {
  resetState();
  state.trainingLoad.section = "schedule";
  const originalConfirm = globalThis.window.confirm;
  globalThis.window.confirm = () => true;
  try {
    let patchCount = 0;
    installFetchMock((call) => {
      if (call.method === "PATCH") {
        patchCount += 1;
        if (patchCount === 1) return { status: 409, body: { error: "hasExistingResults", resultCount: 2 } };
        return { status: 200, body: { sessionId: "sess-1", rpeEnabled: false, draftSessionUpdated: false } };
      }
      return { status: 200, body: weekPayload("2026-08-24") };
    });
    await handleTrainingLoadAction(fakeAction({ action: "training-load-toggle-session-rpe", sessionId: "sess-1", currentlyEnabled: "true" }), { renderTrainingLoad });
    assert.equal(fetchCalls.length, 3, "first PATCH (409), confirmed retry PATCH (200), then the refetch");
    assert.equal(fetchCalls[1].method, "PATCH");
    assert.equal(fetchCalls[1].body.rpeEnabled, false);
    assert.equal(fetchCalls[1].body.confirmDisableWithResults, true, "the retry must carry the confirmation flag");
  } finally {
    globalThis.window.confirm = originalConfirm;
  }
});

test("P5. a session with no sessionId in its dataset is a safe no-op - never a crash", async () => {
  resetState();
  installFetchMock(() => ({ status: 200, body: weekPayload("2026-08-24") }));
  const result = await handleTrainingLoadAction(fakeAction({ action: "training-load-toggle-session-rpe" }), { renderTrainingLoad });
  assert.equal(result, true);
  assert.equal(fetchCalls.length, 0);
});

// ------------------------------------------------------------
// Q. Athlete: an OUTSIDE-PLAN (external) RPE session - same click/open/
// submit flow as a planned session, but keyed on externalAssignmentId
// instead of sessionId, and posting to the external-assignment endpoint.
// Mirrors sections C/D above, exercising the mutually-exclusive identity
// shape rather than duplicating every existing planned-session case.
// ------------------------------------------------------------

test("Q1. a single-session card click for an OUTSIDE-PLAN session opens the RPE form keyed on externalAssignmentId, not sessionId", async () => {
  resetState();
  renderCount = 0;
  state.trainingLoad.athleteToday = {
    date: "2026-08-24",
    sessions: [externalSession({ externalAssignmentId: "asg-9", sessionName: "National team camp" })],
    loading: false,
    error: "",
  };
  await handleTrainingLoadAction(fakeAction({ action: "training-load-home-card-open", count: "1", sessionId: "asg-9" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.showSessionList, false);
  assert.equal(state.trainingLoad.rpeForm.externalAssignmentId, "asg-9");
  assert.equal(state.trainingLoad.rpeForm.source, "scheduled_external");
  assert.equal(state.trainingLoad.rpeForm.sessionId, "", "a planned sessionId must never be populated for an external row");
  assert.equal(state.trainingLoad.rpeForm.sessionName, "National team camp");
  assert.equal(renderCount, 1);
});

test("Q2. picking an OUTSIDE-PLAN session from the multi-session list opens its form the same way", async () => {
  resetState();
  renderCount = 0;
  state.trainingLoad.athleteToday = {
    date: "2026-08-24",
    sessions: [externalSession({ externalAssignmentId: "asg-9" })],
    loading: false,
    error: "",
  };
  state.trainingLoad.showSessionList = true;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-open-rpe-form", sessionId: "asg-9" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.showSessionList, false);
  assert.equal(state.trainingLoad.rpeForm.externalAssignmentId, "asg-9");
  assert.equal(state.trainingLoad.rpeForm.source, "scheduled_external");
});

test("Q3. a not-yet-rated OUTSIDE-PLAN session from an earlier day opens correctly from the weekly overlay too", async () => {
  resetState();
  renderCount = 0;
  state.trainingLoad.athleteToday = { date: "2026-08-24", sessions: [], loading: false, error: "" };
  state.trainingLoad.athleteWeekly.data = weekPayload("2026-08-24", {
    "2026-08-25": [externalSession({ externalAssignmentId: "asg-yesterday", sessionName: "Extra gym session" })],
  });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-open-rpe-form", sessionId: "asg-yesterday" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.rpeForm.externalAssignmentId, "asg-yesterday");
  assert.equal(state.trainingLoad.rpeForm.source, "scheduled_external");
  assert.equal(state.trainingLoad.rpeForm.date, "2026-08-25");
});

test("Q4. a RATED outside-plan row is a no-op, same guard as a rated planned row", async () => {
  resetState();
  state.trainingLoad.athleteToday = {
    date: "2026-08-24",
    sessions: [externalSession({ externalAssignmentId: "asg-9", rated: true, feedback: { rpe: 6, durationMinutes: 40, srpe: 240 } })],
    loading: false,
    error: "",
  };
  await handleTrainingLoadAction(fakeAction({ action: "training-load-open-rpe-form", sessionId: "asg-9" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.rpeForm, null);
});

test("Q5. submitting an OUTSIDE-PLAN form posts to the external-assignment endpoint, never the planned one", async () => {
  resetState();
  renderCount = 0;
  state.trainingLoad.rpeForm = emptyRpeForm({
    externalAssignmentId: "asg-9",
    source: "scheduled_external",
    sessionName: "National team camp",
    rpe: 6,
    durationMinutes: 45,
    note: "",
  });
  installFetchMock((call) => {
    if (call.url === "/api/training-load/external-assignments/asg-9/rpe") {
      return { status: 201, body: { feedback: { rpe: 6, durationMinutes: 45, srpe: 270, note: "", submittedAt: "2026-08-24T10:00:00Z" } } };
    }
    return { status: 404, body: {} };
  });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-rpe-submit" }), { renderTrainingLoad });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/api/training-load/external-assignments/asg-9/rpe");
  assert.equal(fetchCalls[0].method, "POST");
  assert.deepEqual(Object.keys(fetchCalls[0].body).sort(), ["durationMinutes", "note", "rpe"], "never a client-computed sRPE, and never sessionId/externalAssignmentId in the body - identity is in the URL");
  assert.equal(state.trainingLoad.rpeForm.savedFeedback.srpe, 270);
  assert.equal(state.trainingLoad.rpeForm.saving, false);
});

test("Q6. a planned-source form (the default) still posts to the planned sessions endpoint, unaffected by the new branch", async () => {
  resetState();
  state.trainingLoad.rpeForm = emptyRpeForm({ sessionId: "sess-1", rpe: 5, durationMinutes: 30 });
  installFetchMock((call) => (call.url === "/api/training-load/sessions/sess-1/rpe" ? { status: 201, body: { feedback: { rpe: 5, durationMinutes: 30, srpe: 150, note: "", submittedAt: "" } } } : { status: 404, body: {} }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-rpe-submit" }), { renderTrainingLoad });
  assert.equal(fetchCalls[0].url, "/api/training-load/sessions/sess-1/rpe");
});

test("Q7. the 'Outside plan' tag renders in the Home card's single-session copy, the session list, and the RPE form header - and never for a planned session", () => {
  const plannedHtml = renderTrainingLoadHomeCardHtml({ date: "2026-08-24", sessions: [session({ sessionId: "sess-1" })] });
  assert.ok(!plannedHtml.includes("training-load-outside-plan-tag"));

  const listHtml = renderTrainingLoadSessionListHtml({
    sessions: [externalSession({ externalAssignmentId: "asg-9" }), session({ sessionId: "sess-1", rated: true, feedback: { rpe: 5, durationMinutes: 30, srpe: 150 } })],
  });
  const outsidePlanCount = (listHtml.match(/training-load-outside-plan-tag/g) || []).length;
  assert.equal(outsidePlanCount, 1, "only the external row gets the tag, whether rated or not");

  const formHtml = renderRpeFormHtml(emptyRpeForm({ externalAssignmentId: "asg-9", source: "scheduled_external", sessionName: "National team camp", rpe: 5, durationMinutes: 30 }));
  assert.ok(formHtml.includes("training-load-outside-plan-tag"));
  assert.ok(formHtml.includes("National team camp"));

  const plannedFormHtml = renderRpeFormHtml(emptyRpeForm({ sessionId: "sess-1", sessionName: "Tempo run", rpe: 5, durationMinutes: 30 }));
  assert.ok(!plannedFormHtml.includes("training-load-outside-plan-tag"));
});

test("Q8. the Home card click target uses the external assignment id, not a blank sessionId, when the single unrated session is outside-plan", () => {
  const html = renderTrainingLoadHomeCardHtml({ date: "2026-08-24", sessions: [externalSession({ externalAssignmentId: "asg-9" })] });
  assert.ok(html.includes('data-session-id="asg-9"'));
});

// ------------------------------------------------------------
// R. "New RPE session" form: real, per-schedule Notifications config -
// no longer a static, unconditional "athletes are notified" claim.
// ------------------------------------------------------------

test("R1. the Notifications section summary reflects the current on/off count, and expands to show all three switches plus the reminder offset", () => {
  resetState();
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm({ notificationsSectionOpen: true });
  const html = renderExternalScheduleFormHtml();
  assert.ok(html.includes("All on"), "all three defaults are enabled");
  assert.ok(html.includes("Notify when open") && html.includes("Remind incomplete") && html.includes("Final summary when it closes"));
  assert.ok(html.includes('data-action="training-load-notification-offset-input"'), "the reminder offset input must show while the reminder switch is on");
});

test("R2. collapsed by default, the summary still reflects a partial on/off mix", () => {
  resetState();
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm({
    notificationsSectionOpen: false,
    notificationRules: [
      { kind: "athlete_invitation", enabled: false, reminderOffsetMinutes: null },
      { kind: "athlete_reminder", enabled: true, reminderOffsetMinutes: 60 },
      { kind: "final_digest", enabled: true, reminderOffsetMinutes: null },
    ],
  });
  const html = renderExternalScheduleFormHtml();
  assert.ok(html.includes("2/3 on"));
  assert.ok(!html.includes('data-action="training-load-notification-offset-input"'), "collapsed - the individual switches/offset input must not render at all");
});

test("R3. toggling a notification switch flips only that kind's own enabled flag", async () => {
  resetState();
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm();
  await handleTrainingLoadAction(fakeAction({ action: "training-load-notification-rule-toggle", kind: "athlete_invitation" }), { renderTrainingLoad });
  const form = state.trainingLoad.scheduleForm;
  assert.equal(form.notificationRules.find((r) => r.kind === "athlete_invitation").enabled, false);
  assert.equal(form.notificationRules.find((r) => r.kind === "athlete_reminder").enabled, true, "toggling one kind must never affect the others");
});

test("R4. changing the reminder offset input updates only the athlete_reminder rule's own offset, with no full re-render", async () => {
  resetState();
  renderCount = 0;
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm();
  await handleTrainingLoadAction(fakeAction({ action: "training-load-notification-offset-input" }, "15"), { renderTrainingLoad });
  const rule = state.trainingLoad.scheduleForm.notificationRules.find((r) => r.kind === "athlete_reminder");
  assert.equal(rule.reminderOffsetMinutes, 15);
  assert.equal(renderCount, 0);
});

test("R5. a schedule submit body includes the current notificationRules array, keyed by kind", async () => {
  resetState();
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm({
    eventName: "Camp", opensTime: "06:00", closesTime: "20:00", scheduleKind: "specific_dates", selectedDates: ["2026-08-24"],
    athleteIds: ["ath-1"],
  });
  state.trainingLoad.scheduleForm.notificationRules.find((r) => r.kind === "athlete_invitation").enabled = false;
  installFetchMock((call) => (call.method === "POST" && call.url === "/api/training-load/external-schedules" ? { status: 201, body: { schedules: [{ id: "sched-9" }] } } : { status: 200, body: weekPayload("2026-08-24") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-schedule-submit" }), { renderTrainingLoad });
  const createCall = fetchCalls.find((c) => c.url === "/api/training-load/external-schedules");
  assert.ok(createCall, "expected the create request to have been sent");
  const rules = createCall.body.notificationRules;
  assert.equal(rules.find((r) => r.kind === "athlete_invitation").enabled, false);
  assert.equal(rules.find((r) => r.kind === "athlete_reminder").reminderOffsetMinutes, 60);
});

// ------------------------------------------------------------
// S. "Dates" mode is ONE logical schedule, and Edit no longer renders a
// calendar that LOOKS editable while the backend silently discards
// whatever it's clicked to (item 10 correction). Edit shows a read-only
// summary instead - a real, working end-date input for Daily is the one
// exception, since that's the one field PATCH genuinely applies.
// ------------------------------------------------------------

test("S1. creating a new schedule (not editing) is unaffected - the interactive Dates/Daily pills and click calendar still render", () => {
  resetState();
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm({ scheduleKind: "specific_dates", calendarOpen: true });
  const html = renderExternalScheduleFormHtml();
  assert.ok(html.includes('data-action="training-load-schedule-set-recurrence"'), "the Dates/Daily toggle must still render for a brand-new schedule");
  assert.ok(html.includes('data-action="training-load-calendar-day-click"'), "the real click calendar must still render for a brand-new schedule");
});

test("S2. editing an existing 'dates'-kind schedule shows a READ-ONLY list of its own fixed dates - no Dates/Daily toggle, no clickable calendar day, no remove-date chip", () => {
  resetState();
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm({
    editingScheduleId: "sched-dates-1",
    scheduleKind: "specific_dates",
    datesList: ["2026-09-01", "2026-09-05", "2026-09-10"],
  });
  const html = renderExternalScheduleFormHtml();
  assert.ok(!html.includes('data-action="training-load-schedule-set-recurrence"'), "no Dates/Daily toggle while editing - the kind is fixed");
  assert.ok(!html.includes('data-action="training-load-calendar-day-click"'), "no clickable calendar day while editing - dates can never be silently discarded again");
  assert.ok(!html.includes('data-action="training-load-calendar-remove-date"'), "no remove-date control either - fully read-only");
  assert.ok(html.includes("2026-09-01") && html.includes("2026-09-05") && html.includes("2026-09-10"), "every one of the schedule's own real dates must be shown");
  assert.ok(html.includes("Schedule again"), "must point the coach at the real path to pick new dates");
});

test("S3. editing an existing 'one_time' schedule shows its fixed single date as read-only text, not a clickable calendar", () => {
  resetState();
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm({
    editingScheduleId: "sched-onetime-1",
    scheduleKind: "one_time",
    startDate: "2026-09-03",
  });
  const html = renderExternalScheduleFormHtml();
  assert.ok(!html.includes('data-action="training-load-calendar-day-click"'));
  assert.ok(html.includes("2026-09-03") || /3 Sep/.test(html), "the fixed date must still be visible, just not editable");
});

test("S4. editing an existing 'recurring' (Daily) schedule shows a read-only start date PLUS a REAL, working end-date input - the one field PATCH genuinely applies", () => {
  resetState();
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm({
    editingScheduleId: "sched-daily-1",
    scheduleKind: "daily",
    startDate: "2026-09-01",
    endDate: "2026-09-14",
  });
  const html = renderExternalScheduleFormHtml();
  assert.ok(!html.includes('data-action="training-load-calendar-day-click"'), "no click calendar - the start date is fixed");
  assert.ok(html.includes('name="endDate"') && html.includes('type="date"'), "a real end-date input must render - this one genuinely saves");
  assert.ok(html.includes('value="2026-09-14"'));
});

test("S5. the submit button is never permanently disabled while editing a 'dates'-kind schedule, even though selectedDates stays empty in edit mode - and its label reads 'Save changes', never 'Schedule 0 dates'", () => {
  resetState();
  const form = emptyExternalScheduleForm({
    editingScheduleId: "sched-dates-1",
    scheduleKind: "specific_dates",
    eventName: "Camp",
    datesList: ["2026-09-01"],
  });
  assert.equal(form.selectedDates.length, 0, "sanity: edit mode never populates selectedDates");
  assert.equal(externalScheduleSubmitDisabled(form), false);
  assert.equal(externalScheduleSubmitLabel(form), "Save changes");
});

test("S6. opening Edit on a real 'dates'-kind schedule maps the API response into specific_dates UI mode with its own dates listed for read-only display", async () => {
  resetState();
  installFetchMock((call) => (call.url === "/api/training-load/external-schedules/sched-dates-1"
    ? { status: 200, body: { schedule: { id: "sched-dates-1", eventName: "Camp", scheduleKind: "dates", dates: ["2026-09-01", "2026-09-05"], startDate: "2026-09-01", endDate: "2026-09-05", opensTime: "00:00:00", closesTime: "23:59:00", timezone: "UTC" }, targets: [], notificationRules: [] } }
    : { status: 200, body: { clubs: [], teams: [], athletes: [] } }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-open-edit-external-schedule", scheduleId: "sched-dates-1" }), { renderTrainingLoad });
  const form = state.trainingLoad.scheduleForm;
  assert.equal(form.editingScheduleId, "sched-dates-1");
  assert.equal(form.scheduleKind, "specific_dates");
  assert.deepEqual(form.datesList, ["2026-09-01", "2026-09-05"]);
});

test("S7. opening Schedule again on a 'dates'-kind source starts with a BLANK date selection (a fresh pick is required), using the real interactive calendar - never pre-filled with the source's own dates", async () => {
  resetState();
  installFetchMock((call) => (call.url === "/api/training-load/external-schedules/sched-dates-1"
    ? { status: 200, body: { schedule: { id: "sched-dates-1", eventName: "Camp", scheduleKind: "dates", dates: ["2026-09-01", "2026-09-05"], startDate: "2026-09-01", endDate: "2026-09-05", opensTime: "00:00:00", closesTime: "23:59:00", timezone: "UTC" }, targets: [], notificationRules: [] } }
    : { status: 200, body: { clubs: [], teams: [], athletes: [] } }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-external-schedule-again", scheduleId: "sched-dates-1" }), { renderTrainingLoad });
  const form = state.trainingLoad.scheduleForm;
  assert.equal(form.scheduleAgainFromId, "sched-dates-1");
  assert.equal(form.scheduleKind, "specific_dates");
  assert.deepEqual(form.selectedDates, [], "never pre-filled with the original's own dates - a genuinely new pick is required");
  const html = renderExternalScheduleFormHtml();
  assert.ok(html.includes('data-action="training-load-calendar-day-click"'), "Schedule again is NOT edit mode - the real interactive calendar must render so new dates can actually be picked");
});

test("S8. submitting Schedule again for a 'dates'-kind source sends a `dates` array, never a bare startDate", async () => {
  resetState();
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm({
    scheduleAgainFromId: "sched-dates-1",
    scheduleKind: "specific_dates",
    selectedDates: ["2026-10-01", "2026-10-08"],
  });
  installFetchMock((call) => (call.url === "/api/training-load/external-schedules/sched-dates-1/schedule-again"
    ? { status: 201, body: { schedule: { id: "sched-dates-2" } } }
    : { status: 200, body: weekPayload("2026-08-24") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-schedule-submit" }), { renderTrainingLoad });
  const call = fetchCalls.find((c) => c.url === "/api/training-load/external-schedules/sched-dates-1/schedule-again");
  assert.ok(call, "expected the schedule-again request to have been sent");
  assert.deepEqual(call.body.dates.slice().sort(), ["2026-10-01", "2026-10-08"]);
  assert.equal(call.body.startDate, undefined, "must never send a bare startDate for a dates-kind schedule-again");
});

test("S9. submitting a PATCH while editing a 'dates'-kind schedule never sends dates/startDate/scheduleKind - only genuinely-editable fields", async () => {
  resetState();
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm({
    editingScheduleId: "sched-dates-1",
    scheduleKind: "specific_dates",
    eventName: "Renamed camp",
    datesList: ["2026-09-01", "2026-09-05"],
  });
  installFetchMock((call) => (call.url === "/api/training-load/external-schedules/sched-dates-1" && call.method === "PATCH"
    ? { status: 200, body: { schedule: { id: "sched-dates-1" } } }
    : { status: 200, body: weekPayload("2026-08-24") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-schedule-submit" }), { renderTrainingLoad });
  const call = fetchCalls.find((c) => c.url === "/api/training-load/external-schedules/sched-dates-1" && c.method === "PATCH");
  assert.ok(call, "expected the PATCH request to have been sent");
  assert.equal(call.body.dates, undefined);
  assert.equal(call.body.startDate, undefined);
  assert.equal(call.body.scheduleKind, undefined);
  assert.equal(call.body.eventName, "Renamed camp");
});

// ------------------------------------------------------------
// T. A real code read (not just the earlier item-by-item pass) found
// Schedule again's OWN remaining bug: the form showed name/type/times/
// note/timezone/targets/notifications as fully editable, but only ever
// SENT the new date(s) - every other change was silently discarded, and
// the recipient picker opened with nothing pre-checked even though the
// backend was about to copy the source's own targets underneath it.
// ------------------------------------------------------------

test("T1. opening Schedule again pre-loads the ORIGINAL schedule's own targets into the form - the recipient picker must show what's actually about to be copied, never a blank slate", async () => {
  resetState();
  installFetchMock((call) => (call.url === "/api/training-load/external-schedules/sched-1"
    ? {
      status: 200,
      body: {
        schedule: { id: "sched-1", eventName: "Camp", scheduleKind: "one_time", startDate: "2026-09-01", opensTime: "06:00:00", closesTime: "20:00:00", timezone: "UTC" },
        targets: [{ kind: "athlete", athleteId: "ath-1", name: "Ana Anić" }, { kind: "club", clubId: "club-1", name: "First Club" }],
        notificationRules: [],
      },
    }
    : { status: 200, body: { clubs: [], teams: [], athletes: [] } }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-external-schedule-again", scheduleId: "sched-1" }), { renderTrainingLoad });
  const form = state.trainingLoad.scheduleForm;
  assert.deepEqual(form.athleteIds, ["ath-1"]);
  assert.deepEqual(form.clubIds, ["club-1"]);
});

test("T2. submitting Schedule again sends the FULL current form body - a changed name/type/times/note/timezone/notifications all actually reach the new schedule, never just the new date", async () => {
  resetState();
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm({
    scheduleAgainFromId: "sched-1",
    scheduleKind: "one_time",
    startDate: "2026-10-01",
    eventName: "Renamed on schedule-again",
    eventType: "match",
    opensTime: "07:00",
    closesTime: "19:00",
    eventNote: "a brand new note",
    timezone: "Europe/Belgrade",
    athleteIds: ["ath-9"],
  });
  state.trainingLoad.scheduleForm.notificationRules.find((r) => r.kind === "athlete_invitation").enabled = false;
  installFetchMock((call) => (call.url === "/api/training-load/external-schedules/sched-1/schedule-again"
    ? { status: 201, body: { schedule: { id: "sched-2" } } }
    : { status: 200, body: weekPayload("2026-08-24") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-schedule-submit" }), { renderTrainingLoad });
  const call = fetchCalls.find((c) => c.url === "/api/training-load/external-schedules/sched-1/schedule-again");
  assert.ok(call, "expected the schedule-again request to have been sent");
  assert.equal(call.body.eventName, "Renamed on schedule-again", "the changed name must actually be sent, not silently discarded");
  assert.equal(call.body.eventType, "match");
  assert.equal(call.body.opensTime, "07:00");
  assert.equal(call.body.closesTime, "19:00");
  assert.equal(call.body.eventNote, "a brand new note");
  assert.equal(call.body.timezone, "Europe/Belgrade");
  assert.deepEqual(call.body.targets, [{ kind: "athlete", id: "ath-9" }]);
  assert.equal(call.body.notificationRules.find((r) => r.kind === "athlete_invitation").enabled, false);
  assert.equal(call.body.startDate, "2026-10-01");
});

test("T3. editing an existing schedule and changing its fallback timezone actually sends the new value in the PATCH body - the Advanced settings timezone field is a real control", async () => {
  resetState();
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm({
    editingScheduleId: "sched-1",
    scheduleKind: "one_time",
    eventName: "Camp",
    timezone: "Asia/Tokyo",
  });
  installFetchMock((call) => (call.url === "/api/training-load/external-schedules/sched-1" && call.method === "PATCH"
    ? { status: 200, body: { schedule: { id: "sched-1" } } }
    : { status: 200, body: weekPayload("2026-08-24") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-schedule-submit" }), { renderTrainingLoad });
  const call = fetchCalls.find((c) => c.url === "/api/training-load/external-schedules/sched-1" && c.method === "PATCH");
  assert.ok(call, "expected the PATCH request to have been sent");
  assert.equal(call.body.timezone, "Asia/Tokyo", "a changed fallback timezone must actually be sent to the backend, not silently dropped");
});

test("T4. the Dates/Daily toggle genuinely works while Schedule again is open (not just while creating) - clicking Daily switches the kind and keeps the real interactive calendar, never the read-only Edit summary", async () => {
  resetState();
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm({
    scheduleAgainFromId: "sched-1",
    scheduleKind: "specific_dates",
    selectedDates: ["2026-09-01"],
  });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-schedule-set-recurrence", daily: "true" }), { renderTrainingLoad });
  const form = state.trainingLoad.scheduleForm;
  assert.equal(form.scheduleKind, "daily", "Schedule again must be free to switch kind, exactly like a real create");
  const html = renderExternalScheduleFormHtml();
  assert.ok(html.includes('data-action="training-load-calendar-day-click"'), "still the real interactive calendar - Schedule again is never treated as Edit's read-only mode");
});

// ------------------------------------------------------------
// U. Workspace-level master toggle for automatic planned-session RPE
// (Training Load -> Schedule, top of the tab).
// ------------------------------------------------------------

test("U1. the master toggle renders disabled and unchecked before the real value has loaded - never clickable against an unknown starting state", () => {
  resetState();
  const html = renderPlannedRpeMasterToggleHtml();
  assert.ok(html.includes("disabled"));
  assert.ok(!html.includes("is-on"));
  assert.ok(html.includes("Automatically collect RPE for planned sessions"));
  assert.ok(html.includes("Request RPE after sessions created in the Weekly Plan. Individual sessions can still be turned off."));
});

test("U2. once loaded, the toggle reflects the real value and is clickable - ON shows is-on and no 'off' note, OFF shows neither is-on nor a checked switch but DOES show the off note", () => {
  resetState();
  state.trainingLoad.plannedRpeSetting = { enabled: true, enabledAt: "2026-08-20T00:00:00Z", loaded: true, loading: false, saving: false, error: "" };
  const onHtml = renderPlannedRpeMasterToggleHtml();
  assert.ok(onHtml.includes("is-on"));
  assert.ok(!onHtml.includes("disabled"));
  assert.ok(!onHtml.includes("Automatic planned RPE is off"));

  state.trainingLoad.plannedRpeSetting = { enabled: false, enabledAt: null, loaded: true, loading: false, saving: false, error: "" };
  const offHtml = renderPlannedRpeMasterToggleHtml();
  assert.ok(!offHtml.includes("is-on"));
  assert.ok(!offHtml.includes("disabled"));
  assert.ok(offHtml.includes("Automatic planned RPE is off"));
});

test("U3. switching the tab to Schedule loads the master-toggle setting alongside the weekly payload", async () => {
  resetState();
  installFetchMock((call) => (call.url === "/api/training-load/planned-rpe-setting"
    ? { status: 200, body: { enabled: true, enabledAt: "2026-08-20T00:00:00Z" } }
    : { status: 200, body: weekPayload("2026-08-24") }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "schedule" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.plannedRpeSetting.enabled, true);
  assert.equal(state.trainingLoad.plannedRpeSetting.loaded, true);
});

test("U4. turning it OFF -> ON never asks for confirmation and saves immediately", async () => {
  resetState();
  state.trainingLoad.plannedRpeSetting = { enabled: false, enabledAt: null, loaded: true, loading: false, saving: false, error: "" };
  const originalConfirm = globalThis.window.confirm;
  let confirmCalled = false;
  globalThis.window.confirm = () => { confirmCalled = true; return true; };
  try {
    installFetchMock((call) => (call.url === "/api/training-load/planned-rpe-setting" && call.method === "PATCH"
      ? { status: 200, body: { enabled: true, enabledAt: "2026-08-31T00:00:00Z" } }
      : { status: 200, body: weekPayload("2026-08-24") }));
    await handleTrainingLoadAction(fakeAction({ action: "training-load-toggle-planned-rpe-master" }), { renderTrainingLoad });
    assert.equal(confirmCalled, false, "turning ON must never show a confirm dialog");
    assert.equal(state.trainingLoad.plannedRpeSetting.enabled, true);
    const patchCall = fetchCalls.find((c) => c.url === "/api/training-load/planned-rpe-setting" && c.method === "PATCH");
    assert.equal(patchCall.body.enabled, true);
  } finally {
    globalThis.window.confirm = originalConfirm;
  }
});

test("U5. turning it ON -> OFF shows a confirm dialog first - Cancel leaves the setting completely untouched and sends nothing", async () => {
  resetState();
  state.trainingLoad.plannedRpeSetting = { enabled: true, enabledAt: "2026-08-20T00:00:00Z", loaded: true, loading: false, saving: false, error: "" };
  const originalConfirm = globalThis.window.confirm;
  globalThis.window.confirm = () => false;
  try {
    installFetchMock(() => { throw new Error("must never fetch anything when the coach cancels"); });
    await handleTrainingLoadAction(fakeAction({ action: "training-load-toggle-planned-rpe-master" }), { renderTrainingLoad });
    assert.equal(state.trainingLoad.plannedRpeSetting.enabled, true, "Cancel must leave the value exactly as it was");
  } finally {
    globalThis.window.confirm = originalConfirm;
  }
});

test("U6. turning it ON -> OFF, then Confirm, actually saves and refreshes the visible rows", async () => {
  resetState();
  state.trainingLoad.section = "schedule";
  state.trainingLoad.plannedRpeSetting = { enabled: true, enabledAt: "2026-08-20T00:00:00Z", loaded: true, loading: false, saving: false, error: "" };
  const originalConfirm = globalThis.window.confirm;
  globalThis.window.confirm = () => true;
  try {
    installFetchMock((call) => (call.url === "/api/training-load/planned-rpe-setting" && call.method === "PATCH"
      ? { status: 200, body: { enabled: false, enabledAt: "2026-08-20T00:00:00Z" } }
      : { status: 200, body: weekPayload("2026-08-24") }));
    await handleTrainingLoadAction(fakeAction({ action: "training-load-toggle-planned-rpe-master" }), { renderTrainingLoad });
    assert.equal(state.trainingLoad.plannedRpeSetting.enabled, false);
    assert.equal(state.trainingLoad.plannedRpeSetting.saving, false);
    const weeklyRefetch = fetchCalls.find((c) => c.url.startsWith("/api/training-load/weekly"));
    assert.ok(weeklyRefetch, "the currently-visible rows must be refetched so their own status pills reflect the new state immediately");
  } finally {
    globalThis.window.confirm = originalConfirm;
  }
});

test("U7. clicking the toggle while a save is already in flight, or before the real value has loaded, is a safe no-op - never a double save, never a save against an unknown starting value", async () => {
  resetState();
  state.trainingLoad.plannedRpeSetting = { enabled: false, enabledAt: null, loaded: false, loading: false, saving: false, error: "" };
  installFetchMock(() => { throw new Error("must never fetch while not yet loaded"); });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-toggle-planned-rpe-master" }), { renderTrainingLoad });

  state.trainingLoad.plannedRpeSetting = { enabled: false, enabledAt: null, loaded: true, loading: false, saving: true, error: "" };
  await handleTrainingLoadAction(fakeAction({ action: "training-load-toggle-planned-rpe-master" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.plannedRpeSetting.enabled, false, "neither click must have changed anything");
});

test("U8. a workspace switch immediately drops the OLD workspace's own value, and a still-in-flight GET for it is dropped as stale rather than overwriting the new one", async () => {
  resetState();
  state.trainingLoad.plannedRpeSetting = { enabled: true, enabledAt: "2026-08-20T00:00:00Z", loaded: true, loading: false, saving: false, error: "" };
  const deferreds = installDeferredFetchMock();
  const inFlight = loadPlannedRpeSetting();
  assert.equal(deferreds.length, 1);
  resetTrainingLoadForWorkspaceChange();
  assert.equal(state.trainingLoad.plannedRpeSetting.loaded, false, "the old workspace's own value must be dropped THE INSTANT the switch happens, not just once the new fetch lands");
  deferreds[0].resolve({ status: 200, body: { enabled: true, enabledAt: "2026-08-01T00:00:00Z" } });
  await inFlight;
  assert.equal(state.trainingLoad.plannedRpeSetting.loaded, false, "the stale in-flight response (for the OLD workspace) must never overwrite the just-reset state");
});

test("U9. an individual planned session row shows a distinct 'Automatic RPE off' status, never a plain 'Not rated' that would look like a real pending request, while the master switch is off", () => {
  resetState();
  state.trainingLoad.weekly.schedule.data = weekPayload("2026-08-24", {
    "2026-08-24": [session({ workspacePlannedRpeEnabled: false, actionable: false })],
  });
  const html = renderTrainingLoadScheduleHtml();
  assert.ok(html.includes("Automatic RPE off"));
  assert.ok(!html.includes(">Not rated<"));
});

test("U10. the rated/planned denominator (Results) excludes an unrated session while the master switch is off, and includes it again once effectively on", () => {
  resetState();
  const offPayload = weekPayload("2026-08-24", {
    "2026-08-24": [session({ workspacePlannedRpeEnabled: false, actionable: false })],
  });
  state.trainingLoad.weekly.results.data = offPayload;
  const offHtml = renderTrainingLoadResultsHtml();
  assert.ok(offHtml.includes("0/0"), "an unrated, non-actionable (master off) session must never count toward the denominator");

  state.trainingLoad.weekly.results.data = weekPayload("2026-08-24", {
    "2026-08-24": [session({ workspacePlannedRpeEnabled: true, actionable: true })],
  });
  const onHtml = renderTrainingLoadResultsHtml();
  assert.ok(onHtml.includes("0/1"), "the same still-unrated session must count once the master switch is effectively on");
});

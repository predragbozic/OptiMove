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
const { loadTrainingLoadWeekly } = await import("../training-load-data.js");
const {
  formatFeedbackSummary,
  formatSrpe,
  renderTrainingLoadHomeCardHtml,
  renderTrainingLoadResultsHtml,
  renderTrainingLoadSessionListHtml,
  isRpeFormValid,
} = await import("../training-load-view.js");
const { emptyTrainingLoadState, emptyRpeForm, state } = await import("../state.js");

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
  return {
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
    ...overrides,
  };
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
  installFetchMock(() => { calls += 1; return { status: 200, body: weekPayload("2026-08-24") }; });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "schedule" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.section, "schedule");
  assert.equal(calls, 1);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "today" }), { renderTrainingLoad });
  assert.equal(calls, 2);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "schedule" }), { renderTrainingLoad });
  assert.equal(calls, 3, "switching back to schedule must fetch again, even though it already has data from the first visit");
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
  state.athletes = [
    { athlete_uuid: "a1", athlete: "Ana Anić", athlete_id: "1" },
    { athlete_uuid: "a2", athlete: "Bojan Bojić", athlete_id: "2" },
  ];
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

test("K1. opening the weekly overlay fetches once (if not already loaded) and shows it", async () => {
  resetState();
  let calls = 0;
  installFetchMock(() => { calls += 1; return { status: 200, body: weekPayload("2026-08-24") }; });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-athlete-weekly-open" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.athleteWeeklyOpen, true);
  assert.equal(calls, 1);
  assert.ok(state.trainingLoad.athleteWeekly.data);
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

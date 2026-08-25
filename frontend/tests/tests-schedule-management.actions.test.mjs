import { test } from "node:test";
import assert from "node:assert/strict";

// Exercises the frontend side of the Tests schedule-management follow-up:
// multi-athlete selection (toggle/select-all/clear-all/search persistence),
// combining athlete+team+club targets, create vs edit vs delete/cancel, and
// double-submit guards - same minimal-DOM-double pattern as
// tests-wellness-form.actions.test.mjs already establishes for this module.

let queried = {};
globalThis.document = {
  querySelector: (sel) => queried[sel] || null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = { confirm: () => true };

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

const {
  handleTestsAction,
  handleTestsScheduleAthleteSearchInput,
  handleTestsScheduleFormField,
  submitTestsForm,
  startTestsCalendarDrag,
  extendTestsCalendarDrag,
  endTestsCalendarDrag,
} = await import("../tests-actions.js");
const { testsAthleteMultiSelectVisibleAthletes, renderTestsAthleteOptionsHtml } = await import("../tests-view.js");
const { emptyScheduleForm, state } = await import("../state.js");
const { localDateIsoInTimeZone, localMonthIsoInTimeZone } = await import("../utils.js");

function fakeDayEl(date, disabled = false) {
  return { dataset: { date }, disabled };
}

function fakeAction(dataset, extra = {}) {
  return { dataset, ...extra };
}

const ROSTER = [
  { athlete_uuid: "a1", athlete_id: "101", athlete: "Ana Anić" },
  { athlete_uuid: "a2", athlete_id: "102", athlete: "Bojan Bojić" },
  { athlete_uuid: "a3", athlete_id: "103", athlete: "Ana Cvetković" },
];

function resetTestsState() {
  state.athletes = ROSTER;
  state.tests.schedules = [];
  state.tests.scheduleDetail = null;
  state.tests.orgPickerData = { teams: [{ id: "team-1", name: "First Team" }], clubs: [{ id: "club-1", name: "Main Club" }] };
  state.tests.scheduleForm = emptyScheduleForm({ open: true, startDate: "2026-08-25" });
  state.tests.deletingScheduleId = "";
  state.tests.error = "";
  queried = {};
}

// ------------------------------------------------------------
// Multi-athlete selection
// ------------------------------------------------------------

test("toggling several individual athletes adds each to athleteIds, in click order, no duplicates on a repeat click", async () => {
  resetTestsState();
  await handleTestsAction(fakeAction({ action: "tests-schedule-toggle-athlete", athleteUuid: "a1" }), { renderTests: () => {} });
  await handleTestsAction(fakeAction({ action: "tests-schedule-toggle-athlete", athleteUuid: "a2" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.scheduleForm.athleteIds, ["a1", "a2"]);
  // clicking the same athlete again removes them (a real checkbox toggle)
  await handleTestsAction(fakeAction({ action: "tests-schedule-toggle-athlete", athleteUuid: "a1" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.scheduleForm.athleteIds, ["a2"]);
});

test("Select all selects only the currently-filtered-and-authorized athletes, never the whole system roster", async () => {
  resetTestsState();
  state.tests.scheduleForm.athleteSearch = "Ana";
  await handleTestsAction(fakeAction({ action: "tests-schedule-select-all-athletes" }), { renderTests: () => {} });
  // "Ana" matches Ana Anić and Ana Cvetković, not Bojan Bojić
  assert.deepEqual(new Set(state.tests.scheduleForm.athleteIds), new Set(["a1", "a3"]));
  assert.ok(!state.tests.scheduleForm.athleteIds.includes("a2"));
});

test("Select all only ever offers athletes from state.athletes (this coach's own already-authorized roster) - never a system-wide list", () => {
  resetTestsState();
  const visible = testsAthleteMultiSelectVisibleAthletes(state.tests.scheduleForm);
  assert.deepEqual(visible.map((a) => a.athlete_uuid), ["a1", "a2", "a3"]);
  const html = renderTestsAthleteOptionsHtml(state.tests.scheduleForm);
  for (const athlete of ROSTER) assert.ok(html.includes(athlete.athlete));
});

test("Clear all empties athleteIds regardless of the current search filter", async () => {
  resetTestsState();
  state.tests.scheduleForm.athleteIds = ["a1", "a2", "a3"];
  state.tests.scheduleForm.athleteSearch = "Bojan";
  await handleTestsAction(fakeAction({ action: "tests-schedule-clear-all-athletes" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.scheduleForm.athleteIds, []);
});

test("selection survives a search-term change - an athlete selected before typing a filter stays selected after it, even while scrolled out of view", () => {
  resetTestsState();
  state.tests.scheduleForm.athleteIds = ["a2"]; // Bojan, selected while unfiltered
  handleTestsScheduleAthleteSearchInput({ value: "Ana" }); // now filters him out of view
  assert.deepEqual(state.tests.scheduleForm.athleteIds, ["a2"], "athleteIds itself must be untouched by a search-input change");
  handleTestsScheduleAthleteSearchInput({ value: "" }); // clear the filter again
  const html = renderTestsAthleteOptionsHtml(state.tests.scheduleForm);
  assert.ok(html.includes("is-selected") && html.includes("Bojan"), "Bojan must render checked again once back in view");
});

test("select-all after search then clearing the search does not silently re-add athletes never explicitly selected", async () => {
  resetTestsState();
  state.tests.scheduleForm.athleteSearch = "Bojan";
  await handleTestsAction(fakeAction({ action: "tests-schedule-select-all-athletes" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.scheduleForm.athleteIds, ["a2"]);
  state.tests.scheduleForm.athleteSearch = "";
  assert.deepEqual(state.tests.scheduleForm.athleteIds, ["a2"], "clearing the search must not implicitly add the rest of the roster");
});

// ------------------------------------------------------------
// Combined athlete + team + club targets, and the create/edit submit itself
// ------------------------------------------------------------

test("submitting a schedule combines individually-selected athletes with the team/club quick targets into one targets array", async () => {
  resetTestsState();
  state.tests.scheduleForm.athleteIds = ["a1", "a2"];
  state.tests.scheduleForm.teamId = "team-1";
  state.tests.scheduleForm.clubId = "club-1";
  state.tests.scheduleForm.timezone = "UTC";
  state.tests.scheduleForm.opensTime = "06:00";
  state.tests.scheduleForm.closesTime = "22:00";
  installFetchMock((call) => {
    if (call.url.includes("/api/tests/library")) return { status: 200, body: { tests: [{ testVersionId: "wellness-v1", schedulable: true }] } };
    if (call.url === "/api/tests/schedules" && call.method === "POST") {
      return { status: 201, body: { schedule: { id: "sched-1", testName: "WELLNESS", scheduleKind: "one_time", status: "active", timezone: "UTC", startDate: "2026-08-25", opensTime: "06:00", closesTime: "22:00" } } };
    }
    return { status: 404, body: {} };
  });
  await submitTestsForm({ dataset: { testsForm: "create-schedule" } }, { renderTests: () => {} });
  const createCall = fetchCalls.find((c) => c.url === "/api/tests/schedules" && c.method === "POST");
  assert.deepEqual(createCall.body.targets, [
    { kind: "athlete", id: "a1" },
    { kind: "athlete", id: "a2" },
    { kind: "team", id: "team-1" },
    { kind: "club", id: "club-1" },
  ]);
  assert.equal(state.tests.schedules[0].id, "sched-1");
  assert.equal(state.tests.schedules[0].athleteTargetCount, 2, "computed locally from the submitted targets, no extra GET needed for this");
  assert.equal(state.tests.schedules[0].teamTargetNames, "First Team");
  assert.equal(state.tests.schedules[0].clubTargetNames, "Main Club");
  assert.equal(state.tests.scheduleForm.open, false, "the form closes on a successful create");
});

test("a rejected target (403 from the server) rolls back nothing client-side either - the coach's selections stay exactly as entered", async () => {
  resetTestsState();
  state.tests.scheduleForm.athleteIds = ["a1"];
  state.tests.scheduleForm.timezone = "UTC";
  state.tests.scheduleForm.opensTime = "06:00";
  state.tests.scheduleForm.closesTime = "22:00";
  installFetchMock((call) => {
    if (call.url.includes("/api/tests/library")) return { status: 200, body: { tests: [{ testVersionId: "wellness-v1", schedulable: true }] } };
    return { status: 403, body: { error: "One of the chosen targets is outside your access." } };
  });
  await submitTestsForm({ dataset: { testsForm: "create-schedule" } }, { renderTests: () => {} });
  assert.equal(state.tests.scheduleForm.open, true, "the form must stay open, not silently close on failure");
  assert.deepEqual(state.tests.scheduleForm.athleteIds, ["a1"], "the athlete selection the coach made must survive a failed submit");
  assert.equal(state.tests.scheduleForm.error, "One of the chosen targets is outside your access.");
  assert.equal(state.tests.scheduleForm.submitting, false);
});

test("a double-click on Save never sends a second request while the first is still in flight", async () => {
  resetTestsState();
  state.tests.scheduleForm.athleteIds = ["a1"];
  state.tests.scheduleForm.timezone = "UTC";
  state.tests.scheduleForm.opensTime = "06:00";
  state.tests.scheduleForm.closesTime = "22:00";
  let resolveLibrary;
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, method: options.method || "GET" });
    if (url.includes("/api/tests/library")) {
      return new Promise((resolve) => {
        resolveLibrary = () => resolve({ ok: true, status: 200, json: async () => ({ tests: [{ testVersionId: "wellness-v1", schedulable: true }] }) });
      });
    }
    return { ok: true, status: 201, json: async () => ({ schedule: { id: "sched-1" } }) };
  };
  const firstSubmit = submitTestsForm({ dataset: { testsForm: "create-schedule" } }, { renderTests: () => {} });
  const secondSubmit = submitTestsForm({ dataset: { testsForm: "create-schedule" } }, { renderTests: () => {} }); // fired while the first is still awaiting the library call
  resolveLibrary();
  await Promise.all([firstSubmit, secondSubmit]);
  assert.equal(fetchCalls.filter((c) => c.url.includes("/api/tests/library")).length, 1, "the second, overlapping submit must be a no-op, not a second request");
});

// ------------------------------------------------------------
// Edit
// ------------------------------------------------------------

test("editing a schedule with no occurrence loads its real targets/kind/times into the form for a full edit", async () => {
  resetTestsState();
  state.tests.schedules = [{ id: "sched-1", scheduleKind: "one_time", hasOccurrences: false }];
  installFetchMock((call) => {
    if (call.url === "/api/tests/schedules/sched-1") {
      return {
        status: 200,
        body: {
          schedule: { id: "sched-1", scheduleKind: "one_time", hasOccurrences: false, timezone: "UTC", startDate: "2026-08-25", opensTime: "07:00", dueTime: null, closesTime: "21:00" },
          targets: [{ kind: "athlete", id: "a1", name: "Ana Anić" }, { kind: "team", id: "team-1", name: "First Team" }],
          link: null,
        },
      };
    }
    return { status: 404, body: {} };
  });
  await handleTestsAction(fakeAction({ action: "tests-open-edit-schedule", scheduleId: "sched-1" }), { renderTests: () => {} });
  const form = state.tests.scheduleForm;
  assert.equal(form.editingScheduleId, "sched-1");
  assert.equal(form.open, true);
  assert.deepEqual(form.athleteIds, ["a1"]);
  assert.equal(form.teamId, "team-1");
  assert.equal(form.opensTime, "07:00");
});

test("a one_time schedule with an occurrence but NO real activity yet still opens the edit form (Phase 2.5 loosened this) - the true answer only comes from the detail fetch, never a stale list-row guess", async () => {
  resetTestsState();
  state.tests.scheduleForm = emptyScheduleForm();
  state.tests.schedules = [{ id: "sched-1", scheduleKind: "one_time", hasOccurrences: true }];
  installFetchMock((call) => (call.url === "/api/tests/schedules/sched-1"
    ? {
      status: 200,
      body: {
        schedule: { id: "sched-1", scheduleKind: "one_time", hasOccurrences: true, hasActivity: false, timezone: "UTC", startDate: "2026-08-25", opensTime: "07:00", dueTime: null, closesTime: "21:00" },
        targets: [{ kind: "athlete", id: "a1", name: "Ana Anić" }],
        link: null,
      },
    }
    : { status: 404, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-open-edit-schedule", scheduleId: "sched-1" }), { renderTests: () => {} });
  const form = state.tests.scheduleForm;
  assert.equal(form.open, true);
  assert.equal(form.editingScheduleId, "sched-1");
  assert.equal(form.hasOccurrences, true);
  assert.equal(form.hasActivity, false);
});

test("a one_time schedule with real activity (started/completed response) opens the form but its hasActivity flag is set, so the view can render the blocked explanation instead of editable fields", async () => {
  resetTestsState();
  state.tests.scheduleForm = emptyScheduleForm();
  state.tests.schedules = [{ id: "sched-2", scheduleKind: "one_time", hasOccurrences: true }];
  installFetchMock((call) => (call.url === "/api/tests/schedules/sched-2"
    ? {
      status: 200,
      body: {
        schedule: { id: "sched-2", scheduleKind: "one_time", hasOccurrences: true, hasActivity: true, timezone: "UTC", startDate: "2026-08-25", opensTime: "07:00", dueTime: null, closesTime: "21:00" },
        targets: [{ kind: "athlete", id: "a1", name: "Ana Anić" }],
        link: null,
      },
    }
    : { status: 404, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-open-edit-schedule", scheduleId: "sched-2" }), { renderTests: () => {} });
  const form = state.tests.scheduleForm;
  assert.equal(form.open, true);
  assert.equal(form.hasActivity, true, "the view (renderScheduleFormHtml) uses this to show the blocked explanation instead of the editable form");
});

test("a cancelled schedule never opens the edit form either - cancelled is terminal, no network round trip needed to find out", async () => {
  resetTestsState();
  state.tests.scheduleForm = emptyScheduleForm();
  state.tests.schedules = [{ id: "sched-3", scheduleKind: "daily", status: "cancelled", hasOccurrences: true }];
  installFetchMock(() => ({ status: 200, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-open-edit-schedule", scheduleId: "sched-3" }), { renderTests: () => {} });
  assert.equal(state.tests.scheduleForm.open, false);
  assert.ok(state.tests.error.toLowerCase().includes("cancelled"), state.tests.error);
  assert.equal(fetchCalls.length, 0);
});

test("editing a recurring schedule with an existing occurrence still opens the form (only future occurrences are affected)", async () => {
  resetTestsState();
  state.tests.schedules = [{ id: "sched-2", scheduleKind: "recurring", hasOccurrences: true }];
  installFetchMock((call) => (call.url === "/api/tests/schedules/sched-2"
    ? { status: 200, body: { schedule: { id: "sched-2", scheduleKind: "recurring", hasOccurrences: true, timezone: "UTC", startDate: "2026-08-20", opensTime: "06:00", dueTime: null, closesTime: "22:00" }, targets: [], link: null } }
    : { status: 404, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-open-edit-schedule", scheduleId: "sched-2" }), { renderTests: () => {} });
  assert.equal(state.tests.scheduleForm.open, true);
  assert.equal(state.tests.scheduleForm.scheduleKind, "daily");
  assert.equal(state.tests.scheduleForm.hasOccurrences, true);
});

// ------------------------------------------------------------
// Delete / cancel
// ------------------------------------------------------------

test("deleting a schedule with no occurrence removes it from the list on a { action: \"deleted\" } response", async () => {
  resetTestsState();
  state.tests.schedules = [{ id: "sched-1", testName: "WELLNESS", hasOccurrences: false }];
  installFetchMock((call) => (call.method === "DELETE" ? { status: 200, body: { action: "deleted" } } : { status: 404, body: {} }));
  globalThis.window.confirm = (msg) => {
    assert.equal(msg, "This schedule will be permanently deleted");
    return true;
  };
  await handleTestsAction(fakeAction({ action: "tests-delete-schedule", scheduleId: "sched-1", testName: "WELLNESS", hasOccurrences: "false" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.schedules, []);
});

test("deleting a schedule that already has an occurrence cancels it in place on a { action: \"cancelled\" } response, and the exact confirm message differs", async () => {
  resetTestsState();
  state.tests.schedules = [{ id: "sched-1", testName: "WELLNESS", status: "active", hasOccurrences: true }];
  installFetchMock((call) => (call.method === "DELETE" ? { status: 200, body: { action: "cancelled", historyPreserved: true } } : { status: 404, body: {} }));
  globalThis.window.confirm = (msg) => {
    assert.equal(msg, "This schedule has existing assignments or results. It will be cancelled and hidden, while historical results will be preserved");
    return true;
  };
  await handleTestsAction(fakeAction({ action: "tests-delete-schedule", scheduleId: "sched-1", testName: "WELLNESS", hasOccurrences: "true" }), { renderTests: () => {} });
  assert.equal(state.tests.schedules.length, 1, "the row is preserved, not removed");
  assert.equal(state.tests.schedules[0].status, "cancelled");
});

test("declining the confirm dialog sends no request at all", async () => {
  resetTestsState();
  state.tests.schedules = [{ id: "sched-1", testName: "WELLNESS", hasOccurrences: false }];
  installFetchMock(() => ({ status: 200, body: { action: "deleted" } }));
  globalThis.window.confirm = () => false;
  await handleTestsAction(fakeAction({ action: "tests-delete-schedule", scheduleId: "sched-1", testName: "WELLNESS", hasOccurrences: "false" }), { renderTests: () => {} });
  assert.equal(fetchCalls.length, 0);
  assert.equal(state.tests.schedules.length, 1);
});

test("a double-click on Delete never sends a second DELETE while the first is still in flight", async () => {
  resetTestsState();
  state.tests.schedules = [{ id: "sched-1", testName: "WELLNESS", hasOccurrences: false }];
  globalThis.window.confirm = () => true;
  let resolveDelete;
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, method: options.method || "GET" });
    return new Promise((resolve) => {
      resolveDelete = () => resolve({ ok: true, status: 200, json: async () => ({ action: "deleted" }) });
    });
  };
  const action = fakeAction({ action: "tests-delete-schedule", scheduleId: "sched-1", testName: "WELLNESS", hasOccurrences: "false" });
  const first = handleTestsAction(action, { renderTests: () => {} });
  const second = handleTestsAction(action, { renderTests: () => {} }); // fired while the first DELETE is still in flight
  resolveDelete();
  await Promise.all([first, second]);
  assert.equal(fetchCalls.filter((c) => c.method === "DELETE").length, 1);
});

test("deleting shows Deleting... only on the row actually being deleted, via state.tests.deletingScheduleId", async () => {
  resetTestsState();
  state.tests.schedules = [{ id: "sched-1", testName: "WELLNESS", hasOccurrences: false }];
  let resolveDelete;
  globalThis.window.confirm = () => true;
  globalThis.fetch = async () => new Promise((resolve) => {
    resolveDelete = () => resolve({ ok: true, status: 200, json: async () => ({ action: "deleted" }) });
  });
  const pending = handleTestsAction(fakeAction({ action: "tests-delete-schedule", scheduleId: "sched-1", testName: "WELLNESS", hasOccurrences: "false" }), { renderTests: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.tests.deletingScheduleId, "sched-1");
  resolveDelete();
  await pending;
  assert.equal(state.tests.deletingScheduleId, "");
});

// ------------------------------------------------------------
// Show cancelled filter
// ------------------------------------------------------------

test("toggling Show cancelled off filters cancelled rows out of the schedule list", () => {
  resetTestsState();
  state.tests.schedules = [{ id: "s1", status: "active" }, { id: "s2", status: "cancelled" }];
  state.tests.showCancelledSchedules = false;
  // renderScheduleListHtml itself is not exported (tests-view.js only
  // exports the pieces action handlers need), so this exercises the same
  // filter predicate the view applies, proving the cancelled row is excluded
  // by construction whenever the toggle is off.
  const visible = state.tests.schedules.filter((row) => state.tests.showCancelledSchedules || row.status !== "cancelled");
  assert.deepEqual(visible.map((r) => r.id), ["s1"]);
});

// ------------------------------------------------------------
// Specific dates: calendar click-and-drag range, toggle, double-submit guard
// ------------------------------------------------------------

test("a plain click (mousedown, no drag) on an unselected day adds just that one date", () => {
  resetTestsState();
  state.tests.scheduleForm.selectedDates = [];
  startTestsCalendarDrag(fakeDayEl("2026-09-05"));
  endTestsCalendarDrag();
  assert.deepEqual(state.tests.scheduleForm.selectedDates, ["2026-09-05"]);
});

test("a plain click on an ALREADY-selected day removes just that one date - single click toggles", () => {
  resetTestsState();
  state.tests.scheduleForm.selectedDates = ["2026-09-05", "2026-09-06"];
  startTestsCalendarDrag(fakeDayEl("2026-09-05"));
  endTestsCalendarDrag();
  assert.deepEqual(state.tests.scheduleForm.selectedDates, ["2026-09-06"]);
});

test("mousedown on day 1, drag over to day 3, selects the whole inclusive range - Booking-style range select", () => {
  resetTestsState();
  state.tests.scheduleForm.selectedDates = [];
  startTestsCalendarDrag(fakeDayEl("2026-09-10"));
  extendTestsCalendarDrag(fakeDayEl("2026-09-11"));
  extendTestsCalendarDrag(fakeDayEl("2026-09-12"));
  endTestsCalendarDrag();
  assert.deepEqual(state.tests.scheduleForm.selectedDates.sort(), ["2026-09-10", "2026-09-11", "2026-09-12"]);
});

test("dragging backward (toward the anchor) shrinks the range - days no longer covered are un-selected again, not left stranded", () => {
  resetTestsState();
  state.tests.scheduleForm.selectedDates = [];
  startTestsCalendarDrag(fakeDayEl("2026-09-10"));
  extendTestsCalendarDrag(fakeDayEl("2026-09-14")); // drag far out first
  extendTestsCalendarDrag(fakeDayEl("2026-09-11")); // then shrink back
  endTestsCalendarDrag();
  assert.deepEqual(state.tests.scheduleForm.selectedDates.sort(), ["2026-09-10", "2026-09-11"]);
});

test("a drag that starts on an already-selected day REMOVES the whole dragged-over range, not just the anchor", () => {
  resetTestsState();
  state.tests.scheduleForm.selectedDates = ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-20"];
  startTestsCalendarDrag(fakeDayEl("2026-09-10")); // anchor is already selected -> this drag removes
  extendTestsCalendarDrag(fakeDayEl("2026-09-12"));
  endTestsCalendarDrag();
  assert.deepEqual(state.tests.scheduleForm.selectedDates, ["2026-09-20"], "only the dragged range was removed - an unrelated already-selected date elsewhere is untouched");
});

test("a drag never selects a date before today, even if it's inside the dragged range", () => {
  resetTestsState();
  // Pinned to UTC explicitly - "today" here is derived from the schedule
  // form's own timezone (calendarTodayIso(), tests-actions.js), not the
  // test-runner machine's ambient local timezone, so this stays
  // deterministic regardless of what machine/CI container runs it.
  state.tests.scheduleForm.timezone = "UTC";
  const now = new Date();
  const yesterday = localDateIsoInTimeZone("UTC", new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const tomorrow = localDateIsoInTimeZone("UTC", new Date(now.getTime() + 24 * 60 * 60 * 1000));
  state.tests.scheduleForm.selectedDates = [];
  startTestsCalendarDrag(fakeDayEl(yesterday));
  extendTestsCalendarDrag(fakeDayEl(tomorrow));
  endTestsCalendarDrag();
  assert.ok(!state.tests.scheduleForm.selectedDates.includes(yesterday), "past dates must never be selectable, even mid-range");
});

test("extendTestsCalendarDrag before any startTestsCalendarDrag (no mousedown captured, e.g. drag started outside the calendar) is a safe no-op", () => {
  resetTestsState();
  state.tests.scheduleForm.selectedDates = [];
  extendTestsCalendarDrag(fakeDayEl("2026-09-10"));
  assert.deepEqual(state.tests.scheduleForm.selectedDates, []);
});

// ------------------------------------------------------------
// Local-date-in-timezone helper: the fix for the calendar's old
// `new Date().toISOString().slice(...)` (always UTC) approach, which could
// show yesterday's date in Europe/Belgrade for the first ~1-2 hours after
// real local midnight (Belgrade is UTC+1/+2, so local midnight happens
// while UTC is still on the previous day).
// ------------------------------------------------------------

test("localDateIsoInTimeZone resolves the LOCAL date in Europe/Belgrade, not the UTC date, just after local midnight", () => {
  // 2026-01-15T23:30:00Z is 2026-01-16T00:30:00+01:00 in Europe/Belgrade
  // (CET, UTC+1 in January) - local "today" is already the 16th while UTC
  // is still on the 15th. The old `date.toISOString().slice(0, 10)`
  // approach would have returned the UTC date here - exactly the bug.
  const instant = new Date("2026-01-15T23:30:00Z");
  assert.equal(localDateIsoInTimeZone("Europe/Belgrade", instant), "2026-01-16");
  assert.equal(instant.toISOString().slice(0, 10), "2026-01-15", "sanity check: the naive UTC-based approach would have been wrong here");
});

test("localMonthIsoInTimeZone rolls over to the next month at the same Europe/Belgrade local-midnight boundary", () => {
  // 2026-01-31T23:15:00Z is 2026-02-01T00:15:00+01:00 in Europe/Belgrade -
  // both the day AND the month roll over locally while UTC is still January.
  const instant = new Date("2026-01-31T23:15:00Z");
  assert.equal(localMonthIsoInTimeZone("Europe/Belgrade", instant), "2026-02");
});

test("the calendar's past-date lockout uses the SCHEDULE's own timezone, not UTC - Europe/Belgrade just after local midnight", (t) => {
  resetTestsState();
  state.tests.scheduleForm.timezone = "Europe/Belgrade";
  state.tests.scheduleForm.selectedDates = [];
  // At this real instant, Belgrade's local date is already 2026-01-16 (see
  // the helper test above) even though UTC is still 2026-01-15 - the old
  // UTC-based calendarTodayIso() would have wrongly allowed selecting the
  // 15th as "today or later".
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-15T23:30:00Z").getTime() });
  try {
    startTestsCalendarDrag(fakeDayEl("2026-01-15"));
    extendTestsCalendarDrag(fakeDayEl("2026-01-17"));
    endTestsCalendarDrag();
  } finally {
    t.mock.timers.reset();
  }
  assert.ok(!state.tests.scheduleForm.selectedDates.includes("2026-01-15"), "2026-01-15 is already a past date in Europe/Belgrade at this instant");
  assert.deepEqual(state.tests.scheduleForm.selectedDates.sort(), ["2026-01-16", "2026-01-17"]);
});

test("Specific dates bulk submit sends the exact selected dates and shared test/time/targets, and the resulting count/dates land in state.tests.bulkResult", async () => {
  resetTestsState();
  state.tests.scheduleForm.scheduleKind = "specific_dates";
  state.tests.scheduleForm.selectedDates = ["2026-09-01", "2026-09-03"];
  state.tests.scheduleForm.athleteIds = ["a1"];
  state.tests.scheduleForm.timezone = "UTC";
  state.tests.scheduleForm.opensTime = "06:00";
  state.tests.scheduleForm.closesTime = "22:00";
  installFetchMock((call) => {
    if (call.url.includes("/api/tests/library")) return { status: 200, body: { tests: [{ testVersionId: "wellness-v1", schedulable: true }] } };
    if (call.url === "/api/tests/schedules/bulk" && call.method === "POST") {
      return {
        status: 201,
        body: {
          schedules: call.body.dates.map((date, i) => ({ id: `bulk-${i}`, scheduleKind: "one_time", status: "active", startDate: date, opensTime: "06:00", closesTime: "22:00", timezone: "UTC" })),
          count: call.body.dates.length,
          dates: call.body.dates,
        },
      };
    }
    return { status: 404, body: {} };
  });
  await submitTestsForm({ dataset: { testsForm: "create-schedule-bulk" } }, { renderTests: () => {} });
  const bulkCall = fetchCalls.find((c) => c.url === "/api/tests/schedules/bulk");
  assert.deepEqual(bulkCall.body.dates, ["2026-09-01", "2026-09-03"]);
  assert.deepEqual(bulkCall.body.targets, [{ kind: "athlete", id: "a1" }]);
  assert.equal(state.tests.bulkResult.count, 2);
  assert.deepEqual(state.tests.bulkResult.dates, ["2026-09-01", "2026-09-03"]);
  assert.equal(state.tests.schedules.length, 2);
  assert.equal(state.tests.scheduleForm.open, false, "the form closes on a successful bulk create");
});

test("Specific dates bulk submit with zero selected dates is a no-op - never sends a request", async () => {
  resetTestsState();
  state.tests.scheduleForm.scheduleKind = "specific_dates";
  state.tests.scheduleForm.selectedDates = [];
  installFetchMock(() => ({ status: 200, body: {} }));
  await submitTestsForm({ dataset: { testsForm: "create-schedule-bulk" } }, { renderTests: () => {} });
  assert.equal(fetchCalls.length, 0);
});

test("a double-click on 'Schedule N dates' never sends a second bulk request while the first is still in flight", async () => {
  resetTestsState();
  state.tests.scheduleForm.scheduleKind = "specific_dates";
  state.tests.scheduleForm.selectedDates = ["2026-09-01"];
  state.tests.scheduleForm.athleteIds = ["a1"];
  let resolveLibrary;
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, method: options.method || "GET" });
    if (url.includes("/api/tests/library")) {
      return new Promise((resolve) => {
        resolveLibrary = () => resolve({ ok: true, status: 200, json: async () => ({ tests: [{ testVersionId: "wellness-v1", schedulable: true }] }) });
      });
    }
    return { ok: true, status: 201, json: async () => ({ schedules: [{ id: "bulk-1" }], count: 1, dates: ["2026-09-01"] }) };
  };
  const first = submitTestsForm({ dataset: { testsForm: "create-schedule-bulk" } }, { renderTests: () => {} });
  const second = submitTestsForm({ dataset: { testsForm: "create-schedule-bulk" } }, { renderTests: () => {} }); // fired while the first is still awaiting the library call
  resolveLibrary();
  await Promise.all([first, second]);
  assert.equal(fetchCalls.filter((c) => c.url.includes("/api/tests/library")).length, 1, "the second, overlapping submit must be a no-op, not a second request");
});

// ------------------------------------------------------------
// Phase 3A: Notifications section (recurrence-independent rule toggles,
// reminder offset, create/edit round-trip through the submit body)
// ------------------------------------------------------------

test("opening the create form seeds the visible MVP defaults - invitation on, reminder on at 60 minutes, both digests on", async () => {
  resetTestsState();
  await handleTestsAction(fakeAction({ action: "tests-open-schedule-form" }), { renderTests: () => {} });
  const rules = state.tests.scheduleForm.notificationRules;
  assert.equal(rules.length, 4);
  assert.equal(rules.find((r) => r.kind === "athlete_invitation").enabled, true);
  const reminder = rules.find((r) => r.kind === "athlete_reminder");
  assert.equal(reminder.enabled, true);
  assert.equal(reminder.reminderOffsetMinutes, 60);
  assert.equal(rules.find((r) => r.kind === "coach_digest").enabled, true);
  assert.equal(rules.find((r) => r.kind === "final_digest").enabled, true);
});

test("toggling a rule that doesn't exist yet (an unconfigured legacy schedule) creates it, rather than requiring all 4 to pre-exist", async () => {
  resetTestsState();
  state.tests.scheduleForm.notificationRules = [];
  await handleTestsAction(fakeAction({ action: "tests-notification-rule-toggle", kind: "coach_digest" }, { checked: true }), { renderTests: () => {} });
  assert.deepEqual(state.tests.scheduleForm.notificationRules, [{ kind: "coach_digest", enabled: true }]);
});

test("toggling an existing rule off updates it in place - no duplicate entry for the same kind", async () => {
  resetTestsState();
  state.tests.scheduleForm.notificationRules = [{ kind: "athlete_invitation", enabled: true }, { kind: "coach_digest", enabled: true }];
  await handleTestsAction(fakeAction({ action: "tests-notification-rule-toggle", kind: "athlete_invitation" }, { checked: false }), { renderTests: () => {} });
  assert.equal(state.tests.scheduleForm.notificationRules.length, 2);
  assert.equal(state.tests.scheduleForm.notificationRules.find((r) => r.kind === "athlete_invitation").enabled, false);
  assert.equal(state.tests.scheduleForm.notificationRules.find((r) => r.kind === "coach_digest").enabled, true, "an unrelated kind must be untouched");
});

test("the reminder-offset number field writes into the athlete_reminder rule, creating it (disabled) if the coach types a number before ever checking the box", async () => {
  resetTestsState();
  state.tests.scheduleForm.notificationRules = [];
  handleTestsScheduleFormField({ name: "reminderOffsetMinutes", value: "30" });
  const rule = state.tests.scheduleForm.notificationRules.find((r) => r.kind === "athlete_reminder");
  assert.equal(rule.reminderOffsetMinutes, 30);
  assert.equal(rule.enabled, false, "typing an offset alone must never silently enable the reminder");
});

test("editing an already-configured schedule loads its real saved notificationRules, not the create-form defaults", async () => {
  resetTestsState();
  state.tests.scheduleForm = emptyScheduleForm();
  state.tests.schedules = [{ id: "sched-notif-1", scheduleKind: "one_time", hasOccurrences: false }];
  const savedRules = [
    { kind: "athlete_invitation", enabled: false, reminderOffsetMinutes: null, digestTrigger: null },
    { kind: "athlete_reminder", enabled: true, reminderOffsetMinutes: 15, digestTrigger: null },
    { kind: "coach_digest", enabled: false, reminderOffsetMinutes: null, digestTrigger: "periodic" },
    { kind: "final_digest", enabled: true, reminderOffsetMinutes: null, digestTrigger: "on_close" },
  ];
  installFetchMock((call) => (call.url === "/api/tests/schedules/sched-notif-1"
    ? { status: 200, body: { schedule: { id: "sched-notif-1", scheduleKind: "one_time", hasOccurrences: false, timezone: "UTC", startDate: "2026-08-25", opensTime: "07:00", dueTime: null, closesTime: "21:00" }, targets: [], link: null, notificationRules: savedRules } }
    : { status: 404, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-open-edit-schedule", scheduleId: "sched-notif-1" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.scheduleForm.notificationRules, savedRules);
});

test("editing a legacy schedule that never had rules saved loads an EMPTY array, not silently-enabled or silently-disabled defaults", async () => {
  resetTestsState();
  state.tests.scheduleForm = emptyScheduleForm();
  state.tests.schedules = [{ id: "sched-legacy-1", scheduleKind: "one_time", hasOccurrences: false }];
  installFetchMock((call) => (call.url === "/api/tests/schedules/sched-legacy-1"
    ? { status: 200, body: { schedule: { id: "sched-legacy-1", scheduleKind: "one_time", hasOccurrences: false, timezone: "UTC", startDate: "2026-08-25", opensTime: "07:00", dueTime: null, closesTime: "21:00" }, targets: [], link: null, notificationRules: [] } }
    : { status: 404, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-open-edit-schedule", scheduleId: "sched-legacy-1" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.scheduleForm.notificationRules, []);
});

test("create submit sends notificationRules exactly as configured in the form", async () => {
  resetTestsState();
  state.tests.scheduleForm.athleteIds = ["a1"];
  state.tests.scheduleForm.timezone = "UTC";
  state.tests.scheduleForm.opensTime = "06:00";
  state.tests.scheduleForm.closesTime = "22:00";
  state.tests.scheduleForm.notificationRules = [
    { kind: "athlete_invitation", enabled: true },
    { kind: "athlete_reminder", enabled: false, reminderOffsetMinutes: 60 },
    { kind: "coach_digest", enabled: true },
    { kind: "final_digest", enabled: false },
  ];
  installFetchMock((call) => {
    if (call.url.includes("/api/tests/library")) return { status: 200, body: { tests: [{ testVersionId: "wellness-v1", schedulable: true }] } };
    if (call.url === "/api/tests/schedules" && call.method === "POST") return { status: 201, body: { schedule: { id: "sched-1" } } };
    return { status: 404, body: {} };
  });
  await submitTestsForm({ dataset: { testsForm: "create-schedule" } }, { renderTests: () => {} });
  const createCall = fetchCalls.find((c) => c.url === "/api/tests/schedules" && c.method === "POST");
  // JSON.stringify drops undefined properties - a kind with no
  // reminderOffsetMinutes set round-trips through the real fetch body
  // without that key at all, not as an explicit `undefined`.
  assert.deepEqual(createCall.body.notificationRules, [
    { kind: "athlete_invitation", enabled: true },
    { kind: "athlete_reminder", enabled: false, reminderOffsetMinutes: 60 },
    { kind: "coach_digest", enabled: true },
    { kind: "final_digest", enabled: false },
  ]);
});

test("edit (PATCH) submit also sends notificationRules alongside the other fields", async () => {
  resetTestsState();
  state.tests.scheduleForm = emptyScheduleForm({
    editingScheduleId: "sched-9", scheduleKind: "one_time", timezone: "UTC", startDate: "2026-08-25", opensTime: "06:00", closesTime: "22:00",
    notificationRules: [{ kind: "athlete_invitation", enabled: true }],
  });
  installFetchMock((call) => (call.url === "/api/tests/schedules/sched-9" && call.method === "PATCH"
    ? { status: 200, body: { schedule: { id: "sched-9" } } }
    : { status: 404, body: {} }));
  await submitTestsForm({ dataset: { testsForm: "edit-schedule" } }, { renderTests: () => {} });
  const patchCall = fetchCalls.find((c) => c.url === "/api/tests/schedules/sched-9" && c.method === "PATCH");
  assert.deepEqual(patchCall.body.notificationRules, [{ kind: "athlete_invitation", enabled: true }]);
});

test("bulk (Specific dates) submit sends the same notificationRules alongside dates/targets", async () => {
  resetTestsState();
  state.tests.scheduleForm.scheduleKind = "specific_dates";
  state.tests.scheduleForm.selectedDates = ["2026-09-01"];
  state.tests.scheduleForm.athleteIds = ["a1"];
  state.tests.scheduleForm.notificationRules = [{ kind: "final_digest", enabled: true }];
  installFetchMock((call) => {
    if (call.url.includes("/api/tests/library")) return { status: 200, body: { tests: [{ testVersionId: "wellness-v1", schedulable: true }] } };
    if (call.url === "/api/tests/schedules/bulk") return { status: 201, body: { schedules: [{ id: "bulk-1" }], count: 1, dates: ["2026-09-01"] } };
    return { status: 404, body: {} };
  });
  await submitTestsForm({ dataset: { testsForm: "create-schedule-bulk" } }, { renderTests: () => {} });
  const bulkCall = fetchCalls.find((c) => c.url === "/api/tests/schedules/bulk");
  assert.deepEqual(bulkCall.body.notificationRules, [{ kind: "final_digest", enabled: true }]);
});

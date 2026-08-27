import { test } from "node:test";
import assert from "node:assert/strict";

// Tests/WELLNESS UX round 2: the Builder-style Recipients picker (item 1),
// direct calendar open/close with X/check + Daily auto-close (item 2),
// compact notification switches (item 3), and "Schedule again" (item 4).
// Same minimal-DOM-double pattern already established by
// tests-schedule-management.actions.test.mjs for this module.

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

const {
  handleTestsAction,
  submitTestsForm,
  startTestsCalendarDrag,
  extendTestsCalendarDrag,
  endTestsCalendarDrag,
  resetTestsCalendarInteractionState,
} = await import("../tests-actions.js");
const {
  renderScheduleFormHtml,
  renderRecipientPickerHtml,
  renderWellnessFormHtml,
  testsCalendarMode,
} = await import("../tests-view.js");
const { emptyScheduleForm, emptyWellnessForm, state } = await import("../state.js");

function fakeDayEl(date, disabled = false) {
  return { dataset: { date }, disabled };
}

function fakeAction(dataset, extra = {}) {
  return { dataset, ...extra };
}

const ROSTER = [
  { athlete_uuid: "a1", athlete_id: "101", athlete: "Ana Anić" },
  { athlete_uuid: "a2", athlete_id: "102", athlete: "Bojan Bojić" },
];

function resetTestsState(overrides = {}) {
  state.athletes = ROSTER;
  state.tests = state.tests || {};
  state.tests.schedules = [];
  state.tests.scheduleDetail = null;
  state.tests.results = [];
  state.tests.form = null;
  state.tests.error = "";
  state.tests.deletingScheduleId = "";
  state.tests.orgPickerData = {
    teams: [{ id: "team-1", name: "First Team" }, { id: "team-2", name: "Second Team" }],
    clubs: [{ id: "club-1", name: "Main Club" }, { id: "club-2", name: "Other Club" }],
  };
  state.tests.scheduleForm = emptyScheduleForm({ open: true, startDate: "2026-08-25", scheduleKind: "specific_dates", ...overrides });
  queried = {};
  resetTestsCalendarInteractionState();
}

// ------------------------------------------------------------
// Item 1: Recipients picker
// ------------------------------------------------------------

test("the raw Club/Team <select> pair and the standalone Athletes section are gone - a single Recipients trigger replaces both", () => {
  resetTestsState();
  const html = renderScheduleFormHtml();
  assert.ok(!html.includes('name="clubId"'));
  assert.ok(!html.includes('name="teamId"'));
  assert.ok(html.includes('data-action="tests-open-recipient-picker"'));
});

test("the trigger shows 'Choose recipients' when empty, and a combined count once something is picked", () => {
  resetTestsState();
  assert.ok(renderScheduleFormHtml().includes("Choose recipients"));
  state.tests.scheduleForm.athleteIds = ["a1"];
  state.tests.scheduleForm.teamIds = ["team-1"];
  state.tests.scheduleForm.clubIds = ["club-1"];
  const html = renderScheduleFormHtml();
  assert.ok(html.includes("Recipients"));
  assert.ok(html.includes("3 selected"));
});

test("opening the picker snapshots the current selection; clicking clubs/teams/athletes combines freely (never mutually exclusive)", async () => {
  resetTestsState();
  await handleTestsAction(fakeAction({ action: "tests-open-recipient-picker" }), { renderTests: () => {} });
  assert.equal(state.tests.scheduleForm.recipientPickerOpen, true);
  assert.deepEqual(state.tests.scheduleForm.recipientPickerSnapshot, { athleteIds: [], teamIds: [], clubIds: [] });

  await handleTestsAction(fakeAction({ action: "tests-recipient-picker-toggle", kind: "club", id: "club-1" }), { renderTests: () => {} });
  await handleTestsAction(fakeAction({ action: "tests-recipient-picker-toggle", kind: "team", id: "team-1" }), { renderTests: () => {} });
  await handleTestsAction(fakeAction({ action: "tests-recipient-picker-toggle", kind: "team", id: "team-2" }), { renderTests: () => {} });
  await handleTestsAction(fakeAction({ action: "tests-schedule-toggle-athlete", athleteUuid: "a1" }), { renderTests: () => {} });

  assert.deepEqual(state.tests.scheduleForm.clubIds, ["club-1"]);
  assert.deepEqual(state.tests.scheduleForm.teamIds, ["team-1", "team-2"]);
  assert.deepEqual(state.tests.scheduleForm.athleteIds, ["a1"]);
});

test("the picker's own X (cancel) reverts every change made during this one open/close session", async () => {
  resetTestsState({ clubIds: ["club-2"] });
  await handleTestsAction(fakeAction({ action: "tests-open-recipient-picker" }), { renderTests: () => {} });
  await handleTestsAction(fakeAction({ action: "tests-recipient-picker-toggle", kind: "club", id: "club-1" }), { renderTests: () => {} });
  await handleTestsAction(fakeAction({ action: "tests-recipient-picker-toggle", kind: "team", id: "team-1" }), { renderTests: () => {} });
  assert.deepEqual(new Set(state.tests.scheduleForm.clubIds), new Set(["club-2", "club-1"]));

  await handleTestsAction(fakeAction({ action: "tests-recipient-picker-cancel" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.scheduleForm.clubIds, ["club-2"], "reverted to exactly what it was before this picker session opened");
  assert.deepEqual(state.tests.scheduleForm.teamIds, []);
  assert.equal(state.tests.scheduleForm.recipientPickerOpen, false);
});

test("the picker's own check (confirm) just closes, keeping whatever was picked during this session", async () => {
  resetTestsState();
  await handleTestsAction(fakeAction({ action: "tests-open-recipient-picker" }), { renderTests: () => {} });
  await handleTestsAction(fakeAction({ action: "tests-recipient-picker-toggle", kind: "team", id: "team-1" }), { renderTests: () => {} });
  await handleTestsAction(fakeAction({ action: "tests-recipient-picker-confirm" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.scheduleForm.teamIds, ["team-1"]);
  assert.equal(state.tests.scheduleForm.recipientPickerOpen, false);
});

test("select-all/clear on the Clubs tab only ever touches clubIds, never teamIds/athleteIds", async () => {
  resetTestsState();
  await handleTestsAction(fakeAction({ action: "tests-recipient-picker-select-all", kind: "club" }), { renderTests: () => {} });
  assert.deepEqual(new Set(state.tests.scheduleForm.clubIds), new Set(["club-1", "club-2"]));
  assert.deepEqual(state.tests.scheduleForm.teamIds, []);
  await handleTestsAction(fakeAction({ action: "tests-recipient-picker-clear", kind: "club" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.scheduleForm.clubIds, []);
});

test("switching the picker's own tab updates recipientPickerTab and renders that tab's own content", async () => {
  resetTestsState();
  await handleTestsAction(fakeAction({ action: "tests-open-recipient-picker" }), { renderTests: () => {} });
  await handleTestsAction(fakeAction({ action: "tests-recipient-picker-set-tab", recipientTab: "teams" }), { renderTests: () => {} });
  assert.equal(state.tests.scheduleForm.recipientPickerTab, "teams");
  const html = renderRecipientPickerHtml(state.tests.scheduleForm);
  assert.ok(html.includes("First Team"));
});

// Found live: "data-tab" is a reserved attribute app.js's handleGlobalClick
// treats as a top-level sidebar tab switch, ANYWHERE in the document
// (event.target.closest("[data-tab]")) - a picker tab button using that
// exact attribute name gets hijacked into switching state.activeTab to a
// garbage value and blanking the whole page, before this module's own
// handler ever runs. data-recipient-tab avoids the collision.
test("the picker's own tab buttons never use the reserved 'data-tab' attribute (collides with app.js's global sidebar tab-switch handler)", () => {
  resetTestsState();
  const html = renderRecipientPickerHtml(state.tests.scheduleForm);
  assert.ok(!/\sdata-tab=/.test(html), "must never emit a bare data-tab attribute anywhere in the picker");
  assert.ok(html.includes("data-recipient-tab="));
});

test("submitting combines individually-selected athletes with MULTIPLE clubs and MULTIPLE teams into one targets array - the backend's own multi-target model, not a single-club/single-team limitation", async () => {
  resetTestsState();
  state.tests.scheduleForm.athleteIds = ["a1", "a2"];
  state.tests.scheduleForm.teamIds = ["team-1", "team-2"];
  state.tests.scheduleForm.clubIds = ["club-1", "club-2"];
  state.tests.scheduleForm.timezone = "UTC";
  state.tests.scheduleForm.opensTime = "06:00";
  state.tests.scheduleForm.closesTime = "22:00";
  installFetchMock((call) => {
    if (call.url.includes("/api/tests/library")) return { status: 200, body: { tests: [{ testVersionId: "wellness-v1", schedulable: true }] } };
    if (call.url === "/api/tests/schedules" && call.method === "POST") {
      return { status: 201, body: { schedule: { id: "sched-multi", testName: "WELLNESS", scheduleKind: "one_time", status: "active", timezone: "UTC", startDate: "2026-08-25", opensTime: "06:00", closesTime: "22:00" } } };
    }
    return { status: 404, body: {} };
  });
  await submitTestsForm({ dataset: { testsForm: "create-schedule" } }, { renderTests: () => {} });
  const createCall = fetchCalls.find((c) => c.url === "/api/tests/schedules" && c.method === "POST");
  assert.deepEqual(new Set(createCall.body.targets.map((t) => `${t.kind}:${t.id}`)), new Set([
    "athlete:a1", "athlete:a2", "team:team-1", "team:team-2", "club:club-1", "club:club-2",
  ]));
});

// ------------------------------------------------------------
// Item 2: direct calendar open, X/check, Daily auto-close
// ------------------------------------------------------------

test("no extra 'Pick dates'/toggle row exists - only the Dates/Daily pills open the calendar", () => {
  resetTestsState({ calendarOpen: false });
  const html = renderScheduleFormHtml();
  assert.ok(!html.includes('data-action="tests-calendar-toggle-open"'));
});

test("clicking Dates or Daily immediately sets calendarOpen and snapshots the mode's own fields", async () => {
  resetTestsState({ calendarOpen: false, scheduleKind: "specific_dates", selectedDates: ["2026-08-01"] });
  await handleTestsAction(fakeAction({ action: "tests-schedule-set-recurrence", daily: "false" }), { renderTests: () => {} });
  assert.equal(state.tests.scheduleForm.calendarOpen, true);
  assert.deepEqual(state.tests.scheduleForm.calendarCancelSnapshot, { selectedDates: ["2026-08-01"] });
});

test("while closed, a compact summary line shows instead of the calendar grid", () => {
  resetTestsState({ calendarOpen: false, scheduleKind: "specific_dates", selectedDates: ["2026-08-01", "2026-08-02"] });
  const html = renderScheduleFormHtml();
  assert.ok(!html.includes("tests-calendar-grid"));
  assert.ok(html.includes("2 dates selected"));
});

test("Dates (multi-select) stays open across multiple date picks - never auto-closes", () => {
  resetTestsState({ calendarOpen: true, scheduleKind: "specific_dates", selectedDates: [] });
  startTestsCalendarDrag(fakeDayEl("2026-09-10"));
  const closed = endTestsCalendarDrag();
  assert.equal(closed, false);
  assert.equal(state.tests.scheduleForm.calendarOpen, true);
  startTestsCalendarDrag(fakeDayEl("2026-09-11"));
  assert.equal(endTestsCalendarDrag(), false);
  assert.equal(state.tests.scheduleForm.calendarOpen, true);
});

test("Daily does NOT close after just the first click - only once the range is genuinely completed", () => {
  resetTestsState({ calendarOpen: true, scheduleKind: "daily", startDate: "", endDate: "" });
  startTestsCalendarDrag(fakeDayEl("2026-09-10"));
  const closedAfterFirst = endTestsCalendarDrag();
  assert.equal(closedAfterFirst, false, "the first click of the two-click flow must never close the calendar");
  assert.equal(state.tests.scheduleForm.calendarOpen, true);

  startTestsCalendarDrag(fakeDayEl("2026-09-15"));
  const closedAfterSecond = endTestsCalendarDrag();
  assert.equal(closedAfterSecond, true, "the second click completes the range and must close it");
  assert.equal(state.tests.scheduleForm.calendarOpen, false);
  assert.equal(state.tests.scheduleForm.startDate, "2026-09-10");
  assert.equal(state.tests.scheduleForm.endDate, "2026-09-15");
});

test("Daily closes after a real drag that resolves the whole range in one gesture", () => {
  resetTestsState({ calendarOpen: true, scheduleKind: "daily", startDate: "", endDate: "" });
  startTestsCalendarDrag(fakeDayEl("2026-09-10"));
  extendTestsCalendarDrag(fakeDayEl("2026-09-14"));
  const closed = endTestsCalendarDrag();
  assert.equal(closed, true);
  assert.equal(state.tests.scheduleForm.calendarOpen, false);
});

test("one_time (single-date edit mode) never auto-closes, preserving existing edit-mode behavior", () => {
  resetTestsState({ calendarOpen: true, scheduleKind: "one_time", editingScheduleId: "sched-1", startDate: "2026-09-01", endDate: "2026-09-01" });
  assert.equal(testsCalendarMode(state.tests.scheduleForm), "single");
  startTestsCalendarDrag(fakeDayEl("2026-09-12"));
  const closed = endTestsCalendarDrag();
  assert.equal(closed, false);
  assert.equal(state.tests.scheduleForm.calendarOpen, true);
});

test("the calendar's own X reverts to the snapshot taken when it opened and closes; check just closes, keeping the new picks", async () => {
  resetTestsState({ calendarOpen: false, scheduleKind: "specific_dates", selectedDates: ["2026-08-01"] });
  await handleTestsAction(fakeAction({ action: "tests-schedule-set-recurrence", daily: "false" }), { renderTests: () => {} });
  state.tests.scheduleForm.selectedDates = ["2026-08-01", "2026-08-05", "2026-08-09"];

  await handleTestsAction(fakeAction({ action: "tests-calendar-cancel" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.scheduleForm.selectedDates, ["2026-08-01"], "reverted to the pre-open snapshot");
  assert.equal(state.tests.scheduleForm.calendarOpen, false);

  await handleTestsAction(fakeAction({ action: "tests-schedule-set-recurrence", daily: "false" }), { renderTests: () => {} });
  state.tests.scheduleForm.selectedDates = ["2026-08-01", "2026-08-20"];
  await handleTestsAction(fakeAction({ action: "tests-calendar-confirm" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.scheduleForm.selectedDates, ["2026-08-01", "2026-08-20"], "confirm keeps the new picks");
  assert.equal(state.tests.scheduleForm.calendarOpen, false);
});

// ------------------------------------------------------------
// Item 3: compact notification switches
// ------------------------------------------------------------

test("all 4 notification rules still toggle correctly via the new switch (button, not checkbox) control", async () => {
  resetTestsState();
  state.tests.scheduleForm.notificationRules = [];
  for (const kind of ["athlete_invitation", "athlete_reminder", "coach_digest", "final_digest"]) {
    await handleTestsAction(fakeAction({ action: "tests-notification-rule-toggle", kind }), { renderTests: () => {} });
  }
  assert.equal(state.tests.scheduleForm.notificationRules.length, 4);
  assert.ok(state.tests.scheduleForm.notificationRules.every((r) => r.enabled === true));
  // clicking the same one again flips it back off, in place - no duplicate row
  await handleTestsAction(fakeAction({ action: "tests-notification-rule-toggle", kind: "coach_digest" }), { renderTests: () => {} });
  assert.equal(state.tests.scheduleForm.notificationRules.length, 4);
  assert.equal(state.tests.scheduleForm.notificationRules.find((r) => r.kind === "coach_digest").enabled, false);
});

test("the compact reminder-offset inline control still submits the exact same field the backend expects", async () => {
  resetTestsState();
  state.tests.scheduleForm.notificationRules = [{ kind: "athlete_reminder", enabled: true, reminderOffsetMinutes: 60 }];
  const html = renderScheduleFormHtml();
  assert.ok(html.includes('name="reminderOffsetMinutes"'));
  assert.ok(html.includes("min before close"));
});

test("the collapsible summary groups by audience, not by listing every rule name", () => {
  resetTestsState();
  state.tests.scheduleForm.notificationRules = [
    { kind: "athlete_invitation", enabled: true },
    { kind: "athlete_reminder", enabled: false },
    { kind: "coach_digest", enabled: true },
    { kind: "final_digest", enabled: true },
  ];
  const html = renderScheduleFormHtml();
  assert.ok(html.includes("1 athlete"));
  assert.ok(html.includes("2 coach"));
});

// ------------------------------------------------------------
// Item 4: "Schedule again"
// ------------------------------------------------------------

test("Schedule again loads the original schedule and opens a NEW form copying test/mode/targets/times/notifications - but never dates, and never editingScheduleId", async () => {
  resetTestsState();
  installFetchMock((call) => (call.url === "/api/tests/schedules/sched-orig"
    ? {
      status: 200,
      body: {
        schedule: { id: "sched-orig", scheduleKind: "recurring", hasOccurrences: true, hasActivity: true, timezone: "Europe/Belgrade", startDate: "2026-01-01", endDate: "2026-01-31", opensTime: "07:00", dueTime: "12:00", closesTime: "21:00" },
        targets: [{ kind: "athlete", id: "a1" }, { kind: "team", id: "team-1" }, { kind: "club", id: "club-1" }],
        notificationRules: [{ kind: "athlete_invitation", enabled: true }, { kind: "athlete_reminder", enabled: true, reminderOffsetMinutes: 45 }],
        link: { id: "link-1", publicToken: "tok-1" },
      },
    }
    : { status: 404, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-schedule-again", scheduleId: "sched-orig" }), { renderTests: () => {} });
  const form = state.tests.scheduleForm;
  assert.equal(form.open, true);
  assert.equal(form.editingScheduleId, "", "must never be treated as an edit of the original");
  assert.equal(form.scheduleAgainFromId, "sched-orig");
  assert.equal(form.scheduleKind, "daily", "recurring -> daily, same mode, fresh dates still required");
  assert.equal(form.startDate, "", "dates/start/end are never copied");
  assert.equal(form.endDate, "");
  assert.deepEqual(form.selectedDates, []);
  assert.deepEqual(form.athleteIds, ["a1"]);
  assert.deepEqual(form.teamIds, ["team-1"]);
  assert.deepEqual(form.clubIds, ["club-1"]);
  assert.equal(form.opensTime, "07:00");
  assert.equal(form.dueTime, "12:00");
  assert.equal(form.closesTime, "21:00");
  assert.equal(form.timezone, "Europe/Belgrade");
  assert.deepEqual(form.notificationRules, [{ kind: "athlete_invitation", enabled: true }, { kind: "athlete_reminder", enabled: true, reminderOffsetMinutes: 45 }]);
  // Never touches the original in any way - only ever a GET was made.
  assert.ok(fetchCalls.every((c) => c.method === "GET"));
});

test("a one_time original maps to 'specific_dates' (a fresh multi-date pick), not a copied single date", async () => {
  resetTestsState();
  installFetchMock((call) => (call.url === "/api/tests/schedules/sched-one"
    ? {
      status: 200,
      body: {
        schedule: { id: "sched-one", scheduleKind: "one_time", hasOccurrences: false, hasActivity: false, timezone: "UTC", startDate: "2026-02-02", opensTime: "06:00", closesTime: "22:00" },
        targets: [{ kind: "athlete", id: "a2" }],
        notificationRules: [],
        link: null,
      },
    }
    : { status: 404, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-schedule-again", scheduleId: "sched-one" }), { renderTests: () => {} });
  assert.equal(state.tests.scheduleForm.scheduleKind, "specific_dates");
  assert.deepEqual(state.tests.scheduleForm.selectedDates, []);
});

test("the 'Schedule again' form visually looks like a prefilled edit (title + notice) but its title never says 'Edit'", async () => {
  resetTestsState();
  state.tests.scheduleForm.scheduleAgainFromId = "sched-orig";
  state.tests.scheduleForm.editingScheduleId = "";
  const html = renderScheduleFormHtml();
  assert.ok(html.includes("Schedule again"));
  assert.ok(!html.includes("Edit WELLNESS schedule"));
});

test("saving a 'Schedule again' form goes through the CREATE path (POST), never PATCH of the original", async () => {
  resetTestsState();
  state.tests.scheduleForm.scheduleAgainFromId = "sched-orig";
  state.tests.scheduleForm.editingScheduleId = "";
  state.tests.scheduleForm.scheduleKind = "daily";
  state.tests.scheduleForm.startDate = "2026-03-01";
  state.tests.scheduleForm.endDate = "2026-03-31";
  state.tests.scheduleForm.timezone = "UTC";
  state.tests.scheduleForm.opensTime = "06:00";
  state.tests.scheduleForm.closesTime = "22:00";
  state.tests.scheduleForm.athleteIds = ["a1"];
  installFetchMock((call) => {
    if (call.url.includes("/api/tests/library")) return { status: 200, body: { tests: [{ testVersionId: "wellness-v1", schedulable: true }] } };
    if (call.url === "/api/tests/schedules" && call.method === "POST") {
      return { status: 201, body: { schedule: { id: "sched-new", testName: "WELLNESS", scheduleKind: "daily", status: "active", timezone: "UTC", startDate: "2026-03-01", endDate: "2026-03-31", opensTime: "06:00", closesTime: "22:00" } } };
    }
    return { status: 404, body: {} };
  });
  await submitTestsForm({ dataset: { testsForm: "create-schedule" } }, { renderTests: () => {} });
  assert.ok(fetchCalls.some((c) => c.url === "/api/tests/schedules" && c.method === "POST"));
  assert.ok(!fetchCalls.some((c) => c.method === "PATCH"), "must never PATCH sched-orig or anything else");
  assert.equal(state.tests.schedules[0].id, "sched-new", "a genuinely new schedule id, distinct from the original");
});

test("the result-detail view offers 'Schedule again' when the result carries a scheduleId, and never for the athlete's own submitted-answer view", () => {
  const withSchedule = emptyWellnessForm({ testName: "WELLNESS", athleteName: "Ana", canSubmit: false, result: { wellnessScore: 5 }, scheduleId: "sched-7" });
  const htmlWith = renderWellnessFormHtml(withSchedule, {});
  assert.ok(htmlWith.includes('data-action="tests-schedule-again"'));
  assert.ok(htmlWith.includes('data-schedule-id="sched-7"'));

  const withoutSchedule = emptyWellnessForm({ testName: "WELLNESS", athleteName: "Ana", canSubmit: true, result: { wellnessScore: 5 }, scheduleId: "" });
  const htmlWithout = renderWellnessFormHtml(withoutSchedule, {});
  assert.ok(!htmlWithout.includes('data-action="tests-schedule-again"'), "the athlete's own submitted-answer view never sets scheduleId, so it must never show this button");
});

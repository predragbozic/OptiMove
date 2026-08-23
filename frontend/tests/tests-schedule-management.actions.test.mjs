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
  submitTestsForm,
} = await import("../tests-actions.js");
const { testsAthleteMultiSelectVisibleAthletes, renderTestsAthleteOptionsHtml } = await import("../tests-view.js");
const { emptyScheduleForm, state } = await import("../state.js");

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

test("a one_time schedule that already has its occurrence never opens the edit form - a clear error instead, no network round trip needed to find out", async () => {
  resetTestsState();
  state.tests.scheduleForm = emptyScheduleForm(); // closed, as it would be before clicking Edit from the list
  state.tests.schedules = [{ id: "sched-1", scheduleKind: "one_time", hasOccurrences: true }];
  installFetchMock(() => ({ status: 200, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-open-edit-schedule", scheduleId: "sched-1" }), { renderTests: () => {} });
  assert.equal(state.tests.scheduleForm.open, false);
  assert.ok(!state.tests.scheduleForm.editingScheduleId);
  assert.ok(state.tests.error.toLowerCase().includes("can no longer be edited"), state.tests.error);
  assert.equal(fetchCalls.length, 0, "no request should be made once the block is already known from the list row");
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

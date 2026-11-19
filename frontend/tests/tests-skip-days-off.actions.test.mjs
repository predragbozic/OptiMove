import { test } from "node:test";
import assert from "node:assert/strict";

// K2b-2a-2a: "Skip days off" on the Tests schedule form
// (docs/ai/central-calendar-k2b2a2-ui-contract.md section 1 and 10). Runs the
// real actions and view with the minimal DOM double of the other Tests
// suites, against a fake server that keeps the routes' contracts:
// - GET /api/calendar/events/types answers questions.enabled from the fake
//   club's switch (B1's shape; a failure or a missing field is "off");
// - POST / PATCH /api/tests/schedules refuse skipDaysOff: true with
//   400 skip_days_off_unavailable unless the RESULTING schedule is daily and
//   the switch is on (skipDaysOffRefusal in backend/src/routes/tests.js, as
//   fixed in #614); a full edit to a non-daily kind without skipDaysOff resets
//   it to false, a daily one keeps it; the v81 CHECK (skip_days_off only on a
//   recurring schedule) answers 500 if a write would break it; and both answer
//   409 schedule_managed_by_calendar for a calendar-managed schedule;
// - GET /api/tests/library lists one schedulable test (WELLNESS, or another
//   test when the case says so).

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = { confirm: () => true };

const { handleTestsAction, submitTestsForm, testsScheduleErrorText } = await import("../tests-actions.js");
const { renderTestsSkipDaysOffHtml } = await import("../tests-view.js");
const { emptyScheduleForm, state } = await import("../state.js");

const SCHEDULE_ID = "11111111-1111-4111-8111-111111111111";
const render = () => {};

let calls;
let server;
function installServer(overrides = {}) {
  server = {
    switchOn: true,
    typesFails: false,
    typesWithoutField: false,
    managed: false,
    stored: { scheduleKind: "recurring", skipDaysOff: false },
    typesGate: null,
    holdNextTypes: null,
    libraryTest: "WELLNESS",
    ...overrides,
  };
  calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const result = await answer(call);
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
}

function refusesSkip(body, scheduleKind) {
  if (body.skipDaysOff === undefined || body.skipDaysOff === false) return false;
  return body.skipDaysOff !== true || scheduleKind !== "recurring" || !server.switchOn;
}

async function answer(call) {
  if (call.url === "/api/calendar/events/types") {
    if (server.typesGate) await server.typesGate;
    if (server.holdNextTypes) {
      const { gate, enabled } = server.holdNextTypes;
      server.holdNextTypes = null;
      await gate;
      return { status: 200, body: { types: [], questions: { enabled } } };
    }
    if (server.typesFails) return { status: 500, body: { error: "internal_error" } };
    return { status: 200, body: { types: [], ...(server.typesWithoutField ? {} : { questions: { enabled: server.switchOn } }) } };
  }
  if (call.url === "/api/tests/library") return { status: 200, body: { tests: [{ testVersionId: "test-v1", name: server.libraryTest, schedulable: true }] } };
  if (call.url === "/api/organization") return { status: 404, body: { error: "notFound" } };
  if (call.url === "/api/tests/schedules" && call.method === "POST") {
    const kind = call.body.scheduleKind === "daily" ? "recurring" : "one_time";
    if (refusesSkip(call.body, kind)) return { status: 400, body: { error: "skip_days_off_unavailable", message: "Skipping days off is not available for this schedule." } };
    return { status: 201, body: { schedule: { id: SCHEDULE_ID, scheduleKind: kind, status: "active", skipDaysOff: call.body.skipDaysOff === true } } };
  }
  if (call.url === `/api/tests/schedules/${SCHEDULE_ID}` && call.method === "GET") {
    return {
      status: 200,
      body: {
        schedule: {
          id: SCHEDULE_ID, scheduleKind: server.stored.scheduleKind, timezone: "UTC", startDate: "2026-11-20", endDate: "2026-11-30",
          opensTime: "07:00", closesTime: "10:00", status: "active", skipDaysOff: server.stored.skipDaysOff, testName: "WELLNESS",
        },
        targets: [{ kind: "team", id: "team-1" }],
        notificationRules: [],
      },
    };
  }
  if (call.url === `/api/tests/schedules/${SCHEDULE_ID}` && (call.method === "PATCH" || call.method === "DELETE")) {
    if (server.managed) return { status: 409, body: { error: "schedule_managed_by_calendar", message: "This question belongs to a calendar event. Change it on the event." } };
    if (call.method === "DELETE") return { status: 200, body: { deleted: true } };
    // The fixed rule: decided from the RESULTING kind of a full edit.
    const kind = call.body.scheduleKind === undefined ? server.stored.scheduleKind : call.body.scheduleKind === "daily" ? "recurring" : "one_time";
    if (refusesSkip(call.body, kind)) return { status: 400, body: { error: "skip_days_off_unavailable", message: "Skipping days off is not available for this schedule." } };
    const skip = call.body.skipDaysOff !== undefined ? call.body.skipDaysOff === true : kind === "recurring" ? server.stored.skipDaysOff : false;
    if (skip && kind !== "recurring") return { status: 500, body: { error: "internal_error" } }; // the v81 CHECK
    server.stored = { scheduleKind: kind, skipDaysOff: skip };
    return { status: 200, body: { schedule: { id: SCHEDULE_ID, scheduleKind: kind, status: "active", skipDaysOff: skip } } };
  }
  return { status: 404, body: { error: "notFound" } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const action = (dataset, extra = {}) => ({ dataset, ...extra });

function resetState() {
  state.athletes = [];
  state.tests.schedules = [];
  state.tests.scheduleDetail = null;
  state.tests.orgPickerData = { teams: [{ id: "team-1", name: "First Team" }], clubs: [] };
  state.tests.scheduleForm = emptyScheduleForm();
  state.tests.error = "";
  state.tests.section = "schedule";
}

async function openCreate() {
  await handleTestsAction(action({ action: "tests-open-schedule-form" }), { renderTests: render });
  await settle();
  const form = state.tests.scheduleForm;
  form.teamIds = ["team-1"];
  form.timezone = "UTC";
  return form;
}

async function chooseDaily(daily = true) {
  await handleTestsAction(action({ action: "tests-schedule-set-recurrence", daily: String(daily) }), { renderTests: render });
  const form = state.tests.scheduleForm;
  if (daily) { form.startDate = "2026-11-20"; form.endDate = "2026-11-30"; }
  return form;
}

async function openEdit() {
  await handleTestsAction(action({ action: "tests-open-edit-schedule", scheduleId: SCHEDULE_ID }), { renderTests: render });
  await settle();
  return state.tests.scheduleForm;
}

const submit = (kind) => submitTestsForm({ dataset: { testsForm: kind } }, { renderTests: render });
const lastWrite = () => calls.filter((c) => c.method === "POST" || c.method === "PATCH").at(-1);

// ------------------------------------------------------------
// When it is shown
// ------------------------------------------------------------

test("1. shown ticked for a daily schedule while the club's switch is on; the switch is read once per opened form", async () => {
  resetState();
  installServer();
  const form = await openCreate();
  assert.equal(calls.filter((c) => c.url === "/api/calendar/events/types").length, 1);
  assert.equal(form.questionsEnabled, true);
  assert.equal(renderTestsSkipDaysOffHtml(form), "", "Specific dates (the create default): not offered");
  await chooseDaily();
  const html = renderTestsSkipDaysOffHtml(state.tests.scheduleForm);
  assert.match(html, /Skip days off/);
  assert.match(html, /type="checkbox"[^>]*data-action="tests-schedule-skip-days-off"[^>]*checked/);
  assert.match(html, /Athletes aren't asked on a day when a Day off in the calendar includes them\./);
  assert.equal(calls.filter((c) => c.url === "/api/calendar/events/types").length, 1, "switching the recurrence reads nothing again");
});

test("2. hidden, and nothing sent, while the switch is off, when its read fails or lacks the field", async () => {
  for (const overrides of [{ switchOn: false }, { typesFails: true }, { typesWithoutField: true }]) {
    resetState();
    installServer(overrides);
    await openCreate();
    const form = await chooseDaily();
    assert.equal(form.questionsEnabled, false, JSON.stringify(overrides));
    assert.equal(renderTestsSkipDaysOffHtml(form), "");
    await submit("create-schedule");
    const post = lastWrite();
    assert.equal(post.url, "/api/tests/schedules");
    assert.equal("skipDaysOff" in post.body, false, `no skipDaysOff while not offered (${JSON.stringify(overrides)})`);
  }
});

test("3. a slower switch answer for a form that was closed meanwhile is dropped", async () => {
  resetState();
  let release;
  installServer({ typesGate: new Promise((resolve) => { release = resolve; }) });
  const opening = handleTestsAction(action({ action: "tests-open-schedule-form" }), { renderTests: render });
  await opening;
  const first = state.tests.scheduleForm;
  state.tests.scheduleForm = emptyScheduleForm();
  release();
  await settle();
  assert.equal(first.questionsEnabled, null, "the closed form is not written");
  assert.equal(state.tests.scheduleForm.questionsEnabled, null);
});

// ------------------------------------------------------------
// What is sent
// ------------------------------------------------------------

test("4. create: the ticked default is sent as skipDaysOff: true; unticked, false", async () => {
  resetState();
  installServer();
  await openCreate();
  await chooseDaily();
  await submit("create-schedule");
  assert.equal(lastWrite().body.skipDaysOff, true);
  assert.equal(state.tests.scheduleForm.open, false, "saved: the form closes");

  resetState();
  installServer();
  await openCreate();
  await chooseDaily();
  await handleTestsAction(action({ action: "tests-schedule-skip-days-off" }, { checked: false }), { renderTests: render });
  assert.equal(state.tests.scheduleForm.skipDaysOff, false);
  assert.doesNotMatch(renderTestsSkipDaysOffHtml(state.tests.scheduleForm), /checked/);
  await submit("create-schedule");
  assert.equal(lastWrite().body.skipDaysOff, false);
});

test("5. Specific dates sends nothing (the bulk route); back to Repeat daily keeps the coach's last choice", async () => {
  resetState();
  installServer();
  await openCreate();
  await chooseDaily();
  await handleTestsAction(action({ action: "tests-schedule-skip-days-off" }, { checked: false }), { renderTests: render });
  await chooseDaily(false);
  assert.equal(renderTestsSkipDaysOffHtml(state.tests.scheduleForm), "");
  state.tests.scheduleForm.selectedDates = ["2026-11-21"];
  await submit("create-schedule-bulk");
  const bulk = calls.find((c) => c.url === "/api/tests/schedules/bulk");
  assert.ok(bulk);
  assert.equal("skipDaysOff" in bulk.body, false);

  resetState();
  installServer();
  await openCreate();
  await chooseDaily();
  await handleTestsAction(action({ action: "tests-schedule-skip-days-off" }, { checked: false }), { renderTests: render });
  await chooseDaily(false);
  await chooseDaily(true);
  assert.equal(state.tests.scheduleForm.skipDaysOff, false, "the last choice is kept");
});

test("6. edit: shows the stored value and sends skipDaysOff only when the coach changed it", async () => {
  resetState();
  installServer({ stored: { scheduleKind: "recurring", skipDaysOff: true } });
  let form = await openEdit();
  assert.equal(form.questionsEnabled, true);
  assert.match(renderTestsSkipDaysOffHtml(form), /checked/);
  await submit("edit-schedule");
  assert.equal(lastWrite().method, "PATCH");
  assert.equal("skipDaysOff" in lastWrite().body, false, "untouched: not sent");

  resetState();
  installServer({ stored: { scheduleKind: "recurring", skipDaysOff: true } });
  form = await openEdit();
  await handleTestsAction(action({ action: "tests-schedule-skip-days-off" }, { checked: false }), { renderTests: render });
  await submit("edit-schedule");
  assert.equal(lastWrite().body.skipDaysOff, false, "changed: sent");

  resetState();
  installServer({ stored: { scheduleKind: "recurring", skipDaysOff: false } });
  form = await openEdit();
  assert.doesNotMatch(renderTestsSkipDaysOffHtml(form), /checked/, "a stored false is shown unticked");
  await handleTestsAction(action({ action: "tests-schedule-skip-days-off" }, { checked: true }), { renderTests: render });
  await handleTestsAction(action({ action: "tests-schedule-skip-days-off" }, { checked: false }), { renderTests: render });
  await submit("edit-schedule");
  assert.equal("skipDaysOff" in lastWrite().body, false, "changed and changed back: not sent");
});

test("7. the box cannot be changed while a save is in flight", async () => {
  resetState();
  installServer();
  await openCreate();
  const form = await chooseDaily();
  form.submitting = true;
  assert.match(renderTestsSkipDaysOffHtml(form), /disabled/);
  await handleTestsAction(action({ action: "tests-schedule-skip-days-off" }, { checked: false }), { renderTests: render });
  assert.equal(form.skipDaysOff, true);
});

// ------------------------------------------------------------
// Refusals: one plain sentence, never a code
// ------------------------------------------------------------

test("8. skip_days_off_unavailable: its sentence, the switch read again, the option gone when the switch went off", async () => {
  resetState();
  installServer();
  await openCreate();
  await chooseDaily();
  server.switchOn = false; // turned off after the form opened
  await submit("create-schedule");
  const form = state.tests.scheduleForm;
  assert.equal(form.open, true, "the form stays open with the coach's input");
  assert.equal(form.error, "Skipping days off isn't available for this schedule now. Untick Skip days off and save again.");
  assert.doesNotMatch(form.error, /skip_days_off/);
  assert.equal(form.skipDaysOff, false, "hidden and unticked (contract 1.3)");
  assert.equal(calls.filter((c) => c.url === "/api/calendar/events/types").length, 2, "read again after the refusal");
  assert.equal(form.questionsEnabled, false);
  assert.equal(renderTestsSkipDaysOffHtml(form), "");
  await submit("create-schedule");
  assert.equal("skipDaysOff" in lastWrite().body, false, "the next save does not send it");
  assert.equal(state.tests.scheduleForm.open, false, "and is saved");
});

test("9. schedule_managed_by_calendar on an edit, a pause and a delete: its sentence", async () => {
  const sentence = "This check-in belongs to a calendar event. Change it on the event.";
  resetState();
  installServer({ managed: true });
  await openEdit();
  await submit("edit-schedule");
  assert.equal(state.tests.scheduleForm.error, sentence);

  resetState();
  installServer({ managed: true });
  await handleTestsAction(action({ action: "tests-set-schedule-status", scheduleId: SCHEDULE_ID, status: "paused" }), { renderTests: render });
  assert.equal(state.tests.error, sentence);

  resetState();
  installServer({ managed: true });
  await handleTestsAction(action({ action: "tests-delete-schedule", scheduleId: SCHEDULE_ID, hasOccurrences: "false" }), { renderTests: render });
  assert.equal(state.tests.error, sentence);
});

test("10. any other error keeps the module's existing text", () => {
  const error = Object.assign(new Error("Only WELLNESS can be scheduled in this phase."), { data: { error: "Only WELLNESS can be scheduled in this phase." } });
  assert.equal(testsScheduleErrorText(error, "fallback"), "Only WELLNESS can be scheduled in this phase.");
  assert.equal(testsScheduleErrorText({}, "fallback"), "fallback");
});

// ------------------------------------------------------------
// Review round 1 of 2a-2a (the manager's plan, 2026-11-18)
// ------------------------------------------------------------

test("11. an edit of a daily schedule with Skip days off on to Specific dates saves without skipDaysOff (switch on and off)", async () => {
  for (const switchOn of [true, false]) {
    resetState();
    installServer({ switchOn, stored: { scheduleKind: "recurring", skipDaysOff: true } });
    const form = await openEdit();
    assert.equal(renderTestsSkipDaysOffHtml(form) !== "", switchOn, "shown on the daily edit only while the switch is on");
    await chooseDaily(false);
    assert.equal(state.tests.scheduleForm.scheduleKind, "one_time");
    assert.equal(renderTestsSkipDaysOffHtml(state.tests.scheduleForm), "");
    await submit("edit-schedule");
    const patch = lastWrite();
    assert.equal(patch.method, "PATCH");
    assert.equal(patch.body.scheduleKind, "one_time");
    assert.equal("skipDaysOff" in patch.body, false, `nothing sent (switch ${switchOn ? "on" : "off"})`);
    assert.equal(state.tests.scheduleForm.open, false, "saved: the form closes");
    assert.equal(state.tests.scheduleForm.error, "");
    assert.deepEqual(server.stored, { scheduleKind: "one_time", skipDaysOff: false }, "the server reset it");
  }
});

test("12. an edit of a one-time schedule to Repeat daily shows the box; ticked, it saves skipDaysOff: true", async () => {
  resetState();
  installServer({ stored: { scheduleKind: "one_time", skipDaysOff: false } });
  const form = await openEdit();
  assert.equal(renderTestsSkipDaysOffHtml(form), "", "one-time: not offered");
  await chooseDaily();
  const html = renderTestsSkipDaysOffHtml(state.tests.scheduleForm);
  assert.match(html, /Skip days off/);
  assert.doesNotMatch(html, /checked/, "the stored value (off)");
  await handleTestsAction(action({ action: "tests-schedule-skip-days-off" }, { checked: true }), { renderTests: render });
  await submit("edit-schedule");
  assert.equal(lastWrite().body.scheduleKind, "daily");
  assert.equal(lastWrite().body.skipDaysOff, true);
  assert.equal(state.tests.scheduleForm.open, false);
  assert.deepEqual(server.stored, { scheduleKind: "recurring", skipDaysOff: true });
});

test("13. two reads of the switch on one open form: only the newest writes", async () => {
  resetState();
  installServer();
  await openCreate();
  await chooseDaily();
  server.switchOn = false;
  let releaseFirst;
  server.holdNextTypes = { gate: new Promise((resolve) => { releaseFirst = resolve; }), enabled: true };
  const first = submit("create-schedule"); // refused; its re-read is held and will answer true
  await settle();
  state.tests.scheduleForm.skipDaysOff = true;
  state.tests.scheduleForm.questionsEnabled = true;
  await submit("create-schedule"); // refused again; its re-read answers false at once
  assert.equal(state.tests.scheduleForm.questionsEnabled, false);
  releaseFirst();
  await first;
  await settle();
  assert.equal(state.tests.scheduleForm.questionsEnabled, false, "the older read (true) does not overwrite the newer one");
  assert.equal(renderTestsSkipDaysOffHtml(state.tests.scheduleForm), "");
});

test("14. Schedule again of a daily schedule with Skip days off off sends skipDaysOff: false", async () => {
  resetState();
  installServer({ stored: { scheduleKind: "recurring", skipDaysOff: false } });
  await handleTestsAction(action({ action: "tests-schedule-again", scheduleId: SCHEDULE_ID }), { renderTests: render });
  await settle();
  const form = state.tests.scheduleForm;
  assert.equal(form.editingScheduleId, "", "a create");
  assert.equal(form.scheduleKind, "daily");
  assert.doesNotMatch(renderTestsSkipDaysOffHtml(form), /checked/);
  Object.assign(form, { startDate: "2026-12-01", endDate: "2026-12-07" });
  await submit("create-schedule");
  const post = lastWrite();
  assert.equal(post.url, "/api/tests/schedules");
  assert.equal(post.method, "POST");
  assert.equal(post.body.skipDaysOff, false);
});

test("15. a schedulable test other than WELLNESS: the box is hidden and nothing is sent", async () => {
  resetState();
  installServer({ libraryTest: "FMS" });
  await openCreate();
  const form = await chooseDaily();
  assert.equal(form.questionsEnabled, true);
  assert.equal(form.testName, "FMS");
  assert.equal(renderTestsSkipDaysOffHtml(form), "");
  await handleTestsAction(action({ action: "tests-schedule-skip-days-off" }, { checked: false }), { renderTests: render });
  assert.equal(form.skipDaysOff, true, "the hidden box cannot be changed");
  await submit("create-schedule");
  assert.equal("skipDaysOff" in lastWrite().body, false);
});

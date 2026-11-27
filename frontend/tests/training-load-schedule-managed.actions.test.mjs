// K2b-2a-2b (contract section 10, GO decision 7): an RPE request that a
// calendar question owns is changed on its event. The Training Load
// external-schedule screen reads the server's 409 schedule_managed_by_calendar
// as one sentence - on the form's save (edit, Schedule again) and on Pause /
// Resume / Cancel in the detail overlay - and nothing else changes: every
// other refusal keeps today's handling. Through the real handlers with a fake
// fetch.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const { state, emptyExternalScheduleForm } = await import("../state.js");
const { handleTrainingLoadAction } = await import("../training-load-actions.js");

const SENTENCE = "This RPE request belongs to a calendar event. Change it on the event.";
const MANAGED = { status: 409, body: { error: "schedule_managed_by_calendar", message: "server text" } };
const renderTrainingLoad = () => {};
const run = (dataset) => handleTrainingLoadAction(fakeAction(dataset), { renderTrainingLoad, openWeeklyPlanForAthleteOnDate: () => {} });
const SCHEDULE_ID = "5c000000-0000-4000-8000-000000000001";

beforeEach(() => {
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1" }, permissions: ["load.view.team", "load.schedule.manage"] };
  state.trainingLoad.scheduleForm = null;
  state.trainingLoad.scheduleDetail = { scheduleId: SCHEDULE_ID, schedule: { id: SCHEDULE_ID, eventName: "Morning RPE", status: "active" }, targets: [], loading: false, error: "" };
});

function editForm() {
  state.trainingLoad.scheduleForm = emptyExternalScheduleForm({
    editingScheduleId: SCHEDULE_ID, eventName: "Morning RPE", startDate: "2026-11-20", opensTime: "18:00", closesTime: "23:59", timezone: "UTC",
  });
  return state.trainingLoad.scheduleForm;
}

test("TL1. saving an edit of a request a calendar question owns: the sentence, never the server's text; another refusal keeps its message", async () => {
  installFetchMock((call) => (call.method === "PATCH" ? MANAGED : { status: 200, body: {} }));
  let form = editForm();
  await run({ action: "training-load-schedule-submit" });
  assert.equal(form.error, SENTENCE);
  assert.equal(form.submitting, false);
  installFetchMock((call) => (call.method === "PATCH" ? { status: 409, body: { error: "schedule_not_editable", message: "This schedule can no longer be edited." } } : { status: 200, body: {} }));
  form = editForm();
  await run({ action: "training-load-schedule-submit" });
  assert.equal(form.error, "schedule_not_editable", "every other code as before (today's error.message)");
});

test("TL2. Pause / Resume / Cancel of such a request: the sentence in the detail overlay; any other failure is thrown as before", async () => {
  const calls = installFetchMock((call) => (call.method === "POST" ? MANAGED : { status: 200, body: {} }));
  for (const status of ["pause", "resume", "cancel"]) {
    state.trainingLoad.scheduleDetail.error = "";
    await run({ action: "training-load-set-external-schedule-status", scheduleId: SCHEDULE_ID, status });
    assert.equal(state.trainingLoad.scheduleDetail.error, SENTENCE, status);
  }
  assert.equal(calls.filter((c) => c.method === "POST").length, 3);
  assert.equal(calls.filter((c) => c.method === "GET").length, 0, "nothing re-read after the refusal");
  installFetchMock((call) => (call.method === "POST" ? { status: 409, body: { error: "schedule_cancelled", message: "Already cancelled." } } : { status: 200, body: {} }));
  await assert.rejects(run({ action: "training-load-set-external-schedule-status", scheduleId: SCHEDULE_ID, status: "pause" }), /schedule_cancelled/, "rethrown unchanged");
});

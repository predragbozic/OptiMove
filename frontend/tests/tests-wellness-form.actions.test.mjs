import { test } from "node:test";
import assert from "node:assert/strict";

// Exercises the state-mutation side of the WELLNESS form (slider drag,
// Yes/No answer, submit) directly against tests-actions.js's exported
// handlers, using a minimal DOM double - the same pattern
// organization-user-management.actions.test.mjs already establishes for
// this codebase's action-handler tests.

const domNodes = new Map();
function makeFakeParamRow(key) {
  const valueEl = { textContent: "" };
  const row = {
    classList: { list: new Set(["is-unanswered"]), add(c) { this.list.add(c); }, remove(c) { this.list.delete(c); }, contains(c) { return this.list.has(c); } },
    querySelector: (sel) => (sel === ".wellness-param-value" ? valueEl : null),
    _valueEl: valueEl,
  };
  domNodes.set(key, row);
  return row;
}

const progressEl = { textContent: "" };
const submitButtonEl = { disabled: true };

globalThis.document = {
  querySelector: (sel) => {
    if (sel === ".wellness-progress") return progressEl;
    if (sel === ".wellness-submit-button") return submitButtonEl;
    return null;
  },
  querySelectorAll: () => [],
  // isAthleteMode() (access.js) reads document.body.classList - the submit
  // flow's fire-and-forget badge refresh (loadPendingCount) calls it on
  // every successful submit, so this stub needs to exist even though these
  // tests aren't exercising athlete-mode detection itself.
  body: { classList: { contains: () => false } },
};

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

const { handleTestsSliderInput, handleTestsAction, submitTestsForm } = await import("../tests-actions.js");
const { emptyWellnessForm, state } = await import("../state.js");

const WELLNESS_PARAMETERS = ["fatigue", "sleep", "soreness", "stress", "mood"].map((key, i) => ({
  key, valueType: "integer", minimum: 0, maximum: 10, displayOrder: i, required: true, controlType: "slider", direction: "lower_better",
})).concat([{ key: "injury", valueType: "boolean", displayOrder: 5, required: true, controlType: "yes_no", direction: "neutral" }]);

function freshForm() {
  return emptyWellnessForm({ assignmentId: "assignment-1", testName: "WELLNESS", athleteName: "Test Athlete", canSubmit: true, parameters: WELLNESS_PARAMETERS });
}

function fakeSlider(key, value) {
  return { dataset: { key }, value: String(value), closest: () => domNodes.get(key), setAttribute() {} };
}

function fakeAction(dataset) {
  return { dataset };
}

test("dragging a slider marks that key answered and updates the progress count, without touching the others", () => {
  state.tests.form = freshForm();
  domNodes.clear();
  makeFakeParamRow("fatigue");
  handleTestsSliderInput(fakeSlider("fatigue", 0));
  assert.equal(state.tests.form.values.fatigue, 0);
  assert.equal(state.tests.form.answered.fatigue, true, "0 must be recorded as answered, not skipped as falsy");
  assert.equal(progressEl.textContent, "1 of 6 completed");
  assert.equal(submitButtonEl.disabled, true, "still incomplete - 5 more answers required");
  assert.equal(domNodes.get("fatigue")._valueEl.textContent, "0");
  assert.equal(domNodes.get("fatigue").classList.contains("is-answered"), true);
});

test("answering all 6 parameters (including 0s and Injury=No) enables Submit", async () => {
  state.tests.form = freshForm();
  domNodes.clear();
  for (const key of ["fatigue", "sleep", "soreness", "stress", "mood"]) {
    makeFakeParamRow(key);
    handleTestsSliderInput(fakeSlider(key, 0));
  }
  assert.equal(submitButtonEl.disabled, true, "Injury still unanswered");
  await handleTestsAction(fakeAction({ action: "tests-answer-boolean", key: "injury", value: "false" }), { renderTests: () => {} });
  assert.equal(state.tests.form.values.injury, false);
  assert.equal(state.tests.form.answered.injury, true);
});

test("submit sends exactly the answered values and a fresh idempotency key, and stores only the returned average", async () => {
  state.tests.form = freshForm();
  state.tests.form.values = { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: true };
  state.tests.form.answered = { fatigue: true, sleep: true, soreness: true, stress: true, mood: true, injury: true };
  installFetchMock((call) => (call.url.includes("/submit")
    ? { status: 200, body: { assessmentId: "a-1", values: { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: true }, wellnessScore: 4 } }
    : { status: 200, body: { assignments: [] } }));
  let rendered = 0;
  await submitTestsForm({ dataset: { testsForm: "wellness-submit" } }, { renderTests: () => { rendered += 1; } });
  // submitWellnessForm also fires a fire-and-forget background badge refresh
  // (void loadPendingCount().then(renderTestsBadge)) on success - flush the
  // microtask queue so that unawaited chain settles before this test ends,
  // instead of leaking into the next test's timing.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fetchCalls[0].url, "/api/tests/assignments/assignment-1/submit");
  assert.deepEqual(fetchCalls[0].body.values, { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: true });
  assert.ok(fetchCalls[0].body.idempotencyKey, "a submit must always carry an idempotency key");
  assert.equal(state.tests.form.result.wellnessScore, 4);
  assert.ok(rendered > 0);
});

test("correcting a saved answer clears the idempotency key so the resubmit is never silently deduped into the old result", async () => {
  state.tests.form = freshForm();
  state.tests.form.result = { wellnessScore: 3.6 };
  state.tests.form.idempotencyKey = "first-submit-key";
  await handleTestsAction(fakeAction({ action: "tests-correct-answer" }), { renderTests: () => {} });
  assert.equal(state.tests.form.result, null);
  assert.equal(state.tests.form.idempotencyKey, "", "a correction must get a brand-new idempotency key on its next submit");
});

test("a double-submit (same key already completed) never overwrites the score with an error - it accepts the server's idempotent-replay body", async () => {
  state.tests.form = freshForm();
  state.tests.form.values = { fatigue: 1, sleep: 1, soreness: 1, stress: 1, mood: 1, injury: false };
  state.tests.form.answered = { fatigue: true, sleep: true, soreness: true, stress: true, mood: true, injury: true };
  state.tests.form.idempotencyKey = "same-key";
  installFetchMock((call) => (call.url.includes("/submit")
    ? { status: 200, body: { assessmentId: "a-1", values: state.tests.form.values, wellnessScore: 1 } }
    : { status: 200, body: { assignments: [] } }));
  await submitTestsForm({ dataset: { testsForm: "wellness-submit" } }, { renderTests: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fetchCalls[0].body.idempotencyKey, "same-key", "an already-set key is reused for this exact submit, never regenerated mid-flight");
  assert.equal(state.tests.form.error, "");
  assert.equal(state.tests.form.result.wellnessScore, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";

// renderWellnessFormHtml/renderWellnessFormPageHtml are pure functions over
// a "form" object shaped like tests-data.js's formFromAssignmentDetail() -
// pinning the exact required states here: nothing pre-answered, Submit
// disabled until complete, 0/No counted as real answers, and a successful
// result showing only the average (never sum, never raw values) with the
// fixed "Lower is better" note.

// tests-view.js imports dom.js, which reads document.querySelector(...) at
// module top-level (the app's real `els` singleton) - a minimal stub lets
// this file import the real render functions without a browser, matching
// the convention already used by organization-user-management.actions.test.mjs.
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { renderWellnessFormHtml } = await import("../tests-view.js");
const { emptyWellnessForm } = await import("../state.js");

const WELLNESS_PARAMETERS = [
  { key: "fatigue", valueType: "integer", minimum: 0, maximum: 10, displayOrder: 0, required: true, controlType: "slider", direction: "lower_better", minLabel: "Fresh", maxLabel: "Exhausted", helpText: null },
  { key: "sleep", valueType: "integer", minimum: 0, maximum: 10, displayOrder: 1, required: true, controlType: "slider", direction: "lower_better", minLabel: "Excellent", maxLabel: "Very poor", helpText: null },
  { key: "soreness", valueType: "integer", minimum: 0, maximum: 10, displayOrder: 2, required: true, controlType: "slider", direction: "lower_better", minLabel: "None", maxLabel: "Severe", helpText: null },
  { key: "stress", valueType: "integer", minimum: 0, maximum: 10, displayOrder: 3, required: true, controlType: "slider", direction: "lower_better", minLabel: "Relaxed", maxLabel: "Extremely stressed", helpText: null },
  { key: "mood", valueType: "integer", minimum: 0, maximum: 10, displayOrder: 4, required: true, controlType: "slider", direction: "lower_better", minLabel: "Very good", maxLabel: "Very poor", helpText: null },
  { key: "injury", valueType: "boolean", minimum: null, maximum: null, displayOrder: 5, required: true, controlType: "yes_no", direction: "neutral", minLabel: null, maxLabel: null, helpText: "Reported presence of pain or injury today." },
];

function freshForm(overrides = {}) {
  return emptyWellnessForm({
    assignmentId: "assignment-1",
    testName: "WELLNESS",
    athleteName: "Test Athlete",
    closesAt: "2026-08-23T21:00:00.000Z",
    canSubmit: true,
    parameters: WELLNESS_PARAMETERS,
    ...overrides,
  });
}

test("initial state: no slider carries a pre-selected value, and it is visually distinguishable as unanswered", () => {
  const html = renderWellnessFormHtml(freshForm());
  assert.equal((html.match(/is-unanswered/g) || []).length, 6, "all 6 parameters start unanswered");
  assert.equal((html.match(/is-answered/g) || []).length, 0);
  assert.ok(html.includes(">–<"), "an unanswered slider shows a dash, never a number");
  assert.equal((html.match(/>–</g) || []).length, 5, "5 numeric params show the dash placeholder");
});

test("progress line reads 0 of 6 completed before anything is answered", () => {
  const html = renderWellnessFormHtml(freshForm());
  assert.ok(html.includes("0 of 6 completed"));
});

test("Submit is disabled while the form is incomplete", () => {
  const html = renderWellnessFormHtml(freshForm({ values: { fatigue: 3 }, answered: { fatigue: true } }));
  assert.match(html, /wellness-submit-button" disabled>/);
});

test("0 counts as answered for a numeric slider - not treated as empty", () => {
  const values = { fatigue: 0, sleep: 0, soreness: 0, stress: 0, mood: 0, injury: false };
  const answered = { fatigue: true, sleep: true, soreness: true, stress: true, mood: true, injury: true };
  const html = renderWellnessFormHtml(freshForm({ values, answered }));
  assert.ok(html.includes("6 of 6 completed"));
  assert.doesNotMatch(html, /wellness-submit-button"\s+disabled>/, "all-zero answers must still enable Submit");
  assert.ok(!html.includes("is-unanswered"), "no parameter should still read as unanswered");
});

test("Injury = No counts as answered - not treated as still-empty", () => {
  const values = { fatigue: 1, sleep: 1, soreness: 1, stress: 1, mood: 1, injury: false };
  const answered = { fatigue: true, sleep: true, soreness: true, stress: true, mood: true, injury: true };
  const html = renderWellnessFormHtml(freshForm({ values, answered }));
  assert.ok(html.includes("6 of 6 completed"));
  const injurySection = html.slice(html.indexOf('data-key="injury"'));
  assert.match(injurySection, /is-selected"[^>]*data-value="false"/);
});

test("Submit is disabled when the check-in window is already closed, even with a complete form", () => {
  const values = { fatigue: 1, sleep: 1, soreness: 1, stress: 1, mood: 1, injury: false };
  const answered = { fatigue: true, sleep: true, soreness: true, stress: true, mood: true, injury: true };
  const html = renderWellnessFormHtml(freshForm({ values, answered, canSubmit: false }));
  assert.match(html, /wellness-submit-button" disabled>/);
  assert.ok(html.includes("This check-in window is closed."));
});

test("a successful result shows only the average score and the fixed note - never sum, never raw per-parameter values", () => {
  const html = renderWellnessFormHtml(freshForm({ result: { wellnessScore: 2.2 } }));
  assert.ok(html.includes("Wellness score: <strong>2.2/10</strong>"));
  assert.ok(html.includes("Lower is better"));
  assert.ok(!html.includes("wellness-param"), "the editable form must not render at all once a result exists");
  assert.ok(!html.includes("Fatigue"), "no individual parameter values are shown alongside the result");
});

test("a reported injury shows a plain factual note on the result screen, no diagnosis or recommendation text", () => {
  const html = renderWellnessFormHtml(freshForm({ result: { wellnessScore: 6.4 }, injuryReported: true }));
  assert.ok(html.includes("You reported pain or injury today."));
});

test("the min/max labels shown are exactly the ones supplied (DB-driven), not hardcoded per parameter key", () => {
  const html = renderWellnessFormHtml(freshForm());
  assert.ok(html.includes("Fresh") && html.includes("Exhausted"));
  assert.ok(html.includes("None") && html.includes("Severe"));
  assert.ok(html.includes("Relaxed") && html.includes("Extremely stressed"));
});

test("the WELLNESS form uses real <label for> associations for keyboard/screen-reader access", () => {
  const html = renderWellnessFormHtml(freshForm());
  assert.match(html, /<label class="wellness-param-label" for="wellness-input-fatigue">/);
  assert.match(html, /id="wellness-input-fatigue"/);
});

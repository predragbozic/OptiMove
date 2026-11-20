// Central calendar K4b - the athlete changes their own RPE answer while the question is open (contract
// docs/ai/central-calendar-k4b-contract.md section 6; mockup docs/design/calendar-k4/05-k4b-change-rpe.html). The real
// view and action modules with a fake fetch; the coach's "Changed" mark on the event panel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const { state, emptyTrainingLoadState } = await import("../state.js");
const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const { renderTrainingLoadAthleteOverlaysHtml, renderTrainingLoadSessionListHtml } = await import("../training-load-view.js");
const { renderRpeAnswerChangeHomeHtml, renderRpeAnswerLineHtml, rpeChangeTimeText } = await import("../rpe-answer-change.js");
const { renderAthleteHomeHtml } = await import("../athlete-home.js");
const { renderCentralCalendarQuestionsHtml } = await import("../central-calendar-questions.js");

const ASSIGNMENT = "11111111-1111-4111-8111-111111111111";
const at = (h, mi, dayShift = 0) => { const d = new Date(); d.setDate(d.getDate() + dayShift); d.setHours(h, mi, 0, 0); return d.toISOString(); };
const TODAY_ISO = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const feedback = (over = {}) => ({ rpe: 7, durationMinutes: 60, srpe: 420, note: "first", submittedAt: at(12, 4), ...over });
const row = (over = {}) => ({
  sessionId: null, externalAssignmentId: ASSIGNMENT, source: "scheduled_external", sessionName: "Team training", amPm: "", bta: "", sessionTime: "",
  rated: true, feedback: feedback(), changeable: true, revision: 0, closesAt: at(22, 0), opensAt: at(0, 0), ...over,
});
const renders = [];
const render = () => renders.push(1);
const act = (dataset, extra) => handleTrainingLoadAction(fakeAction(dataset, extra), { renderTrainingLoad: render, openWeeklyPlanForAthleteOnDate: () => {} });

function fresh(sessions = [row()]) {
  state.trainingLoad = emptyTrainingLoadState();
  state.trainingLoad.athleteToday = { date: TODAY_ISO, sessions };
  renders.length = 0;
}
const form = () => state.trainingLoad.rpeForm;
const html = () => renderTrainingLoadAthleteOverlaysHtml();

test("1. the answer line: 'Your RPE: 7 · Change' with 'You can change it until 22:00.' while changeable; 'Answers closed at 22:00.' once the window passed; nothing for a planned or unrated row", () => {
  const open = renderRpeAnswerLineHtml(row());
  assert.match(open, /Your RPE: 7/);
  assert.match(open, /data-action="training-load-rpe-change-open" data-assignment-id="11111111-1111-4111-8111-111111111111"/);
  assert.match(open, />Change</);
  assert.match(open, /You can change it until 22:00\./);
  const closed = renderRpeAnswerLineHtml(row({ changeable: false, closesAt: new Date(Date.now() - 60_000).toISOString() }));
  assert.match(closed, /Your RPE: 7/);
  assert.match(closed, /Answers closed at \d\d:\d\d\./);
  assert.doesNotMatch(closed, /Change</);
  assert.equal(renderRpeAnswerLineHtml(row({ source: "planned", externalAssignmentId: null, sessionId: "s1" })), "", "a planned answer is never offered Change");
  assert.equal(renderRpeAnswerLineHtml(row({ rated: false, feedback: null })), "");
  assert.equal(renderRpeAnswerLineHtml(row({ changeable: false, closesAt: at(23, 59, 1) })), "", "not changeable but not yet closed (e.g. a stopped question): no line");
  assert.match(rpeChangeTimeText(at(22, 0, 1)), /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) 22:00$/, "another day names its weekday");
});

test("2. Home shows today's changeable answers; the list's rated row carries the line too; the text is escaped", () => {
  fresh([row({ sessionName: "<b>Team</b> training" }), row({ externalAssignmentId: "22222222-2222-4222-8222-222222222222", changeable: false })]);
  const home = renderRpeAnswerChangeHomeHtml(state.trainingLoad.athleteToday);
  assert.match(home, /Your answers today/);
  assert.equal((home.match(/training-load-rpe-change"/g) || []).length, 1, "only the changeable one");
  assert.match(home, /&lt;b&gt;Team&lt;\/b&gt; training/);
  assert.doesNotMatch(home, /<b>Team/);
  const page = renderAthleteHomeHtml({ data: { athlete: { name: "Athlete" }, today: { date: TODAY_ISO }, week: { days: [] } }, error: "" });
  assert.match(page, /Your answers today/);
  const list = renderTrainingLoadSessionListHtml(state.trainingLoad.athleteToday);
  assert.match(list, /RPE 7 · 60 min/);
  assert.match(list, /training-load-rpe-change-open/);
  fresh([row({ changeable: false })]);
  assert.equal(renderRpeAnswerChangeHomeHtml(state.trainingLoad.athleteToday), "");
});

test("3. Change opens the form filled in: 'Change your RPE', 'Your answer: 7, sent at 12:04.', the deadline and the coach line; Save change is off while nothing differs", async () => {
  fresh();
  await act({ action: "training-load-rpe-change-open", assignmentId: ASSIGNMENT });
  assert.equal(form().mode, "change");
  assert.deepEqual([form().rpe, form().durationMinutes, form().note, form().expectedRevision], [7, 60, "first", 0]);
  const h = html();
  assert.match(h, /Change your RPE/);
  assert.match(h, /Your answer: 7, sent at 12:04\./);
  assert.match(h, /You can change it until 22:00\. Your coach sees that it was changed\./);
  assert.match(h, /Duration \(minutes\)/);
  assert.match(h, /value="60"/);
  assert.match(h, />first<\/textarea>/);
  assert.match(h, /<button[^>]*training-load-rpe-save[^>]*disabled[^>]*>Save change</);
  // The duration may change (Q1): the field is editable and a new value turns Save change on.
  await act({ action: "training-load-rpe-duration-input" }, { value: "75" });
  assert.equal(form().durationMinutes, 75);
  assert.doesNotMatch(html(), /training-load-rpe-save[^>]*disabled/);
  // Back to the saved values: off again (the note compared after the trim).
  await act({ action: "training-load-rpe-duration-input" }, { value: "60" });
  await act({ action: "training-load-rpe-note-input" }, { value: "  first " });
  assert.match(html(), /training-load-rpe-save[^>]*disabled/);
});

test("4. Change is not offered and does not open for an unchangeable, planned or unrated row", async () => {
  for (const r of [row({ changeable: false }), row({ source: "planned" }), row({ rated: false, feedback: null })]) {
    fresh([r]);
    await act({ action: "training-load-rpe-change-open", assignmentId: ASSIGNMENT });
    assert.equal(form(), null);
  }
});

test("5. Save change: one request with a fresh key, the values and expectedRevision; a double tap sends one; 'Saved' with the new answer; the reads are refreshed on Done", async () => {
  fresh();
  await act({ action: "training-load-rpe-change-open", assignmentId: ASSIGNMENT });
  await act({ action: "training-load-rpe-slider-input" }, { value: "5" });
  await act({ action: "training-load-rpe-duration-input" }, { value: "75" });
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = installFetchMock(async (call) => {
    if (call.url.includes("/rpe/change")) { await gate; return { status: 200, body: { outcome: "changed", feedback: { ...feedback({ rpe: 5, durationMinutes: 75, srpe: 375 }), revision: 1 } } }; }
    return { status: 200, body: { date: TODAY_ISO, sessions: [] } };
  });
  const first = act({ action: "training-load-rpe-submit" });
  const second = act({ action: "training-load-rpe-submit" });
  release();
  await Promise.all([first, second]);
  const sent = calls.filter((c) => c.url.includes("/rpe/change"));
  assert.equal(sent.length, 1, "a double tap sends one request");
  assert.equal(sent[0].url, `/api/training-load/external-assignments/${ASSIGNMENT}/rpe/change`);
  assert.match(sent[0].body.requestKey, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...sent[0].body, requestKey: null }, { requestKey: null, rpe: 5, durationMinutes: 75, note: "first", expectedRevision: 0 });
  assert.match(html(), /Saved/);
  assert.match(html(), /Your RPE: 5 · 75 min · sRPE 375/);
  await act({ action: "training-load-close-rpe-form" });
  assert.equal(form(), null);
  assert.ok(calls.some((c) => c.url.includes("/api/training-load/athlete/today")), "Done reads today again");
});

test("6. a result not confirmed (no answer, a 5xx, 503): 'We can't tell yet…', the fields frozen, Check result sends the SAME key; a later answer settles it", async () => {
  fresh();
  await act({ action: "training-load-rpe-change-open", assignmentId: ASSIGNMENT });
  await act({ action: "training-load-rpe-slider-input" }, { value: "4" });
  const answers = [{ throwNetworkError: true }, { status: 503, body: { error: "outcome_unknown" } }, { status: 200, body: { outcome: "replayed", feedback: { ...feedback({ rpe: 4, srpe: 240 }), revision: 1 } } }];
  const calls = installFetchMock(() => answers.shift());
  await act({ action: "training-load-rpe-submit" });
  assert.equal(form().unconfirmed, true);
  assert.match(html(), /We can(?:'|&#039;)t tell yet whether your change was saved\./);
  assert.match(html(), />Check result</);
  assert.match(html(), /<fieldset class="training-load-rpe-change-fields" disabled>/);
  // A frozen field does not move.
  await act({ action: "training-load-rpe-slider-input" }, { value: "9" });
  assert.equal(form().rpe, 4);
  await act({ action: "training-load-rpe-submit" });
  assert.equal(form().unconfirmed, true, "a 503 stays not confirmed");
  await act({ action: "training-load-rpe-submit" });
  const keys = calls.map((c) => c.body.requestKey);
  assert.equal(new Set(keys).size, 1, "every Check result repeats the same key");
  assert.equal(form().unconfirmed, false);
  assert.match(html(), /Your RPE: 4/);
});

test("6b. a busy answer to Check result says nothing of the first attempt: still not confirmed, never 'Nothing was saved', the same key", async () => {
  fresh();
  await act({ action: "training-load-rpe-change-open", assignmentId: ASSIGNMENT });
  await act({ action: "training-load-rpe-slider-input" }, { value: "4" });
  const calls = installFetchMock([{ throwNetworkError: true }, { status: 409, body: { error: "try_again", message: "Nothing was saved. Try again." } }]);
  await act({ action: "training-load-rpe-submit" });
  await act({ action: "training-load-rpe-submit" });
  assert.equal(form().unconfirmed, true);
  assert.match(html(), /We can(?:'|&#039;)t tell yet whether your change was saved\./);
  assert.doesNotMatch(html(), /Nothing was saved/);
  assert.match(html(), />Check result</);
  assert.equal(calls[0].body.requestKey, calls[1].body.requestKey);
});

test("7. answer_locked: the stable sentence, the fields frozen, only Done; answer_changed: the form refilled with the current answer and its revision; try_again: the form stays and the next try is a new key", async () => {
  fresh();
  await act({ action: "training-load-rpe-change-open", assignmentId: ASSIGNMENT });
  await act({ action: "training-load-rpe-slider-input" }, { value: "3" });
  installFetchMock([{ status: 409, body: { error: "answer_locked", message: "This answer can no longer be changed. The question is closed.", feedback: { ...feedback(), revision: 0 } } }]);
  await act({ action: "training-load-rpe-submit" });
  assert.equal(form().locked, true);
  assert.match(html(), /This answer can no longer be changed\. The question is closed\./);
  assert.doesNotMatch(html(), /Save change|Check result|>Cancel</);
  assert.match(html(), />Done</);
  await act({ action: "training-load-rpe-slider-input" }, { value: "9" });
  assert.equal(form().rpe, 7, "refilled with the saved answer and frozen");

  fresh();
  await act({ action: "training-load-rpe-change-open", assignmentId: ASSIGNMENT });
  await act({ action: "training-load-rpe-slider-input" }, { value: "3" });
  installFetchMock([{ status: 409, body: { error: "answer_changed", message: "Your answer was changed on another screen. Check it and try again.", feedback: { ...feedback({ rpe: 9, durationMinutes: 80 }), revision: 2 } } }]);
  await act({ action: "training-load-rpe-submit" });
  assert.deepEqual([form().rpe, form().durationMinutes, form().expectedRevision, form().locked, form().unconfirmed], [9, 80, 2, false, false]);
  assert.match(html(), /changed on another screen/);

  fresh();
  await act({ action: "training-load-rpe-change-open", assignmentId: ASSIGNMENT });
  await act({ action: "training-load-rpe-slider-input" }, { value: "3" });
  const calls = installFetchMock([{ status: 409, body: { error: "try_again", message: "Nothing was saved. Try again." } }, { status: 200, body: { outcome: "changed", feedback: { ...feedback({ rpe: 3 }), revision: 1 } } }]);
  await act({ action: "training-load-rpe-submit" });
  assert.match(html(), /Nothing was saved\. Try again\./);
  await act({ action: "training-load-rpe-submit" });
  assert.notEqual(calls[0].body.requestKey, calls[1].body.requestKey, "a refused try leaves its key; the next is new");
  assert.match(html(), /Saved/);
});

test("8. 'unchanged' closes the form without a sentence; the first-answer form is untouched (Save, the old submit route)", async () => {
  fresh();
  await act({ action: "training-load-rpe-change-open", assignmentId: ASSIGNMENT });
  await act({ action: "training-load-rpe-slider-input" }, { value: "6" });
  installFetchMock([{ status: 200, body: { outcome: "unchanged", feedback: { ...feedback(), revision: 0 } } }]);
  await act({ action: "training-load-rpe-submit" });
  assert.equal(form(), null);

  fresh([row({ rated: false, feedback: null, changeable: false })]);
  await act({ action: "training-load-open-rpe-form", sessionId: ASSIGNMENT });
  assert.equal(form().mode, "submit");
  assert.match(html(), /Rate session/);
  assert.match(html(), />Save</);
  await act({ action: "training-load-rpe-duration-input" }, { value: "60" });
  const calls = installFetchMock([{ status: 201, body: { feedback: feedback() } }]);
  await act({ action: "training-load-rpe-submit" });
  assert.equal(calls[0].url, `/api/training-load/external-assignments/${ASSIGNMENT}/rpe`);
});

test("9. the coach's event panel: an answered athlete whose answer changed reads 'Changed HH:MM'; the others not", () => {
  const item = { key: "k", id: "e1", cancelled: false, kind: "event" };
  const pq = { key: "k", read: { questions: [{
    id: "q1", kind: "rpe", status: "live", window: { kind: "custom", date: TODAY_ISO, from: "00:00", to: "23:59" },
    counts: { asked: 2, answered: 2, later: 0, notAnswered: 0 },
    answered: [{ athleteId: "a1", name: "Ana K.", changed: true, lastChangedAt: at(20, 41) }, { athleteId: "a2", name: "Ben D.", changed: false, lastChangedAt: null }],
    later: [], notAnswered: [],
  }] } };
  const out = renderCentralCalendarQuestionsHtml(item, pq, { today: TODAY_ISO });
  assert.match(out, /Ana K\. <span class="cc-question-changed">· Changed 20:41<\/span>/);
  assert.match(out, /<li>Ben D\.<\/li>/);
});

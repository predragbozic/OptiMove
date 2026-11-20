// K4 follow-ups (the stream manager's order of 2026-11-20, after K4a-F and K4b): the athlete Calendar's signed-out
// state gets a Sign in button; the closed line names the date on another day; the change form's 404 sentence; one name,
// "RPE request", for her coach's request on her screens (the coach's keep "Outside plan"); plain words instead of
// sRPE/AU on her screens (the coach's keep them, pinned by training-load.actions A1 and the Results tests).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

let previewEl = null;
globalThis.document = {
  querySelector: (selector) => (selector === "[data-training-load-srpe-preview]" ? previewEl : null),
  querySelectorAll: () => [],
  body: { classList: { contains: () => true } },
};
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const data = await import("../athlete-calendar-data.js");
const { handleAthleteCalendarAction } = await import("../athlete-calendar-actions.js");
const { renderAthleteCalendarHtml } = await import("../athlete-calendar-view.js");
const { state, emptyTrainingLoadState, emptyRpeForm } = await import("../state.js");
const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const view = await import("../training-load-view.js");
const { applyRpeChangeAnswer, renderRpeAnswerLineHtml, rpeChangeFormFields, rpeClosedTimeText } = await import("../rpe-answer-change.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
const feedback = { rpe: 7, durationMinutes: 60, srpe: 420, note: "", submittedAt: "2026-10-12T10:04:00.000Z" };
const external = (over = {}) => ({
  sessionId: null, externalAssignmentId: "asg-1", source: "scheduled_external", sessionName: "Match RPE", amPm: "", bta: "",
  rated: true, feedback, changeable: false, revision: 0, closesAt: "2999-01-01T22:00:00.000Z", actionable: true, ...over,
});
const dom = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;

beforeEach(() => {
  clearAllViewCache();
  data.resetAthleteCalendar();
  state.currentUser = { id: "u-athlete", activeWorkspace: { type: "athlete", scopeId: null } };
  state.trainingLoad = emptyTrainingLoadState();
  state.deliberateNavigation = false;
  previewEl = null;
});

// --- 1. The Calendar signed out ----------------------------------------------

test("F1. a 401 on the Calendar: 'Please sign in again.' with one Sign in button (no Try again); Sign in goes to the login as a deliberate navigation", async () => {
  installFetchMock(() => ({ status: 401, body: { error: "unauthorized" } }));
  await data.loadAthleteCalendar({ weekStart: MONDAY, forceRefresh: true });
  const doc = dom(renderAthleteCalendarHtml(data.athleteCalendarState(), { today: TODAY }));
  const state401 = doc.querySelector(".ac-state");
  assert.match(state401.textContent, /Please sign in again\./);
  const button = state401.querySelector('[data-action="athlete-calendar-sign-in"]');
  assert.ok(button, "the Sign in button");
  assert.equal(button.textContent.trim(), "Sign in");
  assert.ok(button.classList.contains("ac-button"), "a 44 px .ac-button");
  assert.equal(state401.querySelector('[data-action="athlete-calendar-retry"]'), null, "no Try again when signed out");

  let signedIn = 0;
  const handled = await handleAthleteCalendarAction(fakeAction({ action: "athlete-calendar-sign-in" }), { signIn: () => { signedIn += 1; } });
  assert.equal(handled, true);
  assert.equal(signedIn, 1);
  assert.equal(state.deliberateNavigation, true);
});

test("F1c. a 401 over a loaded week (her return to the tab): the notice offers Sign in; a later good read removes it", async () => {
  const week = (from) => {
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(`${from}T12:00:00`); d.setDate(d.getDate() + i); return { date: localDateIso(d), items: [] }; });
    return { from, to: days[6].date, today: TODAY, workspace: { type: "athlete", scopeId: null }, teams: [], days };
  };
  const answers = [{ status: 200, body: week(MONDAY) }, { status: 401, body: { error: "unauthorized" } }, { status: 200, body: week(MONDAY) }];
  installFetchMock((call) => (call.url.startsWith("/api/calendar?") ? answers.shift() : { status: 200, body: { days: [] } }));
  await data.loadAthleteCalendar({ weekStart: MONDAY, forceRefresh: true });
  // The week is on screen but no longer cached (view-cache.js keeps a cached copy over a failed refresh and never
  // calls applyError for it): the 401 reaches the "last loaded calendar" notice.
  clearAllViewCache();
  await data.loadAthleteCalendar({ weekStart: MONDAY, forceRefresh: true });
  let doc = dom(renderAthleteCalendarHtml(data.athleteCalendarState(), { today: TODAY }));
  assert.match(doc.body.textContent, /Please sign in again\. Showing the last loaded calendar\./);
  assert.ok(doc.querySelector('.ac-notice [data-action="athlete-calendar-sign-in"]'), "Sign in beside the notice");
  assert.doesNotMatch(doc.body.textContent, /Loading calendar/, "the last loaded week is shown, not a loading line");
  data.athleteCalendarState().notice = "";
  await data.loadAthleteCalendar({ weekStart: MONDAY, forceRefresh: true });
  doc = dom(renderAthleteCalendarHtml(data.athleteCalendarState(), { today: TODAY }));
  assert.equal(doc.querySelector('[data-action="athlete-calendar-sign-in"]'), null);
  assert.equal(data.athleteCalendarState().signedOut, false);
});

test("F1b. any other failure keeps Try again and offers no Sign in", async () => {
  installFetchMock(() => ({ status: 500, body: { error: "internal_error" } }));
  await data.loadAthleteCalendar({ weekStart: MONDAY, forceRefresh: true });
  const doc = dom(renderAthleteCalendarHtml(data.athleteCalendarState(), { today: TODAY }));
  assert.ok(doc.querySelector('[data-action="athlete-calendar-retry"]'));
  assert.equal(doc.querySelector('[data-action="athlete-calendar-sign-in"]'), null);
});

// --- 2a. The closed line names the date on another day ----------------------

test("F2. 'Answers closed at 22:00.' today; 'Answers closed on 12.10 at 22:00.' on another day", () => {
  const now = new Date(2026, 9, 14, 9, 0);
  const todayClose = new Date(2026, 9, 14, 8, 0).toISOString();
  const earlier = new Date(2026, 9, 12, 22, 0).toISOString();
  assert.equal(rpeClosedTimeText(todayClose, now), "at 08:00");
  assert.equal(rpeClosedTimeText(earlier, now), "on 12.10 at 22:00");
  assert.match(renderRpeAnswerLineHtml(external({ closesAt: todayClose }), { now }), /Answers closed at 08:00\./);
  const past = renderRpeAnswerLineHtml(external({ closesAt: earlier }), { now });
  assert.match(past, /Your RPE: 7/);
  assert.match(past, /Answers closed on 12\.10 at 22:00\./);
  assert.doesNotMatch(past, /Mon|Tue|Wed|Thu|Fri|Sat|Sun/, "never a weekday on a past card");
});

// --- 2b. The 404 sentence ------------------------------------------------------

test("F3. a change answered 404: 'This RPE request is no longer available.'", () => {
  const form = emptyRpeForm({ externalAssignmentId: "asg-1", source: "scheduled_external", ...rpeChangeFormFields(external({ changeable: true })) });
  applyRpeChangeAnswer(form, { error: { status: 404, data: { error: "not_found" } } });
  assert.equal(form.error, "This RPE request is no longer available.");
  assert.equal(form.locked, true);
});

// --- 2c / 2d. Her words on her screens, the coach's on the coach's -----------

test("F4. her list row: the tag 'RPE request' (not 'Outside plan') and 'RPE 7 · 60 min · Load 420' (no sRPE, no AU)", () => {
  const html = view.renderTrainingLoadSessionListHtml({ date: TODAY, sessions: [external()] });
  assert.match(html, /training-load-outside-plan-tag">RPE request</);
  assert.doesNotMatch(html, /Outside plan/);
  assert.match(html, /RPE 7 · 60 min · Load 420/);
  assert.doesNotMatch(html, /sRPE|\bAU\b/);
  assert.equal(view.formatAthleteFeedbackSummary(feedback), "RPE 7 · 60 min · Load 420");
  assert.equal(view.formatFeedbackSummary(feedback), "RPE 7 · 60 min · sRPE 420 AU", "the coach's summary is unchanged");
});

test("F5. the RPE form: the tag 'RPE request', the preview 'Training load (RPE × minutes): 420', and the same words when the minutes change", async () => {
  state.trainingLoad.rpeForm = emptyRpeForm({ externalAssignmentId: "asg-1", source: "scheduled_external", sessionName: "Match RPE", date: TODAY, rpe: 7, durationMinutes: 60 });
  let html = view.renderTrainingLoadAthleteOverlaysHtml();
  assert.match(html, /training-load-outside-plan-tag">RPE request</);
  assert.match(html, /Training load \(RPE × minutes\): <strong>420<\/strong>/);
  assert.doesNotMatch(html, /sRPE|\bAU\b/);
  // Typing the minutes patches the preview in place (training-load-actions.js patchSrpePreview).
  previewEl = { innerHTML: "" };
  await handleTrainingLoadAction(fakeAction({ action: "training-load-rpe-duration-input" }, { value: "75" }), { renderTrainingLoad: () => {} });
  assert.equal(previewEl.innerHTML, "Training load (RPE × minutes): <strong>525</strong>");
  await handleTrainingLoadAction(fakeAction({ action: "training-load-rpe-duration-input" }, { value: "" }), { renderTrainingLoad: () => {} });
  assert.equal(previewEl.innerHTML, "Training load: enter the minutes");
  // The saved first answer.
  state.trainingLoad.rpeForm.savedFeedback = feedback;
  html = view.renderTrainingLoadAthleteOverlaysHtml();
  assert.match(html, /RPE 7 · 60 min · Load 420/);
  assert.doesNotMatch(html, /sRPE|\bAU\b/);
});

test("F6. the change form: the tag 'RPE request', the preview and the saved change in her words", () => {
  state.trainingLoad.rpeForm = emptyRpeForm({ externalAssignmentId: "asg-1", source: "scheduled_external", sessionName: "Match RPE", date: TODAY, ...rpeChangeFormFields(external({ changeable: true })) });
  let html = view.renderTrainingLoadAthleteOverlaysHtml();
  assert.match(html, /Change your RPE · Match RPE<span class="training-load-outside-plan-tag">RPE request</);
  assert.match(html, /Training load \(RPE × minutes\): <strong>420<\/strong>/);
  state.trainingLoad.rpeForm.savedFeedback = { ...feedback, rpe: 5, srpe: 300 };
  html = view.renderTrainingLoadAthleteOverlaysHtml();
  assert.match(html, /Your RPE: 5 · 60 min · Load 300/);
  assert.doesNotMatch(html, /sRPE|\bAU\b/);
});

test("F7. the coach's Results drill-down keeps 'Outside plan' and 'sRPE … AU'", () => {
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  const date = MONDAY;
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${MONDAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    return { date: iso, sessions: iso === date ? [external({ athleteId: "ath-1", athleteName: "Ana Example", sessionName: "National team camp", scheduleId: "sched-1", scheduleStatus: "active", assignmentStatus: "completed", status: "tracked_rpe_on" })] : [] };
  });
  state.trainingLoad.weekly.results.data = { weekStart: MONDAY, weekEnd: days[6].date, days };
  state.trainingLoad.resultsAthleteId = "ath-1";
  const html = view.renderTrainingLoadResultsHtml();
  assert.match(html, /training-load-outside-plan-tag">Outside plan</);
  assert.doesNotMatch(html, /training-load-outside-plan-tag">RPE request</);
  assert.match(html, /sRPE 420 AU/);
});

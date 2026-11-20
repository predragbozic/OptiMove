// K4b on the athlete's Calendar (docs/ai/central-calendar-k4b-contract.md; the stream manager's Q-A and data rule of
// 2026-11-20): "Your RPE: 7 · Change" on her own "RPE request" card. Through the real card model and loaders
// (athlete-calendar-data.js, athlete-calendar-answers.js), the real handlers (athlete-calendar-actions.js), the real
// template (athlete-calendar-view.js) and the real change form (training-load-actions.js, training-load-view.js), with
// a fake fetch that answers her GET /api/calendar, GET /api/training-load/weekly and the v83 change route. The app.js
// glue (changeAnswer, the re-read after a saved or closed change) is exercised by the e2e scenario; here the handler
// is the same call app.js makes (openRpeChangeFormFromRow with the day's label).
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => true } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const data = await import("../athlete-calendar-data.js");
const answersModule = await import("../athlete-calendar-answers.js");
const { athleteCalendarAnswered, handleAthleteCalendarAction } = await import("../athlete-calendar-actions.js");
const { renderAthleteCalendarHtml } = await import("../athlete-calendar-view.js");
const { state, emptyTrainingLoadState } = await import("../state.js");
const { handleTrainingLoadAction, openRpeChangeFormFromRow } = await import("../training-load-actions.js");
const { renderTrainingLoadAthleteOverlaysHtml } = await import("../training-load-view.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
const ATHLETE = { id: "u-athlete", activeWorkspace: { type: "athlete", scopeId: null } };
const MINE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const at = (h, mi, dayShift = 0) => { const d = new Date(); d.setDate(d.getDate() + dayShift); d.setHours(h, mi, 0, 0); return d.toISOString(); };
const FAR = "2999-01-01T22:00:00.000Z";

after(() => restoreFetch());

// Her "RPE request" card (the calendar's athlete shape), answered.
function externalCard({ date = TODAY, assignmentId = MINE, rpe = "submitted", title = "Match RPE", key = "sch-1" } = {}) {
  return {
    key: `external:${key}:${date}`, kind: "external", date, title, eventType: "match", startTime: "00:00", teamIds: ["team-1"],
    athletes: [{ athleteId: "a-1", name: "Ana Example", teamIds: [], assignmentId, assignmentStatus: rpe === "submitted" ? "completed" : "pending", rpe }],
    links: { activityIds: [], externalScheduleId: key, externalOccurrenceId: `occ-${key}` }, cancelled: false,
  };
}
function eventCard({ date = TODAY, rpe = "submitted" } = {}) {
  return {
    key: `event:ev-1:${date}`, kind: "event", date, title: "Team training", eventKind: "training", eventTypeLabel: "Training", eventTypeIconKey: null,
    eventTypeColorKey: null, span: { from: date, to: date }, startTime: "10:00", endTime: "11:30", timezone: "Europe/Sarajevo", location: null, place: null,
    status: "planned", cancelled: false, teamIds: ["team-1"], links: { eventId: "ev-1" },
    sessions: [{ title: "Main session", slot: { amPm: "AM", bta: "T", order: 1 }, time: "10:30", timeFromEvent: false, sessionId: "ps-1", logicalSessionId: "ls-ps-1", rpe }],
  };
}
function plannedCard({ date = TODAY } = {}) {
  return {
    key: `planned:grp-ps-9:${date}`, kind: "planned", date, title: "Gym", slot: { amPm: "AM", bta: "T", order: 1 }, startTime: null, startsAt: null,
    teamIds: [], athleteIds: ["a-1"], athleteCount: 1, expects: ["rpe"], status: "none",
    athletes: [{ athleteId: "a-1", name: "Ana Example", teamIds: [], planId: "plan-1", sessionId: "ps-9", logicalSessionId: "ls-ps-9", rpe: "submitted" }],
    links: { activityIds: [], planIds: ["plan-1"], logicalSessionIds: ["ls-ps-9"] },
  };
}
function weekAnswer(cards, from = MONDAY) {
  const days = Array.from({ length: 7 }, (_, i) => ({ date: addDaysIso(from, i), items: cards.filter((c) => c.date === addDaysIso(from, i)) }));
  return { from, to: addDaysIso(from, 6), today: TODAY, workspace: { type: "athlete", scopeId: null }, teams: [], days };
}
const feedback = (over = {}) => ({ rpe: 7, durationMinutes: 60, srpe: 420, note: "first", submittedAt: at(12, 4), ...over });
// One row of her weekly read (training-load weekly, athlete workspace).
const weeklyRow = (over = {}) => ({
  sessionId: null, externalAssignmentId: MINE, source: "scheduled_external", sessionName: "Match RPE", rated: true,
  feedback: feedback(), changeable: true, revision: 0, closesAt: FAR, ...over,
});
function weeklyAnswer(rows, from = MONDAY) {
  return { weekStart: from, days: Array.from({ length: 7 }, (_, i) => ({ date: addDaysIso(from, i), sessions: addDaysIso(from, i) === TODAY ? rows : [] })) };
}

let cards = [];
let weeklyRows = [];
let weeklyHandler = null;
let changeHandler = null;
function server() {
  return installFetchMock(async (call) => {
    if (call.url.startsWith("/api/calendar/questions/mine")) return { status: 200, body: { questions: [] } };
    if (call.url.startsWith("/api/calendar?")) {
      const from = new URL(call.url, "http://x").searchParams.get("from");
      return { status: 200, body: weekAnswer(cards.filter((c) => c.date >= from && c.date <= addDaysIso(from, 6)), from) };
    }
    if (call.url.startsWith("/api/training-load/weekly?")) {
      const from = new URL(call.url, "http://x").searchParams.get("weekStart");
      if (weeklyHandler) return weeklyHandler(call, from);
      return { status: 200, body: weeklyAnswer(from === MONDAY ? weeklyRows : [], from) };
    }
    if (call.url.includes("/rpe/change")) return changeHandler ? changeHandler(call) : { status: 404, body: { error: "not found" } };
    return { status: 200, body: { date: TODAY, sessions: [] } };
  });
}
const weeklyCalls = (calls) => calls.filter((c) => c.url.startsWith("/api/training-load/weekly?"));
const calendarCalls = (calls) => calls.filter((c) => c.url.startsWith("/api/calendar?"));

let html = "";
const render = () => { html = renderAthleteCalendarHtml(data.athleteCalendarState(), { questions: [], today: TODAY }); };
const dom = () => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
const card = (key) => dom().querySelector(`.ac-card[data-key="${key}"]`);
const changeButton = (key) => card(key)?.querySelector('[data-action="athlete-calendar-rpe-change"]');
const overlay = () => renderTrainingLoadAthleteOverlaysHtml();
const form = () => state.trainingLoad.rpeForm;
const tl = (dataset, extra) => handleTrainingLoadAction(fakeAction(dataset, extra), { renderTrainingLoad: render, openWeeklyPlanForAthleteOnDate: () => {} });

// The handlers app.js passes (athleteCalendarHandlers().changeAnswer).
const opened = [];
const handlers = () => ({
  render,
  loadQuestions: async () => {},
  changeAnswer: (row, { date, title } = {}) => {
    const f = openRpeChangeFormFromRow(row, { date, title, dateLabel: date ? data.athleteCalendarDayLabel(date) : "" });
    if (f) opened.push(f);
    render();
  },
});
async function load() {
  await data.loadAthleteCalendar({ render, weekStart: MONDAY, forceRefresh: true });
  await answersModule.athleteCalendarAnswersSettled();
  render();
}
function pressChange(key = `external:sch-1:${TODAY}`) {
  const button = changeButton(key);
  assert.ok(button, "Change is offered");
  return handleAthleteCalendarAction(fakeAction({ ...button.dataset }), handlers());
}

beforeEach(() => {
  clearAllViewCache();
  data.resetAthleteCalendar();
  state.currentUser = ATHLETE;
  state.trainingLoad = emptyTrainingLoadState();
  data.athleteCalendarState().weekStart = MONDAY;
  cards = [];
  weeklyRows = [];
  weeklyHandler = null;
  changeHandler = null;
  opened.length = 0;
  html = "";
});

test("B1. her RPE request card: changeable → 'Your RPE: 7 · Change' and the deadline; closed → 'Answers closed at'; neither → 'RPE given'; no weekly row → 'RPE given'", async () => {
  cards = [externalCard({})];
  weeklyRows = [weeklyRow({ closesAt: at(22, 0) })];
  server();
  await load();
  const open = card(`external:sch-1:${TODAY}`);
  assert.match(open.textContent, /Your RPE: 7/);
  assert.ok(changeButton(`external:sch-1:${TODAY}`));
  assert.match(open.textContent, /You can change it until 22:00\./);
  assert.doesNotMatch(open.textContent, /RPE given/);

  data.resetAthleteCalendar(); data.athleteCalendarState().weekStart = MONDAY;
  weeklyRows = [weeklyRow({ changeable: false, closesAt: new Date(Date.now() - 60_000).toISOString() })];
  await load();
  assert.match(card(`external:sch-1:${TODAY}`).textContent, /Your RPE: 7 · Answers closed at \d\d:\d\d\./);
  assert.equal(changeButton(`external:sch-1:${TODAY}`), null);

  data.resetAthleteCalendar(); data.athleteCalendarState().weekStart = MONDAY;
  weeklyRows = [weeklyRow({ changeable: false, closesAt: FAR })];
  await load();
  assert.match(card(`external:sch-1:${TODAY}`).textContent, /RPE given/);
  assert.doesNotMatch(card(`external:sch-1:${TODAY}`).textContent, /Your RPE/);

  data.resetAthleteCalendar(); data.athleteCalendarState().weekStart = MONDAY;
  weeklyRows = [];
  await load();
  assert.match(card(`external:sch-1:${TODAY}`).textContent, /RPE given/);
  assert.equal(changeButton(`external:sch-1:${TODAY}`), null);
});

test("B2. an event card, a planned card and an unanswered request card never get Change", async () => {
  cards = [eventCard({}), plannedCard({}), externalCard({ key: "sch-2", rpe: "missing", assignmentId: OTHER })];
  // Even a weekly row naming the unanswered card's assignment does not put Change on an unanswered card.
  weeklyRows = [weeklyRow({ externalAssignmentId: OTHER })];
  server();
  await load();
  assert.equal(dom().querySelectorAll('[data-action="athlete-calendar-rpe-change"]').length, 0);
  assert.doesNotMatch(dom().body.textContent, /Your RPE/);
});

test("B3. a card whose assignment is not in her weekly rows never shows Change, and the action with that id does nothing", async () => {
  cards = [externalCard({ assignmentId: OTHER })];
  weeklyRows = [weeklyRow({ externalAssignmentId: MINE })];
  const calls = server();
  await load();
  assert.equal(changeButton(`external:sch-1:${TODAY}`), null);
  assert.match(card(`external:sch-1:${TODAY}`).textContent, /RPE given/);
  // A crafted button carrying another id: no row of her own read answers it, so nothing opens and nothing is sent.
  const handled = await handleAthleteCalendarAction(fakeAction({ action: "athlete-calendar-rpe-change", assignmentId: OTHER, date: TODAY, title: "x" }), handlers());
  assert.equal(handled, true);
  assert.equal(form(), null);
  assert.equal(opened.length, 0);
  // Her own id while her row says it may not change: nothing either.
  weeklyRows = [weeklyRow({ changeable: false })];
  data.resetAthleteCalendar(); data.athleteCalendarState().weekStart = MONDAY;
  await load();
  await handleAthleteCalendarAction(fakeAction({ action: "athlete-calendar-rpe-change", assignmentId: MINE, date: TODAY, title: "x" }), handlers());
  assert.equal(form(), null);
  assert.equal(calls.filter((c) => c.url.includes("/rpe/change")).length, 0);
});

test("B4. the card's title is escaped in the line and in Change's label", async () => {
  cards = [externalCard({ title: "<img src=x onerror=alert(1)>" })];
  weeklyRows = [weeklyRow()];
  server();
  await load();
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
  assert.equal(dom().querySelectorAll("img").length, 0);
  assert.match(changeButton(`external:sch-1:${TODAY}`).getAttribute("aria-label"), /Change your RPE, <img src=x/);
});

test("B5. Change opens the form filled in from her weekly row: 'Change your RPE · Match RPE', the day, 'Your answer: 7, sent at 12:04.'", async () => {
  cards = [externalCard({})];
  weeklyRows = [weeklyRow({ revision: 3, feedback: feedback({ note: "legs heavy" }) })];
  server();
  await load();
  await pressChange();
  assert.equal(opened.length, 1);
  assert.equal(form().mode, "change");
  assert.deepEqual([form().externalAssignmentId, form().rpe, form().durationMinutes, form().note, form().expectedRevision], [MINE, 7, 60, "legs heavy", 3]);
  const h = overlay();
  assert.match(h, /Change your RPE · Match RPE/);
  assert.match(h, new RegExp(`${data.athleteCalendarDayLabel(TODAY)} · Your answer: 7, sent at 12:04\\.`));
});

test("B6. Save change sends one request on a double tap; after 'changed' the calendar and her weekly read run again and the notice is 'Your answer was changed.'", async () => {
  cards = [externalCard({})];
  weeklyRows = [weeklyRow()];
  let release;
  const gate = new Promise((r) => { release = r; });
  changeHandler = async () => { await gate; return { status: 200, body: { outcome: "changed", feedback: { ...feedback({ rpe: 5, srpe: 300 }), revision: 1 } } }; };
  const calls = server();
  await load();
  await pressChange();
  await tl({ action: "training-load-rpe-slider-input" }, { value: "5" });
  const first = tl({ action: "training-load-rpe-submit" });
  const second = tl({ action: "training-load-rpe-submit" });
  release();
  await Promise.all([first, second]);
  assert.equal(calls.filter((c) => c.url.includes("/rpe/change")).length, 1, "a double tap sends one request");
  assert.ok(form().savedFeedback);
  // The server now holds the new answer; app.js reads the week again with the change's sentence.
  weeklyRows = [weeklyRow({ feedback: feedback({ rpe: 5, srpe: 300 }), revision: 1 })];
  const before = [calendarCalls(calls).length, weeklyCalls(calls).length];
  await athleteCalendarAnswered({ render, loadQuestions: async () => {}, notice: "Your answer was changed." });
  assert.equal(calendarCalls(calls).length, before[0] + 1);
  assert.equal(weeklyCalls(calls).length, before[1] + 1);
  assert.match(html, /Your answer was changed\./);
  assert.match(card(`external:sch-1:${TODAY}`).textContent, /Your RPE: 5/);
});

test("B7. a result not confirmed: Check result repeats the same key; a busy answer to Check stays not confirmed", async () => {
  cards = [externalCard({})];
  weeklyRows = [weeklyRow()];
  const answers = [{ throwNetworkError: true }, { status: 409, body: { error: "try_again", message: "Nothing was saved. Try again." } }];
  changeHandler = () => answers.shift();
  const calls = server();
  await load();
  await pressChange();
  await tl({ action: "training-load-rpe-slider-input" }, { value: "4" });
  await tl({ action: "training-load-rpe-submit" });
  assert.equal(form().unconfirmed, true);
  assert.match(overlay(), />Check result</);
  await tl({ action: "training-load-rpe-submit" });
  assert.equal(form().unconfirmed, true);
  assert.doesNotMatch(overlay(), /Nothing was saved/);
  const sent = calls.filter((c) => c.url.includes("/rpe/change"));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.requestKey, sent[1].body.requestKey);
});

test("B8. answer_locked: the stable sentence; after the week is read again the card shows 'Answers closed at'", async () => {
  cards = [externalCard({})];
  weeklyRows = [weeklyRow({ closesAt: new Date(Date.now() + 60_000).toISOString() })];
  changeHandler = () => ({ status: 409, body: { error: "answer_locked", message: "This answer can no longer be changed. The question is closed.", feedback: { ...feedback(), revision: 0 } } });
  server();
  await load();
  await pressChange();
  await tl({ action: "training-load-rpe-slider-input" }, { value: "3" });
  await tl({ action: "training-load-rpe-submit" });
  assert.equal(form().locked, true);
  assert.match(overlay(), /This answer can no longer be changed\. The question is closed\./);
  weeklyRows = [weeklyRow({ changeable: false, closesAt: new Date(Date.now() - 1000).toISOString() })];
  await athleteCalendarAnswered({ render, loadQuestions: async () => {}, notice: "" });
  assert.match(card(`external:sch-1:${TODAY}`).textContent, /Answers closed at/);
  assert.equal(changeButton(`external:sch-1:${TODAY}`), null);
  assert.equal(dom().querySelector(".ac-notice"), null, "no sentence on the calendar: the form said it");
});

test("B9. a slower answer for an older week is dropped (generation): the shown week keeps its own rows", async () => {
  const lastWeek = addDaysIso(MONDAY, -7);
  let releaseOld;
  const oldGate = new Promise((r) => { releaseOld = r; });
  weeklyHandler = async (call, from) => {
    if (from === lastWeek) { await oldGate; return { status: 200, body: weeklyAnswer([weeklyRow({ feedback: feedback({ rpe: 2 }) })], lastWeek) }; }
    return { status: 200, body: weeklyAnswer([weeklyRow()], from) };
  };
  server();
  const old = answersModule.loadAthleteCalendarAnswers({ weekStart: lastWeek, render });
  await answersModule.loadAthleteCalendarAnswers({ weekStart: MONDAY, render });
  releaseOld();
  await old;
  assert.equal(answersModule.athleteCalendarAnswerFor(MINE, MONDAY)?.feedback.rpe, 7);
  assert.equal(answersModule.athleteCalendarAnswerFor(MINE, lastWeek), null);
});

test("B10. a failing weekly read hides only the line: the card stays with 'RPE given'", async () => {
  cards = [externalCard({})];
  weeklyHandler = () => ({ status: 500, body: { error: "internal_error" } });
  server();
  await load();
  assert.equal(data.athleteCalendarState().status, "ready");
  assert.match(card(`external:sch-1:${TODAY}`).textContent, /RPE given/);
  assert.equal(changeButton(`external:sch-1:${TODAY}`), null);
});

test("B11. a workspace switch or a sign-out (resetAthleteCalendar) clears her rows", async () => {
  cards = [externalCard({})];
  weeklyRows = [weeklyRow()];
  server();
  await load();
  assert.ok(answersModule.athleteCalendarAnswerFor(MINE, MONDAY));
  data.resetAthleteCalendar();
  assert.equal(answersModule.athleteCalendarAnswerFor(MINE, MONDAY), null);
});

test("B13. the calendar's own read finishes even while her weekly read never answers (the scroll and Today never wait for it)", async () => {
  cards = [externalCard({})];
  weeklyHandler = () => new Promise(() => {});
  server();
  const done = data.loadAthleteCalendar({ render, weekStart: MONDAY, forceRefresh: true }).then(() => "done");
  const outcome = await Promise.race([done, new Promise((r) => setTimeout(() => r("hung"), 300))]);
  assert.equal(outcome, "done");
  render();
  assert.match(card(`external:sch-1:${TODAY}`).textContent, /RPE given/, "the card is drawn; only the line waits");
});

// K4a's own read guard (athlete-calendar-data.js, `current`: the Independent's LOW-1 on #675). Both cases are also
// dropped by view-cache.js (the context key holds the week and the workspace; a request of the same key in flight is
// joined, and an invalidated one is dropped by its revision), so `current` is a second guard: a mutation of it alone
// is equivalent. These two pin the outcome whichever guard holds it.
test("B14. the calendar read: an older week's answer that lands after the newer week's is dropped", async () => {
  const lastWeek = addDaysIso(MONDAY, -7);
  cards = [externalCard({ title: "This week" }), externalCard({ date: addDaysIso(lastWeek, 2), title: "Last week", key: "sch-old" })];
  let releaseOld;
  const oldGate = new Promise((r) => { releaseOld = r; });
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/calendar?")) {
      const from = new URL(call.url, "http://x").searchParams.get("from");
      if (from === lastWeek) await oldGate;
      return { status: 200, body: weekAnswer(cards.filter((c) => c.date >= from && c.date <= addDaysIso(from, 6)), from) };
    }
    return { status: 200, body: weeklyAnswer([], MONDAY) };
  });
  const old = data.loadAthleteCalendar({ render, weekStart: lastWeek, forceRefresh: true });
  await data.loadAthleteCalendar({ render, weekStart: MONDAY, forceRefresh: true });
  releaseOld();
  await old;
  assert.equal(data.athleteCalendarState().weekStart, MONDAY);
  assert.equal(data.athleteCalendarState().data.from, MONDAY, "the shown week keeps its own answer");
  render();
  assert.match(dom().body.textContent, /This week/);
  assert.doesNotMatch(dom().body.textContent, /Last week/);
});

test("B15. the calendar read: an answer that lands after a workspace reset is dropped", async () => {
  cards = [externalCard({})];
  let release;
  const gate = new Promise((r) => { release = r; });
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/calendar?")) {
      await gate;
      return { status: 200, body: weekAnswer(cards, MONDAY) };
    }
    return { status: 200, body: weeklyAnswer([], MONDAY) };
  });
  const pending = data.loadAthleteCalendar({ render, weekStart: MONDAY, forceRefresh: true });
  data.resetAthleteCalendar();
  release();
  await pending;
  assert.equal(data.athleteCalendarState().data, null, "nothing of the old workspace is shown");
  assert.notEqual(data.athleteCalendarState().status, "ready");
});

test("B12. a weekly read that lands after a reset is dropped", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  weeklyHandler = async (call, from) => { await gate; return { status: 200, body: weeklyAnswer([weeklyRow()], from) }; };
  server();
  const pending = answersModule.loadAthleteCalendarAnswers({ weekStart: MONDAY, render });
  data.resetAthleteCalendar();
  release();
  await pending;
  assert.equal(answersModule.athleteCalendarAnswerFor(MINE, MONDAY), null);
});

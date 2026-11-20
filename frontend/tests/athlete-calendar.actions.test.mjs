// K4a-F: the athlete's Calendar (docs/ai/central-calendar-k4a-contract.md section 2, mockup 04). Through the real card
// model and loader (athlete-calendar-data.js), the real handlers (athlete-calendar-actions.js) and the real template
// (athlete-calendar-view.js), with a fake fetch that answers her GET /api/calendar in the athlete's shapes: the event's
// reduced card with and without `sessions` (K4a-B, PR #660, backend/src/calendarQuery.js athleteEventSessions /
// publicCard), her planned card with her own row under include=athletes, her RPE request and test cards.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => true } } };

const data = await import("../athlete-calendar-data.js");
const { athleteCalendarAnswered, enterAthleteCalendar, handleAthleteCalendarAction } = await import("../athlete-calendar-actions.js");
const { renderAthleteCalendarHtml } = await import("../athlete-calendar-view.js");
const { state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
const DAY = (i) => addDaysIso(MONDAY, i);
const ATHLETE = { id: "u-athlete", activeWorkspace: { type: "athlete", scopeId: null } };

after(() => restoreFetch());

// Her event card, exactly the athlete branch's keys, plus `sessions` when one of hers folded.
function eventCard({ id = "ev-1", date = TODAY, title = "Team training", eventKind = "training", eventTypeLabel = "Training", startTime = "10:00", endTime = "11:30", place = { source: "library", name: "North field", address: "1 Field Road" }, cancelled = false, sessions = null, eventTypeColorKey = null }) {
  return {
    key: `event:${id}:${date}`, kind: "event", date, title, eventKind, eventTypeLabel, eventTypeIconKey: null, eventTypeColorKey,
    span: { from: date, to: date }, startTime, endTime, timezone: "Europe/Sarajevo", location: null, place,
    status: cancelled ? "cancelled" : "planned", cancelled, teamIds: ["team-1"], links: { eventId: id },
    ...(sessions ? { sessions } : {}),
  };
}
const session = ({ title = "Main session", bta = "T", amPm = "AM", time = "10:30", timeFromEvent = false, sessionId = "ps-1", rpe = "missing" } = {}) => ({
  title, slot: { amPm, bta, order: 1 }, time, timeFromEvent, sessionId, logicalSessionId: `ls-${sessionId}`, rpe,
});
function plannedCard({ date = TODAY, title = "Gym · upper body", sessionId = "ps-9", rpe = "not_asked", startTime = null }) {
  return {
    key: `planned:grp-${sessionId}:${date}`, kind: "planned", date, title, slot: { amPm: "AM", bta: "T", order: 1 }, startTime, startsAt: null,
    teamIds: [], athleteIds: ["a-1"], athleteCount: 1, expects: rpe === "not_asked" ? [] : ["rpe"], status: "none",
    athletes: [{ athleteId: "a-1", name: "Ana Example", teamIds: [], planId: "plan-1", sessionId, logicalSessionId: `ls-${sessionId}`, rpe }],
    links: { activityIds: [], planIds: ["plan-1"], logicalSessionIds: [`ls-${sessionId}`] },
  };
}
function externalCard({ date = TODAY, assignmentId = "asg-1", rpe = "missing", title = "Match RPE" }) {
  return {
    key: `external:sch-1:${date}`, kind: "external", date, title, eventType: "match", startTime: "00:00", teamIds: ["team-1"],
    athletes: [{ athleteId: "a-1", name: "Ana Example", teamIds: [], assignmentId, assignmentStatus: "pending", rpe }],
    links: { activityIds: [], externalScheduleId: "sch-1", externalOccurrenceId: "occ-1" }, cancelled: false,
  };
}
function weekAnswer(cards, from = MONDAY) {
  const days = Array.from({ length: 7 }, (_, i) => ({ date: addDaysIso(from, i), items: cards.filter((c) => c.date === addDaysIso(from, i)) }));
  return { from, to: addDaysIso(from, 6), today: TODAY, workspace: { type: "athlete", scopeId: null }, teams: [], days };
}
const question = ({ id = "q-1", kind = "rpe", eventId = "ev-1" } = {}) => ({
  questionId: id, kind, eventId, eventTitle: "Team training", eventDay: TODAY, eventStart: "10:00", opensAt: "2020-01-01T00:00:00Z", closesAt: "2999-01-01T00:00:00Z",
  formKind: kind, formId: `asg-${id}`, later: false,
});

let cards = [];
let questionsAnswer = [];
function server() {
  return installFetchMock((call) => {
    if (call.url.startsWith("/api/calendar/questions/mine")) return { status: 200, body: { questions: questionsAnswer } };
    if (call.url.startsWith("/api/calendar?")) {
      const from = new URL(call.url, "http://x").searchParams.get("from");
      return { status: 200, body: weekAnswer(cards.filter((c) => c.date >= from && c.date <= addDaysIso(from, 6)), from) };
    }
    return { status: 404, body: { error: "not found" } };
  });
}
const calendarCalls = (calls) => calls.filter((c) => c.url.startsWith("/api/calendar?"));

let html = "";
const render = () => { html = renderAthleteCalendarHtml(data.athleteCalendarState(), { questions: state.athleteQuestions?.rows || [], today: TODAY }); };
const dom = () => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
const loadQuestions = async () => {
  const { loadAthleteQuestions } = await import("../athlete-questions-data.js");
  return loadAthleteQuestions();
};

beforeEach(async () => {
  clearAllViewCache();
  data.resetAthleteCalendar();
  const { resetAthleteQuestions } = await import("../athlete-questions-data.js");
  resetAthleteQuestions();
  state.currentUser = ATHLETE;
  cards = [];
  questionsAnswer = [];
  html = "";
});

// --- 1. The pure parts ------------------------------------------------------

test("K1. the week and day labels: 12 – 18 Oct, across months and years; Monday 12.10", () => {
  assert.equal(data.athleteCalendarWeekLabel("2026-10-12"), "12 – 18 Oct");
  assert.equal(data.athleteCalendarWeekLabel("2026-09-28"), "28 Sep – 4 Oct");
  assert.equal(data.athleteCalendarWeekLabel("2026-12-28"), "28 Dec 2026 – 3 Jan 2027");
  assert.equal(data.athleteCalendarDayLabel("2026-10-12"), "Monday 12.10");
  assert.equal(data.athleteCalendarDayLabel("2026-10-18"), "Sunday 18.10");
  assert.deepEqual(data.athleteCalendarWeek("2026-10-15"), { from: "2026-10-12", to: "2026-10-18", days: ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"] });
  assert.equal(data.athleteCalendarUrl("2026-10-12", "2026-10-18", "2026-10-15"), "/api/calendar?from=2026-10-12&to=2026-10-18&today=2026-10-15&include=athletes");
});

test("K2. an event card without sessions: its time, type word, title and place; no buttons; byte-for-byte nothing of sessions", () => {
  const card = data.athleteCalendarCard(eventCard({}), { today: TODAY });
  assert.equal(card.kind, "event");
  assert.equal(card.when, "10:00–11:30");
  assert.equal(card.word, "Training");
  assert.equal(card.title, "Team training");
  assert.deepEqual(card.place, { source: "library", name: "North field", address: "1 Field Road", note: null });
  assert.deepEqual(card.sessions, []);
  assert.deepEqual(card.buttons, []);
  assert.equal(card.answer, null);
});

test("K3. an event card with her sessions: the short list (slot word, name, the time alone) and Rate RPE first, then Open training", () => {
  const item = eventCard({ sessions: [session({ title: "Mobility & activation", bta: "B", time: "10:00", timeFromEvent: true, sessionId: "ps-0", rpe: "not_asked" }), session({ sessionId: "ps-1" })] });
  const card = data.athleteCalendarCard(item, { today: TODAY });
  assert.deepEqual(card.sessions.map((s) => [s.slot, s.title, s.time]), [["Before", "Mobility & activation", "10:00"], ["Training", "Main session", "10:30"]]);
  assert.deepEqual(card.buttons.map((b) => [b.label, b.primary, b.action, b.sessionId]), [["Rate RPE", true, "rate-session", "ps-1"], ["Open training", false, "open-training", "ps-0"]]);
  render0([item]);
  const text = dom().querySelector(".ac-sessions").textContent;
  assert.doesNotMatch(text, /from the event/i, "the time alone, never \"from the event\"");
});

test("K4. one primary per card (contract Q3): a future day's missing RPE is not offered; an open RPE question of the event is", () => {
  const future = eventCard({ date: addDaysIso(TODAY, 1), sessions: [session({ rpe: "missing" })] });
  assert.deepEqual(data.athleteCalendarCard(future, { today: TODAY }).buttons.map((b) => [b.label, b.primary]), [["Open training", true]]);
  const asked = eventCard({ date: addDaysIso(TODAY, 1), sessions: [session({ rpe: "not_asked" })] });
  const withQuestion = data.athleteCalendarCard(asked, { today: TODAY, questions: [question({ eventId: "ev-1" })] });
  assert.deepEqual(withQuestion.buttons.map((b) => [b.label, b.primary, b.action, b.questionId]), [["Rate RPE", true, "rate-question", "q-1"], ["Open training", false, "open-training", undefined]]);
  // Another event's question is not this card's.
  assert.deepEqual(data.athleteCalendarCard(asked, { today: TODAY, questions: [question({ eventId: "ev-2" })] }).buttons.map((b) => b.label), ["Open training"]);
  // A wellness question: Wellness; with no session it is the primary.
  const bare = data.athleteCalendarCard(eventCard({}), { today: TODAY, questions: [question({ id: "q-w", kind: "wellness" })] });
  assert.deepEqual(bare.buttons.map((b) => [b.label, b.primary]), [["Wellness", true]]);
  for (const c of [future, asked].map((item) => data.athleteCalendarCard(item, { today: TODAY }))) assert.equal(c.buttons.filter((b) => b.primary).length, 1);
});

test("K4b. an event whose session she has rated: RPE given (no value), Open training the primary; while another session still waits, Rate RPE instead", () => {
  const done = data.athleteCalendarCard(eventCard({ sessions: [session({ rpe: "submitted" })] }), { today: TODAY });
  assert.equal(done.answer, "rpe-given");
  assert.deepEqual(done.buttons.map((b) => [b.label, b.primary]), [["Open training", true]]);
  const mixed = data.athleteCalendarCard(eventCard({ sessions: [session({ sessionId: "ps-a", rpe: "submitted" }), session({ sessionId: "ps-b", rpe: "missing" })] }), { today: TODAY });
  assert.equal(mixed.answer, null);
  assert.deepEqual(mixed.buttons.map((b) => [b.label, b.sessionId]), [["Rate RPE", "ps-b"], ["Open training", "ps-a"]]);
});

test("K5. her planned card (no event): My training, the slot, Open training (Rate RPE first when missing today); RPE given once answered, no value", () => {
  const plain = data.athleteCalendarCard(plannedCard({}), { today: TODAY });
  assert.deepEqual([plain.kind, plain.word, plain.when, plain.title], ["planned", "My training", "AM", "Gym · upper body"]);
  assert.deepEqual(plain.buttons.map((b) => [b.label, b.primary, b.sessionId]), [["Open training", true, "ps-9"]]);
  const missing = data.athleteCalendarCard(plannedCard({ rpe: "missing" }), { today: TODAY });
  assert.deepEqual(missing.buttons.map((b) => [b.label, b.primary]), [["Rate RPE", true], ["Open training", false]]);
  const given = data.athleteCalendarCard(plannedCard({ rpe: "submitted" }), { today: TODAY });
  assert.equal(given.answer, "rpe-given");
  render0([plannedCard({ rpe: "submitted" })]);
  const answer = dom().querySelector("[data-ac-answer]");
  assert.equal(answer.hidden, false);
  assert.equal(answer.textContent.replace(/\s+/g, " ").trim(), "✓ RPE given");
  assert.doesNotMatch(dom().body.textContent, /\b\d+\s*\/\s*10\b|Your RPE/, "no value until K4b");
});

test("K6. cancelled: the ✕ Cancelled badge, no place, no sessions, no buttons; K4b's empty answer row is always there", () => {
  const item = eventCard({ cancelled: true, sessions: [session({})] });
  const card = data.athleteCalendarCard(item, { today: TODAY, questions: [question({})] });
  assert.deepEqual([card.place, card.sessions, card.buttons, card.answer], [null, [], [], null]);
  render0([item]);
  const article = dom().querySelector(".ac-card");
  assert.ok(article.classList.contains("is-cancelled"));
  assert.match(article.querySelector(".cc-badge-cancelled").textContent, /Cancelled/);
  assert.equal(article.querySelector(".cc-panel-place"), null);
  assert.equal(article.querySelector("[data-ac-answer]").hidden, true);
});

test("K7. an RPE request and a test of hers: their own button; an unknown kind is left out", () => {
  const ext = data.athleteCalendarCard(externalCard({}), { today: TODAY });
  assert.deepEqual([ext.word, ext.buttons.map((b) => [b.label, b.action, b.assignmentId])], ["RPE request", [["Rate RPE", "rate-assignment", "asg-1"]]]);
  assert.equal(data.athleteCalendarCard(externalCard({ rpe: "submitted" }), { today: TODAY }).answer, "rpe-given");
  const test = data.athleteCalendarCard({ key: `test:t1:${TODAY}`, kind: "test", date: TODAY, title: "CMJ", startTime: "09:00", athletes: [{ athleteId: "a-1", assignmentId: "tasg-1" }] }, { today: TODAY });
  assert.deepEqual(test.buttons.map((b) => [b.label, b.action]), [["Open test", "open-test"]]);
  assert.equal(data.athleteCalendarCard({ key: "x:1", kind: "something", date: TODAY }, { today: TODAY }), null);
});

test("K8. the week by days: a day with nothing is left out; the server's order inside a day; today marked", () => {
  const answer = weekAnswer([eventCard({ id: "ev-a", date: DAY(1) }), plannedCard({ date: DAY(1) }), eventCard({ id: "ev-b", date: DAY(4), title: "Match day", eventKind: "match", eventTypeLabel: "Match" })]);
  const days = data.athleteCalendarDays(answer, { from: MONDAY, today: DAY(1) });
  assert.deepEqual(days.map((d) => [d.date, d.today, d.cards.map((c) => c.key)]), [
    [DAY(1), true, [`event:ev-a:${DAY(1)}`, `planned:grp-ps-9:${DAY(1)}`]],
    [DAY(4), false, [`event:ev-b:${DAY(4)}`]],
  ]);
});

function render0(items) {
  const slice = data.athleteCalendarState();
  slice.weekStart = MONDAY;
  slice.status = "ready";
  slice.data = weekAnswer(items);
  render();
}

// --- 2. The screen and its actions ------------------------------------------

test("K9. entry: one read of her week with include=athletes and no kinds, plus her questions; Rate RPE on the event of an open question", async () => {
  cards = [eventCard({ sessions: [session({ rpe: "not_asked" })] })];
  questionsAnswer = [{ questionId: "q-1", kind: "rpe", eventId: "ev-1", eventTitle: "Team training", eventDay: TODAY, eventStart: "10:00", window: { opensAt: "2020-01-01T00:00:00Z", closesAt: "2999-01-01T00:00:00Z" }, form: { kind: "rpe", externalAssignmentId: "asg-q" }, later: false }];
  const calls = server();
  await enterAthleteCalendar({ render, loadQuestions });
  const reads = calendarCalls(calls);
  assert.equal(reads.length, 1);
  const query = new URL(reads[0].url, "http://x").searchParams;
  assert.deepEqual([query.get("from"), query.get("to"), query.get("include"), query.get("kinds")], [MONDAY, DAY(6), "athletes", null]);
  assert.equal(calls.filter((c) => c.url.startsWith("/api/calendar/questions/mine")).length, 1);
  const buttons = [...dom().querySelectorAll('.ac-card [data-action="athlete-calendar-card"]')];
  assert.deepEqual(buttons.map((b) => [b.textContent, b.classList.contains("cc-primary"), b.dataset.acAction]), [["Rate RPE", true, "rate-question"], ["Open training", false, "open-training"]]);
  assert.equal(dom().querySelector(".ac-period").textContent, data.athleteCalendarWeekLabel(MONDAY));
  assert.match(dom().querySelector(".ac-day-label").textContent, /· today$/);
});

test("K10. the arrows read the next week; Today comes back; an empty week says Nothing planned this week. with Today", async () => {
  cards = [eventCard({})];
  const calls = server();
  await enterAthleteCalendar({ render, loadQuestions });
  await handleAthleteCalendarAction(fakeAction({ action: "athlete-calendar-week", delta: "1" }), { render });
  assert.equal(new URL(calendarCalls(calls).at(-1).url, "http://x").searchParams.get("from"), DAY(7));
  assert.equal(dom().querySelector(".ac-empty p").textContent, "Nothing planned this week.");
  assert.ok(dom().querySelector('.ac-empty [data-action="athlete-calendar-today"]'));
  await handleAthleteCalendarAction(fakeAction({ action: "athlete-calendar-today" }), { render });
  assert.equal(data.athleteCalendarState().weekStart, MONDAY);
  assert.ok(dom().querySelector(".ac-card"));
  // This week's empty state has no Today button.
  cards = [];
  clearAllViewCache();
  await enterAthleteCalendar({ render, loadQuestions });
  assert.equal(dom().querySelector('.ac-empty [data-action="athlete-calendar-today"]'), null);
});

test("K11. a slower answer of the earlier week never paints over the week she moved to", async () => {
  cards = [eventCard({ title: "This week" }), eventCard({ id: "ev-n", date: DAY(8), title: "Next week" })];
  const held = [];
  installFetchMock((call) => {
    if (call.url.startsWith("/api/calendar/questions/mine")) return { status: 200, body: { questions: [] } };
    const from = new URL(call.url, "http://x").searchParams.get("from");
    const body = weekAnswer(cards.filter((c) => c.date >= from && c.date <= addDaysIso(from, 6)), from);
    if (from === MONDAY) return new Promise((resolve) => held.push(() => resolve({ status: 200, body })));
    return { status: 200, body };
  });
  const first = enterAthleteCalendar({ render, loadQuestions });
  await new Promise((r) => setTimeout(r, 0));
  await handleAthleteCalendarAction(fakeAction({ action: "athlete-calendar-week", delta: "1" }), { render });
  held.forEach((release) => release());
  await first;
  assert.equal(data.athleteCalendarState().weekStart, DAY(7));
  assert.match(dom().querySelector(".ac-card-title").textContent, /Next week/);
});

test("K12. a failed read: The calendar could not be read. with Try again, which reads again", async () => {
  let fail = true;
  const calls = installFetchMock((call) => {
    if (call.url.startsWith("/api/calendar/questions/mine")) return { status: 200, body: { questions: [] } };
    if (fail) return { status: 500, body: { error: "internal_error" } };
    return { status: 200, body: weekAnswer([eventCard({})]) };
  });
  await enterAthleteCalendar({ render, loadQuestions });
  assert.equal(dom().querySelector('.ac-state[role="alert"] p').textContent, "The calendar could not be read.");
  fail = false;
  await handleAthleteCalendarAction(fakeAction({ action: "athlete-calendar-retry" }), { render, loadQuestions });
  assert.equal(calendarCalls(calls).length, 2);
  assert.ok(dom().querySelector(".ac-card"));
});

test("K13. the buttons call their handler with the ids the card carries; nothing else", async () => {
  const seen = [];
  const handlers = {
    render,
    rateQuestion: async (q) => seen.push(["rateQuestion", q]),
    rateSession: async (s, d) => seen.push(["rateSession", s, d]),
    rateAssignment: async (a, d) => seen.push(["rateAssignment", a, d]),
    openTest: async (a) => seen.push(["openTest", a]),
    openTraining: async (t) => seen.push(["openTraining", t.sessionId, t.date]),
  };
  for (const [acAction, extra] of [["rate-question", { questionId: "q-1" }], ["rate-session", { sessionId: "ps-1" }], ["rate-assignment", { assignmentId: "asg-1" }], ["open-test", { assignmentId: "tasg-1" }], ["open-training", { sessionId: "ps-2" }]]) {
    assert.equal(await handleAthleteCalendarAction(fakeAction({ action: "athlete-calendar-card", acAction, date: TODAY, ...extra }), handlers), true);
  }
  assert.deepEqual(seen, [["rateQuestion", "q-1"], ["rateSession", "ps-1", TODAY], ["rateAssignment", "asg-1", TODAY], ["openTest", "tasg-1"], ["openTraining", "ps-2", TODAY]]);
  assert.equal(await handleAthleteCalendarAction(fakeAction({ action: "something-else" }), handlers), false);
});

test("K14. after a confirmed answer: Your answer was saved. and the week is read again", async () => {
  cards = [plannedCard({ rpe: "missing" })];
  const calls = server();
  await enterAthleteCalendar({ render, loadQuestions });
  assert.ok([...dom().querySelectorAll(".ac-button")].some((b) => b.textContent === "Rate RPE"));
  cards = [plannedCard({ rpe: "submitted" })];
  await athleteCalendarAnswered({ render, loadQuestions });
  assert.equal(calendarCalls(calls).length, 2);
  const notice = dom().querySelector(".ac-notice");
  assert.equal(notice.textContent.replace(/\s+/g, " ").trim(), "✓ Your answer was saved.", "a glyph and the words");
  assert.ok(notice.classList.contains("is-saved"), "and the success colour");
  assert.ok(![...dom().querySelectorAll(".ac-button")].some((b) => b.textContent === "Rate RPE"));
  assert.match(dom().querySelector("[data-ac-answer]").textContent, /RPE given/);
});

test("K15. the phone's strip: seven days, today aria-current, a dot only on a day with something, the pressed day follows a tap", async () => {
  cards = [eventCard({ date: DAY(2) })];
  server();
  await enterAthleteCalendar({ render, loadQuestions });
  const strip = [...dom().querySelectorAll(".ac-strip-day")];
  assert.equal(strip.length, 7);
  assert.equal(strip.filter((b) => b.getAttribute("aria-current") === "date").map((b) => b.dataset.date).join(), TODAY);
  assert.deepEqual(strip.filter((b) => b.querySelector(".ac-strip-dot.is-busy")).map((b) => b.dataset.date), [DAY(2)]);
  await handleAthleteCalendarAction(fakeAction({ action: "athlete-calendar-day", date: DAY(2) }), { render });
  assert.deepEqual([...dom().querySelectorAll('.ac-strip-day[aria-pressed="true"]')].map((b) => b.dataset.date), [DAY(2)]);
});

test("K16. nothing of the answer beyond the card model reaches the page: no id, no teammate, no count", async () => {
  const item = eventCard({ sessions: [session({})] });
  item.secretField = "hidden-thing-42";
  cards = [item, plannedCard({ date: DAY(3) })];
  server();
  await enterAthleteCalendar({ render, loadQuestions });
  const text = dom().body.textContent;
  for (const word of ["hidden-thing-42", "ls-ps-1", "plan-1", "Ana Example", "Europe/Sarajevo", "team-1"]) assert.ok(!text.includes(word), word);
});

test("K12b. the arrow to a week whose read fails: The calendar could not be read. with Try again - never the last week as that week, never an endless Loading", async () => {
  cards = [eventCard({})];
  installFetchMock((call) => {
    if (call.url.startsWith("/api/calendar/questions/mine")) return { status: 200, body: { questions: [] } };
    const from = new URL(call.url, "http://x").searchParams.get("from");
    if (from === DAY(7)) return { status: 500, body: { error: "internal_error" } };
    return { status: 200, body: weekAnswer(cards.filter((c) => c.date >= from && c.date <= addDaysIso(from, 6)), from) };
  });
  await enterAthleteCalendar({ render, loadQuestions });
  await handleAthleteCalendarAction(fakeAction({ action: "athlete-calendar-week", delta: "1" }), { render });
  assert.equal(dom().querySelector('.ac-state[role="alert"] p').textContent, "The calendar could not be read.");
  assert.ok(dom().querySelector('[data-action="athlete-calendar-retry"]'));
  assert.doesNotMatch(dom().body.textContent, /Loading calendar|Showing the last loaded calendar/);
  assert.equal(dom().querySelector(".ac-card"), null, "the earlier week's cards are not shown as this week's");
});

test("K17. Rate RPE on a past week opens the Training Load form for that session: the weekly read is of that day's week", async () => {
  const { openRpeFormOnDate } = await import("../training-load-actions.js");
  const lastWeek = addDaysIso(MONDAY, -7);
  const day = addDaysIso(lastWeek, 2);
  state.trainingLoad.rpeForm = null;
  state.trainingLoad.athleteWeekly = { weekStart: "", selectedDate: "", data: null, loading: false, error: "" };
  const weeklyReads = [];
  installFetchMock((call) => {
    if (call.url.startsWith("/api/training-load/athlete/today")) return { status: 200, body: { date: TODAY, sessions: [] } };
    if (call.url.startsWith("/api/training-load/weekly")) {
      const weekStart = new URL(call.url, "http://x").searchParams.get("weekStart");
      weeklyReads.push(weekStart);
      const sessions = weekStart === lastWeek ? [{ sessionId: "ps-old", sessionName: "Recovery run", amPm: "AM", bta: "T", sessionTime: null, rated: false, source: "planned" }] : [];
      return { status: 200, body: { weekStart, weekEnd: addDaysIso(weekStart, 6), days: Array.from({ length: 7 }, (_, i) => ({ date: addDaysIso(weekStart, i), sessions: addDaysIso(weekStart, i) === day ? sessions : [] })) } };
    }
    return { status: 404, body: { error: "not found" } };
  });
  assert.equal(await openRpeFormOnDate("ps-old", day), true);
  assert.deepEqual(weeklyReads, [lastWeek], "her session's own week, not this week");
  assert.equal(state.trainingLoad.rpeForm?.sessionId, "ps-old");
  assert.equal(state.trainingLoad.rpeForm?.date, day);
  assert.equal(state.trainingLoad.athleteWeekly.weekStart, "", "the weekly overlay keeps its own week");
  // A form left open from elsewhere (saved on Home) is not the one asked for: false, never "opened".
  state.trainingLoad.rpeForm = { sessionId: "other", savedFeedback: {} };
  assert.equal(await openRpeFormOnDate("ps-gone", day), false);
  state.trainingLoad.rpeForm = null;
});

test("K18. Rate RPE on a question that has just closed: the question's own sentence shows on the Calendar", async () => {
  cards = [eventCard({})];
  server();
  await enterAthleteCalendar({ render, loadQuestions });
  const handlers = {
    render,
    rateQuestion: async () => {
      state.athleteQuestions.notice = "This question has closed.";
      return false;
    },
  };
  await handleAthleteCalendarAction(fakeAction({ action: "athlete-calendar-card", acAction: "rate-question", questionId: "q-1", date: TODAY }), handlers);
  assert.equal(dom().querySelector(".ac-notice").textContent.trim(), "This question has closed.");
  state.athleteQuestions.notice = "";
});

test("K19. a history step holds the Calendar's place (week, day, scroll); Back restores it, and the week is drawn before the scroll", async () => {
  const history = await import("../app-history.js");
  cards = [eventCard({})];
  server();
  await enterAthleteCalendar({ render, loadQuestions });
  data.athleteCalendarState().selectedDate = DAY(3);
  const place = data.athleteCalendarPlace(420);
  assert.deepEqual(place, { weekStart: MONDAY, selectedDate: DAY(3), scrollY: 420 });
  // The entry carries it only for the Calendar's own tab.
  assert.deepEqual(history.appHistoryEntryOf({ activeTab: "athlete-calendar" }, { athleteCalendar: place }).athleteCalendar, place);
  assert.equal(history.appHistoryEntryOf({ activeTab: "weekly" }, { athleteCalendar: place }).athleteCalendar, null);
  // She moves to another week, then Back brings the remembered one back with its day and scroll.
  await handleAthleteCalendarAction(fakeAction({ action: "athlete-calendar-week", delta: "1" }), { render });
  data.restoreAthleteCalendarPlace(place);
  const scrolls = [];
  const savedRaf = globalThis.requestAnimationFrame;
  const savedScroll = globalThis.scrollTo;
  globalThis.requestAnimationFrame = (fn) => fn();
  globalThis.scrollTo = (x, y) => scrolls.push(y);
  try {
    await enterAthleteCalendar({ render, loadQuestions });
  } finally {
    globalThis.requestAnimationFrame = savedRaf;
    globalThis.scrollTo = savedScroll;
  }
  assert.equal(data.athleteCalendarState().weekStart, MONDAY);
  assert.equal(data.athleteCalendarState().selectedDate, DAY(3));
  assert.deepEqual(scrolls, [420], "the scroll it had, once");
  assert.equal(data.athleteCalendarState().pendingScrollY, null);
  // A broken place restores nothing.
  data.restoreAthleteCalendarPlace({ weekStart: "nonsense" });
  assert.equal(data.athleteCalendarState().weekStart, MONDAY);
});

test("K20. Back to calendar shows only on the step Open training pushed - its own entry, never another step at the same depth; a reset drops it", async () => {
  const history = await import("../app-history.js");
  data.setAthleteCalendarReturn({ date: DAY(1), title: "Team training" });
  assert.equal(data.athleteCalendarReturnFor(null), null, "nothing claimed yet");
  const step = { tab: "athlete-calendar", calendar: null, athleteCalendar: null };
  data.claimAthleteCalendarReturn(step);
  history.pushAppHistoryEntry(step);
  const marker = data.athleteCalendarReturnFor(history.appHistoryTopEntry());
  assert.deepEqual(marker, { date: DAY(1), title: "Team training", label: data.athleteCalendarDayLabel(DAY(1)) });
  // Back pops the step; the rail then pushes another entry at the same depth: no Back to calendar on it.
  history.popAppHistoryEntry();
  const rail = { tab: "athlete-calendar", calendar: null, athleteCalendar: null };
  data.claimAthleteCalendarReturn(rail);
  history.pushAppHistoryEntry(rail);
  assert.equal(data.athleteCalendarReturnFor(history.appHistoryTopEntry()), null);
  const { renderAthleteCalendarBackBarHtml } = await import("../athlete-calendar-view.js");
  const bar = new JSDOM(`<!doctype html><body>${renderAthleteCalendarBackBarHtml(marker)}</body>`).window.document;
  assert.match(bar.querySelector('[data-action="athlete-calendar-back"]').textContent, /Back to calendar/);
  assert.equal(bar.querySelector(".ac-backbar-where").textContent, `${data.athleteCalendarDayLabel(DAY(1))} · Team training`);
  assert.equal(renderAthleteCalendarBackBarHtml(null), "");
  // Over another week of the Weekly plan the button stays, the day and title (now stale) do not.
  const other = new JSDOM(`<!doctype html><body>${renderAthleteCalendarBackBarHtml(marker, DAY(7))}</body>`).window.document;
  assert.ok(other.querySelector('[data-action="athlete-calendar-back"]'));
  assert.equal(other.querySelector(".ac-backbar-where"), null);
  assert.ok(new JSDOM(`<!doctype html><body>${renderAthleteCalendarBackBarHtml(marker, MONDAY)}</body>`).window.document.querySelector(".ac-backbar-where"));
  data.setAthleteCalendarReturn({ date: DAY(1), title: "x" });
  data.claimAthleteCalendarReturn(step);
  data.resetAthleteCalendar();
  assert.equal(data.athleteCalendarReturnFor(step), null);
  history.clearAppHistoryEntries();
});

test("K21. Open training hands its handler the session, the day and the card's title; Back to calendar calls back", async () => {
  cards = [plannedCard({})];
  server();
  await enterAthleteCalendar({ render, loadQuestions });
  const button = dom().querySelector('[data-ac-action="open-training"]');
  assert.equal(button.dataset.title, "Gym · upper body");
  const seen = [];
  const handlers = { render, openTraining: async (t) => seen.push(["openTraining", t]), back: async () => seen.push(["back"]) };
  await handleAthleteCalendarAction(fakeAction({ ...button.dataset }), handlers);
  await handleAthleteCalendarAction(fakeAction({ action: "athlete-calendar-back" }), handlers);
  assert.deepEqual(seen, [["openTraining", { sessionId: "ps-9", date: TODAY, title: "Gym · upper body" }], ["back"]]);
});

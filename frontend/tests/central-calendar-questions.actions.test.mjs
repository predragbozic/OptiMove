// Central calendar K2b-2a-2b: "Ask athletes" in the event form and the event
// panel (docs/ai/central-calendar-k2b2a2-ui-contract.md sections 3 to 5 and
// 10) - through the real handlers, loaders and templates with a fake fetch
// and JSDOM. The fake keeps the server's contracts: GET /events/types with
// `questions: { enabled }` and a type's `defaultQuestions` only while the
// switch is on; GET /events/:id/questions for a manager while it is on, else
// the identical 404; create and PATCH take `questions: [{ kind, window }]`;
// the question commands take a requestKey and expectedRevision.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
const nativeConfirms = [];
globalThis.window = { confirm: (question) => { nativeConfirms.push(question); return true; } };

const { state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const {
  centralCalendarCanCreateEvents,
  centralCalendarEventRoster,
  centralCalendarRosterIndex,
  centralCalendarUncertainWrites,
  clearCentralCalendarUncertainWrites,
  handleCentralCalendarAction,
  handleCentralCalendarInput,
  submitCentralCalendarEventForm,
} = await import("../central-calendar-actions.js");
const { loadCentralCalendar, resetCentralCalendarForWorkspaceChange } = await import("../central-calendar-data.js");
const view = await import("../central-calendar-view.js");
const { ccQuestionWindowRange } = await import("../central-calendar-questions.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
const DAY = (offset) => addDaysIso(MONDAY, offset);
const CLUB = "c1c1c1c1-0000-4000-8000-000000000001";
const U17 = "22222222-2222-4222-8222-222222222222";
const TEAMS = [{ teamId: U17, name: "U17", athleteCount: 18 }];
const E_MATCH = "e0000000-0000-4000-8000-000000000001";
const E_NEW = "e0000000-0000-4000-8000-0000000000aa";
const T_TRAINING = "70000000-0000-4000-8000-000000000001";
const T_MATCH = "70000000-0000-4000-8000-000000000002";
const T_MEETING = "70000000-0000-4000-8000-000000000003";
const Q_RPE = "90000000-0000-4000-8000-000000000001";
const Q_WELL = "90000000-0000-4000-8000-000000000002";

const TYPES_ON = [
  { id: T_TRAINING, kind: "training", key: "training", label: "Training", defaultExpects: [], defaultFieldIds: [], defaultQuestions: ["rpe"], iconKey: null, colorKey: null, sortOrder: 10, ownerScope: "club" },
  { id: T_MATCH, kind: "match", key: "match", label: "Match", defaultExpects: [], defaultFieldIds: [], defaultQuestions: ["rpe", "wellness"], iconKey: null, colorKey: null, sortOrder: 20, ownerScope: "club" },
  { id: T_MEETING, kind: "meeting", key: "meeting", label: "Meeting", defaultExpects: [], defaultFieldIds: [], defaultQuestions: [], iconKey: null, colorKey: null, sortOrder: 40, ownerScope: "club" },
];
// The switch off: no `defaultQuestions` at all (B1).
const TYPES_OFF = TYPES_ON.map(({ defaultQuestions, ...type }) => type);
const catalogOf = (enabled) => ({ types: enabled ? TYPES_ON : TYPES_OFF, fields: [], locations: [], teamDefaults: {}, questions: { enabled } });

function eventItem(id, date, overrides = {}) {
  return {
    key: `event:${id}:${date}`, kind: "event", date, eventId: id, eventKind: "match", eventTypeLabel: "Match", eventTypeId: T_MATCH,
    eventTypeIconKey: null, eventTypeColorKey: null,
    title: "Cup match", slot: null, startTime: "15:00", endTime: "17:00", startsAt: null, location: null, place: null,
    teamIds: [U17], athleteIds: [], athleteCount: 18, expects: [], status: "planned", rpe: null, attendance: null, results: null,
    cancelled: false, projected: false, span: { from: date, to: date }, gaps: [], scheduleFold: { external: null, test: null }, revision: 2,
    canManage: true, notes: null, details: null,
    links: { eventId: id, planIds: [], logicalSessionIds: [], activityIds: [], externalScheduleId: null, testScheduleId: null },
    ...overrides,
  };
}
function eventView(overrides = {}) {
  return {
    id: E_MATCH, ownerScope: "club", ownerClubId: CLUB, ownerTeamId: null, ownerUserId: null,
    eventTypeId: T_MATCH, eventKind: "match", eventTypeLabel: "Match", title: "Cup match", day: DAY(1), endDay: null,
    startTime: "15:00", endTime: "17:00", timezone: "Europe/Belgrade", location: null, locationId: null, place: null, fields: [],
    status: "planned", cancelledAt: null, cancelReason: null, expects: [], externalScheduleId: null, testScheduleId: null, revision: 2,
    targets: [{ kind: "team", id: U17, name: "U17" }], links: { planIds: [], activityIds: [] }, sessionLinks: [], canManage: true, notes: null,
    ...overrides,
  };
}
const athlete = (n) => ({ athleteId: `a0000000-0000-4000-8000-00000000000${n}`, name: `Athlete ${n}` });
function liveQuestion(id, kind, window, { answered = 0, later = 0, asked = 18 } = {}) {
  const people = Array.from({ length: answered + later }, (_, i) => athlete(i + 1));
  return {
    id, kind, window, status: "live",
    counts: { asked, answered, later, notAnswered: asked - answered - later },
    answered: people.slice(0, answered), later: people.slice(answered), notAnswered: [],
  };
}
const AFTER = (date = DAY(1)) => ({ kind: "after_event", date, from: "17:00", to: "23:59" });

const NOT_FOUND = { status: 404, body: { error: "notFound", message: "Not found." } };

function rangeAnswer(url, items) {
  const params = new URL(url, "http://localhost").searchParams;
  const from = params.get("from");
  const to = params.get("to");
  const days = [];
  for (let cursor = from; cursor <= to; cursor = addDaysIso(cursor, 1)) days.push({ date: cursor, items: items.filter((item) => item.date === cursor).map((item) => ({ ...item })) });
  return { from, to, today: params.get("today"), workspace: { type: "club", scopeId: CLUB }, teams: TEAMS, days };
}

// The fake server. `questions` answers GET .../questions (a function or the
// list); `write` decides create / PATCH per call (default: accepted).
function server({ enabled = true, event = eventView(), questions = [], write = null, items = [eventItem(E_MATCH, DAY(1))] } = {}) {
  const live = items.map((item) => ({ ...item }));
  const responder = (call) => {
    const path = call.url.split("?")[0];
    if (path === "/api/calendar" && call.method === "GET") return { status: 200, body: rangeAnswer(call.url, live) };
    if (path === "/api/calendar/events/types" && call.method === "GET") return { status: 200, body: catalogOf(enabled) };
    if (path === `/api/calendar/events/${event.id}/questions` && call.method === "GET") {
      if (!enabled) return NOT_FOUND;
      return typeof questions === "function" ? questions(call) : { status: 200, body: { questions } };
    }
    if (path === `/api/calendar/events/${event.id}` && call.method === "GET") return { status: 200, body: { event } };
    if (call.method !== "GET" && write) {
      const answer = write(call);
      if (answer) return answer;
    }
    if (path === "/api/calendar/events" && call.method === "POST") {
      live.push(eventItem(E_NEW, call.body.day, { title: call.body.title }));
      return { status: 201, body: { event: eventView({ id: E_NEW, title: call.body.title, day: call.body.day, revision: 1 }), questionsAsked: (call.body.questions || []).map((q) => q.kind) } };
    }
    if (call.method === "PATCH") return { status: 200, body: { event: { ...event, revision: event.revision + 1 } } };
    return { status: 404, body: { error: "unexpected", message: call.url } };
  };
  return responder;
}

let rendered = "";
function render() {
  rendered = view.renderCentralCalendarHtml(state.centralCalendar, {
    today: TODAY, layout: "wide", roster: centralCalendarRosterIndex(), canCreate: centralCalendarCanCreateEvents(), eventRoster: centralCalendarEventRoster(),
    uncertainWrites: centralCalendarUncertainWrites(),
  });
}
const dom = (html = rendered) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
const act = (dataset) => handleCentralCalendarAction(fakeAction(dataset), { render });
function input(dataset, { value = "", checked = false, type = "" } = {}) {
  return handleCentralCalendarInput({ dataset, value, checked, type, closest: (selector) => (selector === "[data-cc-event-form]" ? {} : null) }, { render });
}
const writesOf = (calls) => calls.filter((call) => call.url.startsWith("/api/calendar/events") && call.method !== "GET");
const questionReads = (calls) => calls.filter((call) => call.method === "GET" && /\/questions$/.test(call.url.split("?")[0]));
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  clearCentralCalendarUncertainWrites();
  state.deliberateNavigation = false;
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: CLUB, label: "First Club" } };
  state.activeTab = "central-calendar";
  state.athletes = [];
  rendered = "";
  nativeConfirms.length = 0;
});

async function openCalendar(options) {
  const calls = installFetchMock(server(options));
  await loadCentralCalendar({ render });
  await tick();
  return calls;
}
async function openCreate(options = {}) {
  const calls = await openCalendar(options);
  await act({ action: "central-calendar-new-event" });
  input({ ccEventField: "title" }, { value: "Session" });
  input({ ccEventField: "day" }, { value: DAY(1) });
  input({ ccEventTarget: "team", targetId: U17, targetName: "U17" }, { checked: true });
  return calls;
}
async function openEdit(options = {}) {
  const calls = await openCalendar(options);
  await act({ action: "central-calendar-edit-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  return calls;
}
async function lastBody(calls) {
  await submitCentralCalendarEventForm({ render });
  const write = writesOf(calls).at(-1);
  if (!write) return null;
  const { requestKey, ...body } = write.body;
  return { write, requestKey, body };
}
const box = (kind) => dom().querySelector(`[data-cc-question-on="${kind}"]`);

// --- The window rule (mirrors the server's computeWindow) ---------------------

test("Q0. the window rule: after the event from its end, else the later of 18:00 and its start; next morning; custom within one day", () => {
  const ev = { day: "2026-11-21", endDay: "", startTime: "15:00", endTime: "17:00" };
  assert.deepEqual(ccQuestionWindowRange(ev, { kind: "after_event" }), { date: "2026-11-21", from: "17:00", to: "23:59" });
  assert.deepEqual(ccQuestionWindowRange({ ...ev, endTime: "" }, { kind: "after_event" }), { date: "2026-11-21", from: "18:00", to: "23:59" });
  assert.deepEqual(ccQuestionWindowRange({ ...ev, startTime: "19:30", endTime: "" }, { kind: "after_event" }), { date: "2026-11-21", from: "19:30", to: "23:59" });
  assert.equal(ccQuestionWindowRange({ ...ev, endTime: "23:59" }, { kind: "after_event" }).error, "invalid_window");
  assert.deepEqual(ccQuestionWindowRange({ ...ev, endDay: "2026-11-22" }, { kind: "next_morning" }), { date: "2026-11-23", from: "07:00", to: "12:00" });
  assert.equal(ccQuestionWindowRange(ev, { kind: "custom", date: "2026-11-22", from: "09:00", to: "09:00" }).error, "window_one_day");
  assert.equal(ccQuestionWindowRange(ev, { kind: "custom", date: "2026-11-23", from: "09:00", to: "10:00" }).error, "invalid_window", "past the day after");
  assert.equal(ccQuestionWindowRange(ev, { kind: "custom", date: "2026-11-20", from: "09:00", to: "10:00" }).error, "invalid_window", "before the event");
});

// --- The event form ---------------------------------------------------------------

test("Q1. the switch off: no Ask athletes section, no questions read, nothing about questions sent", async () => {
  const calls = await openCreate({ enabled: false });
  assert.equal(dom().querySelector(".cc-questions"), null);
  const { body } = await lastBody(calls);
  assert.equal("questions" in body, false);
  assert.equal(questionReads(calls).length, 0);
});

test("Q2. a new event: the type's questions ticked with After the event; untouched, no questions are sent (the server asks the type's defaults)", async () => {
  const calls = await openCreate();
  const doc = dom();
  assert.equal(doc.querySelector(".cc-questions legend").textContent, "Ask athletes");
  assert.equal(box("rpe").checked, true, "Training asks RPE");
  assert.equal(box("wellness").checked, false);
  const choices = [...doc.querySelectorAll('[data-cc-question-window="rpe"]')];
  assert.deepEqual(choices.map((c) => c.value), ["after_event", "next_morning", "custom"]);
  assert.equal(choices.find((c) => c.checked).value, "after_event");
  input({ ccEventField: "eventTypeId" }, { value: T_MATCH });
  assert.equal(box("wellness").checked, true, "Match's defaults, while untouched");
  input({ ccEventField: "eventTypeId" }, { value: T_TRAINING });
  const { body } = await lastBody(calls);
  assert.equal("questions" in body, false);
});

test("Q3. touched: the ticked questions are sent with their windows, and a type change no longer re-chooses them", async () => {
  const calls = await openCreate();
  input({ ccQuestionOn: "wellness" }, { checked: true });
  input({ ccQuestionWindow: "wellness" }, { value: "next_morning" });
  input({ ccEventField: "eventTypeId" }, { value: T_MEETING });
  assert.equal(box("rpe").checked, true, "touched: the type does not untick it");
  const { body } = await lastBody(calls);
  assert.deepEqual(body.questions, [{ kind: "rpe", window: { kind: "after_event" } }, { kind: "wellness", window: { kind: "next_morning" } }]);
});

test("Q4. unticking every default sends an empty list, so the type's defaults are not asked", async () => {
  const calls = await openCreate();
  input({ ccQuestionOn: "rpe" }, { checked: false });
  const { body } = await lastBody(calls);
  assert.deepEqual(body.questions, []);
});

test("Q5. a custom window: date and times sent; an end not after the start is marked with the one-day sentence and nothing is sent", async () => {
  const calls = await openCreate();
  input({ ccQuestionWindow: "rpe" }, { value: "custom" });
  const doc = dom();
  assert.ok(doc.querySelector('[data-cc-question-part="date"][data-cc-question-kind="rpe"]'));
  assert.match(doc.querySelector(".cc-question-custom").textContent, /Answers can be collected within one day for now\./);
  input({ ccQuestionPart: "from", ccQuestionKind: "rpe" }, { value: "10:00" });
  input({ ccQuestionPart: "to", ccQuestionKind: "rpe" }, { value: "09:00" });
  const before = writesOf(calls).length;
  await submitCentralCalendarEventForm({ render });
  assert.equal(writesOf(calls).length, before, "nothing sent");
  assert.match(dom().querySelector("#ccQuestion-rpe-error").textContent, /end time must be after the start time\. Answers can be collected within one day/);
  input({ ccQuestionPart: "to", ccQuestionKind: "rpe" }, { value: "11:30" });
  assert.equal(state.centralCalendar.form.errors["question:rpe"], undefined, "the mark goes when the field changes (drawn on the next render, not while typing)");
  const { body } = await lastBody(calls);
  assert.deepEqual(body.questions, [{ kind: "rpe", window: { kind: "custom", date: DAY(1), from: "10:00", to: "11:30" } }]);
});

test("Q6. After the event that cannot fit (an event ending at 23:59) says so and offers the others", async () => {
  const calls = await openCreate();
  input({ ccEventField: "startTime" }, { value: "22:00" });
  input({ ccEventField: "endTime" }, { value: "23:59" });
  input({ ccQuestionOn: "wellness" }, { checked: true });
  assert.match(dom().querySelector('[data-cc-question-window="rpe"][value="after_event"]').closest("label").textContent, /Doesn't fit this event/);
  const before = writesOf(calls).length;
  await submitCentralCalendarEventForm({ render });
  assert.equal(writesOf(calls).length, before);
  assert.match(dom().querySelector("#ccQuestion-rpe-error").textContent, /Choose Next morning or Custom/);
});

test("Q7. Edit: the live questions are read once; untouched, the PATCH carries no questions", async () => {
  const calls = await openEdit({ questions: [liveQuestion(Q_RPE, "rpe", AFTER())] });
  assert.equal(questionReads(calls).length, 1);
  assert.equal(box("rpe").checked, true);
  input({ ccEventField: "title" }, { value: "Cup final" });
  const { body } = await lastBody(calls);
  assert.equal("questions" in body, false);
  assert.equal(body.title, "Cup final");
});

test("Q8. Edit: an unanswered question's window can move; the whole list is sent", async () => {
  const calls = await openEdit({ questions: [liveQuestion(Q_RPE, "rpe", AFTER())] });
  input({ ccQuestionWindow: "rpe" }, { value: "next_morning" });
  const { body } = await lastBody(calls);
  assert.deepEqual(body.questions, [{ kind: "rpe", window: { kind: "next_morning" } }]);
});

test("Q9. Edit: an answered question is locked with its window in words; unticking it asks inline first (never a native confirm); Keep it sends nothing", async () => {
  const calls = await openEdit({ questions: [liveQuestion(Q_RPE, "rpe", AFTER(), { answered: 3 })] });
  let doc = dom();
  assert.equal(doc.querySelector('[data-cc-question-window="rpe"]'), null, "no window choice once answered");
  assert.match(doc.querySelector(".cc-question").textContent, /After the event, 17:00–23:59 .* Athletes have already answered/);
  input({ ccQuestionWindow: "rpe" }, { value: "next_morning" });
  assert.equal(state.centralCalendar.form.questions.picks.rpe.window.kind, "after_event", "the window cannot change");
  input({ ccQuestionOn: "rpe" }, { checked: false });
  const before = writesOf(calls).length;
  await submitCentralCalendarEventForm({ render });
  assert.equal(writesOf(calls).length, before, "the inline step first");
  doc = dom();
  assert.equal(doc.querySelector("#ccQuestionsCloseText").textContent, "Stop the RPE question? 3 answers are kept; nobody else can answer.");
  assert.equal(doc.querySelector('[data-action="central-calendar-event-questions-close-confirm"]').textContent, "Stop question and save");
  assert.equal(doc.querySelector('[data-action="central-calendar-event-questions-close-cancel"]').textContent, "Keep it");
  await act({ action: "central-calendar-event-questions-close-cancel" });
  assert.equal(dom().querySelector("#ccQuestionsCloseText"), null);
  assert.equal(writesOf(calls).length, before, "Keep it sends nothing");
  assert.equal(nativeConfirms.length, 0);
});

test("Q10. Stop question and save: one PATCH without the stopped question; the step does not come back for the same save", async () => {
  const calls = await openEdit({ questions: [liveQuestion(Q_RPE, "rpe", AFTER(), { answered: 1 }), liveQuestion(Q_WELL, "wellness", AFTER())] });
  input({ ccQuestionOn: "rpe" }, { checked: false });
  await submitCentralCalendarEventForm({ render });
  assert.equal(dom().querySelector("#ccQuestionsCloseText").textContent, "Stop the RPE question? 1 answer is kept; nobody else can answer.");
  const before = writesOf(calls).length;
  await act({ action: "central-calendar-event-questions-close-confirm" });
  const writes = writesOf(calls);
  assert.equal(writes.length, before + 1);
  assert.equal(writes.at(-1).method, "PATCH");
  assert.deepEqual(writes.at(-1).body.questions, [{ kind: "wellness", window: { kind: "after_event" } }]);
  assert.equal(nativeConfirms.length, 0);
});

test("Q11. an event with linked trainings: RPE cannot be ticked, with the sentence why", async () => {
  await openEdit({ event: eventView({ sessionLinks: [{ id: "s1" }] }), questions: [] });
  assert.equal(box("rpe").disabled, true);
  assert.match(box("rpe").closest(".cc-question").textContent, /RPE comes from the linked trainings\./);
  input({ ccQuestionOn: "rpe" }, { checked: true });
  assert.equal(state.centralCalendar.form.questions.picks.rpe.on, false);
});

test("Q12. Edit: a 404 on the questions read leaves the section out silently; another failure says they stay as they are; neither sends questions", async () => {
  let calls = await openEdit({ questions: () => NOT_FOUND });
  assert.equal(dom().querySelector(".cc-questions"), null);
  assert.equal(dom().querySelector(".cc-questions-note"), null);
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  calls = await openEdit({ questions: () => ({ status: 500, body: { error: "internal_error" } }) });
  assert.match(dom().querySelector(".cc-questions-note").textContent, /could not be read, so they stay as they are/);
  input({ ccEventField: "title" }, { value: "Cup final" });
  const { body } = await lastBody(calls);
  assert.equal("questions" in body, false);
});

test("Q13. questions_off on save: the section goes, the sentence says to save again, and the next save sends no questions", async () => {
  let refused = false;
  const calls = await openCreate({ write: (call) => (!refused && call.method === "POST" ? ((refused = true), { status: 409, body: { error: "questions_off", message: "?" } }) : null) });
  input({ ccQuestionOn: "wellness" }, { checked: true });
  await submitCentralCalendarEventForm({ render });
  assert.equal(dom().querySelector(".cc-questions"), null);
  assert.match(dom().querySelector(".cc-form-error").textContent, /^Questions for athletes are not turned on for this club\. Nothing was saved\. Save again without the questions\./);
  const { body } = await lastBody(calls);
  assert.equal("questions" in body, false);
});

test("Q14. a question refusal reads as one sentence with no code; the form stays with what was chosen", async () => {
  await openCreate({ write: (call) => (call.method === "POST" ? { status: 409, body: { error: "wellness_already_scheduled", message: "raw server text" } } : null) });
  input({ ccQuestionOn: "wellness" }, { checked: true });
  await submitCentralCalendarEventForm({ render });
  const text = dom().querySelector(".cc-form-error").textContent;
  assert.equal(text, "Today's WELLNESS already covers this day. Untick WELLNESS, or choose another day. Nothing was saved.");
  assert.doesNotMatch(text, /wellness_already_scheduled|raw server text/);
  assert.equal(box("wellness").checked, true);
});

test("Q15. a lost answer: Result not confirmed; Check result sends the SAME key and body, questions included", async () => {
  let lose = true;
  const calls = await openCreate({ write: (call) => (call.method === "POST" && lose ? ((lose = false), { throwNetworkError: true }) : null) });
  input({ ccQuestionOn: "wellness" }, { checked: true });
  await submitCentralCalendarEventForm({ render });
  assert.ok(state.centralCalendar.form.unconfirmed);
  const first = writesOf(calls).at(-1);
  await act({ action: "central-calendar-event-check-result" });
  const second = writesOf(calls).at(-1);
  assert.notEqual(first, second);
  assert.equal(second.body.requestKey, first.body.requestKey);
  assert.deepEqual(second.body, first.body);
  assert.deepEqual(second.body.questions.map((q) => q.kind), ["rpe", "wellness"]);
});

test("Q16. the saved sentence names a question the server skipped and a day off that was cancelled", async () => {
  await openCreate({ write: (call) => (call.method === "POST" ? { status: 201, body: { event: eventView({ id: E_NEW, revision: 1 }), questionsAsked: ["rpe"], questionsSkipped: ["wellness"], dayOffCancelled: true } } : null) });
  await submitCentralCalendarEventForm({ render });
  await tick();
  const notice = state.centralCalendar.notice || "";
  assert.match(notice, /WELLNESS wasn't asked: this day's WELLNESS already covers it\./);
  assert.match(notice, /open WELLNESS check-in on these days was cancelled\./);
});

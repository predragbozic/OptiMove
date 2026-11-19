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
const { invalidateCentralCalendarCache: invalidateCache, loadCentralCalendar, resetCentralCalendarForWorkspaceChange } = await import("../central-calendar-data.js");
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

// --- The event panel ----------------------------------------------------------------

const PANEL_KEY = `event:${E_MATCH}:${DAY(1)}`;
// A fake of the question routes: a live list, the event's revision moving on
// every write, the same key with the same body replayed, another body
// request_key_reused. `refuse(call)` may answer first; `lose` drops the first
// answer of a write (the write itself lands).
function panelServer({ enabled = true, questions = [], refuse = null, lose = false, event = eventView(), items = null, canManage = true } = {}) {
  let revision = event.revision;
  let list = questions.map((q) => JSON.parse(JSON.stringify(q)));
  const live = (items || [eventItem(E_MATCH, DAY(1), { canManage })]).map((item) => ({ ...item }));
  const keys = new Map();
  let dropNext = lose;
  let nextId = 10;
  const bump = () => {
    revision += 1;
    for (const item of live) if (item.eventId === E_MATCH) item.revision = revision;
  };
  const write = (call, apply) => {
    const { requestKey, ...rest } = call.body || {};
    const hash = `${call.url}|${JSON.stringify(rest)}`;
    const saved = keys.get(requestKey);
    if (saved) return saved.hash === hash ? saved.answer : { status: 409, body: { error: "request_key_reused", message: "?" } };
    if (refuse) {
      const refused = refuse(call);
      if (refused) return refused;
    }
    if (rest.expectedRevision !== revision) return { status: 409, body: { error: "event_changed", message: "?" } };
    const body = apply(rest);
    if (body.status) return body;
    bump();
    const answer = { status: 200, body: { ...body, event: { id: E_MATCH, revision } } };
    keys.set(requestKey, { hash, answer });
    if (dropNext) {
      dropNext = false;
      return { throwNetworkError: true };
    }
    return answer;
  };
  const windowOf = (w) => (w.kind === "custom" ? w : w.kind === "next_morning" ? { kind: "next_morning", date: addDaysIso(DAY(1), 1), from: "07:00", to: "12:00" } : AFTER());
  const responder = (call) => {
    const path = call.url.split("?")[0];
    if (path === "/api/calendar" && call.method === "GET") return { status: 200, body: rangeAnswer(call.url, live) };
    if (path === "/api/calendar/events/types" && call.method === "GET") return { status: 200, body: catalogOf(enabled) };
    if (path === `/api/calendar/events/${E_MATCH}/questions` && call.method === "GET") {
      if (!enabled || !canManage) return NOT_FOUND;
      return { status: 200, body: { questions: list } };
    }
    if (path === `/api/calendar/events/${E_MATCH}` && call.method === "GET") return { status: 200, body: { event: { ...event, revision } } };
    if (path === `/api/calendar/events/${E_MATCH}/questions` && call.method === "POST") {
      return write(call, (b) => {
        if (list.some((q) => q.kind === b.kind && q.status === "live")) return { status: 409, body: { error: "question_already_asked", message: "?" } };
        const q = liveQuestion(`90000000-0000-4000-8000-0000000000${nextId++}`, b.kind, windowOf(b.window));
        list = [...list, q];
        return { question: { id: q.id } };
      });
    }
    const move = path.match(/\/questions\/([^/]+)\/(move|remove)$/);
    if (move && call.method === "POST") {
      return write(call, (b) => {
        const q = list.find((entry) => entry.id === move[1] && entry.status === "live");
        if (!q) return NOT_FOUND;
        if (move[2] === "move") {
          if (q.counts.answered > 0) return { status: 409, body: { error: "questions_answered", message: "?" } };
          q.window = windowOf(b.window);
          return { question: { id: q.id } };
        }
        if (q.counts.answered > 0) q.status = "closed_early";
        else list = list.filter((entry) => entry !== q);
        return { question: { id: q.id, status: q.status } };
      });
    }
    return { status: 404, body: { error: "unexpected", message: call.url } };
  };
  responder.list = () => list;
  // A change made elsewhere (another coach's save): the card's revision moves.
  responder.bump = bump;
  let gate = null;
  responder.hold = () => {
    let open;
    gate = new Promise((resolve) => { open = resolve; });
    return () => open();
  };
  const plain = responder;
  const held = (call) => (gate && call.method === "POST" ? gate.then(() => { gate = null; return plain(call); }) : plain(call));
  held.bump = bump;
  held.hold = responder.hold;
  return held;
}

let currentServer = null;
async function openQuestionsPanel(options = {}) {
  currentServer = panelServer(options);
  const calls = installFetchMock(currentServer);
  await loadCentralCalendar({ render });
  await tick();
  await act({ action: "central-calendar-open-item", key: PANEL_KEY, date: DAY(1) });
  await tick();
  return calls;
}
const qact = (act, extra = {}) => act === "send" || act === "step-cancel"
  ? handleCentralCalendarAction(fakeAction({ action: "central-calendar-question", act }), { render })
  : handleCentralCalendarAction(fakeAction({ action: "central-calendar-question", act, ...extra }), { render });
const section = () => dom().querySelector(".cc-panel-questions");
const questionWrites = (calls) => calls.filter((call) => call.method === "POST" && call.url.includes("/questions"));

test("P1. the panel reads the questions once, only for a manager while the switch is on; never per card, never for a reader", async () => {
  let calls = installFetchMock(panelServer());
  await loadCentralCalendar({ render });
  await tick();
  assert.equal(questionReads(calls).length, 0, "the calendar alone reads no questions");
  await act({ action: "central-calendar-open-item", key: PANEL_KEY, date: DAY(1) });
  await tick();
  assert.equal(questionReads(calls).length, 1);
  render();
  await tick();
  assert.equal(questionReads(calls).length, 1, "not again on a repaint");
  // Switch off: no read.
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  calls = await openQuestionsPanel({ enabled: false });
  assert.equal(questionReads(calls).length, 0);
  assert.equal(section(), null);
  // A reader's event: no read, no section.
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  calls = await openQuestionsPanel({ canManage: false });
  assert.equal(questionReads(calls).length, 0);
  assert.equal(section(), null);
});

test("P2. counts, the window in words, three folded lists with names (Not answered yet open), status words, Nobody.", async () => {
  const rpe = liveQuestion(Q_RPE, "rpe", AFTER(), { asked: 4, answered: 1, later: 1 });
  rpe.notAnswered = [athlete(3), athlete(4)];
  const well = { ...liveQuestion(Q_WELL, "wellness", { kind: "custom", date: DAY(2), from: "09:00", to: "11:00" }, { asked: 4, answered: 4 }), status: "closed_early" };
  await openQuestionsPanel({ questions: [well, rpe] });
  const doc = dom();
  const rows = [...doc.querySelectorAll(".cc-question-row")];
  assert.equal(rows.length, 2);
  assert.match(rows[0].querySelector(".cc-question-head").textContent, /^RPE · 1\/4 answered$/, "RPE first");
  assert.match(rows[0].querySelector(".cc-question-window").textContent, /^After the event, 17:00–23:59 /);
  const lists = [...rows[0].querySelectorAll("details")];
  assert.deepEqual(lists.map((d) => d.querySelector("summary").textContent), ["Answered (1)", "Later (1)", "Not answered yet (2)"]);
  assert.deepEqual(lists.map((d) => d.open), [false, false, true]);
  assert.deepEqual([...lists[2].querySelectorAll("li")].map((li) => li.textContent), ["Athlete 3", "Athlete 4"]);
  assert.match(rows[1].querySelector(".cc-question-head").textContent, /WELLNESS · 4\/4 answered ✓/);
  assert.match(rows[1].textContent, /Closed early — the answers given stay\./);
  assert.match(rows[1].querySelector(".cc-question-window").textContent, /^\w{3} \d\d\.\d\d\., 09:00–11:00$/);
  assert.equal(rows[1].querySelector('[data-act="remove-open"]'), null, "no buttons on an ended question");
  assert.equal(rows[1].querySelectorAll("details")[2].textContent.includes("Nobody."), true);
  assert.ok(doc.querySelector('[data-act="ask-open"][data-kind="wellness"]'), "WELLNESS can be asked again");
  assert.doesNotMatch(doc.querySelector(".cc-main").textContent, /Athlete 3/, "names only in the panel");
});

test("P3. a 404 hides the section silently; a failure says so with Try again, which reads once more", async () => {
  let failing = true;
  const responder = panelServer();
  const calls = installFetchMock((call) => (call.method === "GET" && call.url.endsWith("/questions") ? (failing ? { status: 500, body: { error: "internal_error" } } : responder(call)) : responder(call)));
  await loadCentralCalendar({ render });
  await tick();
  await act({ action: "central-calendar-open-item", key: PANEL_KEY, date: DAY(1) });
  await tick();
  assert.equal(section().querySelector('[role="alert"]').textContent, "The questions could not be read.");
  failing = false;
  await act({ action: "central-calendar-questions-retry" });
  assert.equal(questionReads(calls).length, 2);
  assert.ok(section().querySelector('[data-act="ask-open"]'));
  // 404: nothing.
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  installFetchMock((call) => (call.method === "GET" && call.url.endsWith("/questions") ? NOT_FOUND : responder(call)));
  await loadCentralCalendar({ render });
  await tick();
  await act({ action: "central-calendar-open-item", key: PANEL_KEY, date: DAY(1) });
  await tick();
  assert.equal(section(), null);
  assert.doesNotMatch(rendered, /not available|could not be read/);
});

test("P4. Ask WELLNESS: an inline When to ask, then one POST with requestKey, expectedRevision, kind and window; read again; the notice", async () => {
  const calls = await openQuestionsPanel();
  await qact("ask-open", { kind: "wellness" });
  assert.equal(questionWrites(calls).length, 0, "opening the step sends nothing");
  input2({ ccQstepWindow: "1" }, "next_morning");
  const before = calls.length;
  await qact("send");
  const write = questionWrites(calls).at(-1);
  assert.equal(write.url, `/api/calendar/events/${E_MATCH}/questions`);
  const { requestKey, ...body } = write.body;
  assert.match(requestKey, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(body, { expectedRevision: 2, kind: "wellness", window: { kind: "next_morning" } });
  assert.ok(questionReads(calls.slice(before)).length >= 1, "the questions are read again");
  assert.equal(dom().querySelector(".cc-panel-questions .cc-link-message").textContent, "WELLNESS asked. Athletes will be notified.");
  assert.match(section().textContent, /WELLNESS · 0\/18 answered/);
});

function input2(dataset, value) {
  return handleCentralCalendarInput({ dataset, value, closest: (selector) => (selector === "[data-cc-question-step]" ? {} : null) }, { render });
}

test("P5. Move time: the current window first; Save time sends the window; questions_answered says so and reads again", async () => {
  const calls = await openQuestionsPanel({ questions: [liveQuestion(Q_RPE, "rpe", AFTER())] });
  await qact("move-open", { questionId: Q_RPE });
  assert.equal(dom().querySelector('[data-cc-qstep-window][value="after_event"]').checked, true);
  input2({ ccQstepWindow: "1" }, "custom");
  input2({ ccQstepPart: "from" }, "08:00");
  input2({ ccQstepPart: "to" }, "10:00");
  await qact("send");
  const write = questionWrites(calls).at(-1);
  assert.equal(write.url, `/api/calendar/events/${E_MATCH}/questions/${Q_RPE}/move`);
  assert.deepEqual(write.body.window, { kind: "custom", date: DAY(1), from: "08:00", to: "10:00" });
  assert.equal(write.body.expectedRevision, 2);
  assert.equal(dom().querySelector(".cc-panel-questions .cc-link-message").textContent, "Time moved. Athletes will be notified.");
  assert.equal(section().querySelector('[data-act="send"]'), null, "the step closed");
});

test("P6. Move time is off once answered; a refusal keeps the step for another time, and a new press is a new key", async () => {
  const calls = await openQuestionsPanel({
    questions: [liveQuestion(Q_RPE, "rpe", AFTER(), { answered: 2 }), liveQuestion(Q_WELL, "wellness", AFTER())],
    refuse: (call) => (call.url.endsWith("/move") ? { status: 409, body: { error: "wellness_already_scheduled", message: "raw" } } : null),
  });
  const rows = [...dom().querySelectorAll(".cc-question-row")];
  assert.equal(rows[0].querySelector('[data-act="move-open"]').disabled, true);
  await qact("move-open", { questionId: Q_WELL });
  input2({ ccQstepWindow: "1" }, "next_morning");
  await qact("send");
  const first = questionWrites(calls).at(-1);
  assert.equal(section().querySelector(".cc-question-step .cc-field-error").textContent, "Today's WELLNESS already covers this day. Choose another day. Nothing was saved.");
  await qact("send");
  const second = questionWrites(calls).at(-1);
  assert.notEqual(second.body.requestKey, first.body.requestKey, "a refused key is never sent again");
  assert.doesNotMatch(rendered, /wellness_already_scheduled|raw/);
});

test("P7. Remove an unanswered question: an inline step (never a native confirm); Keep it sends nothing; Remove question sends; Removed.", async () => {
  const calls = await openQuestionsPanel({ questions: [liveQuestion(Q_RPE, "rpe", AFTER())] });
  await qact("remove-open", { questionId: Q_RPE });
  let doc = dom();
  assert.equal(doc.querySelector("#ccQuestionStepText").textContent, "Remove the RPE question? Athletes won't be asked.");
  assert.deepEqual([...doc.querySelectorAll(".cc-inline-confirm button")].map((b) => b.textContent), ["Remove question", "Keep it"]);
  await qact("step-cancel");
  assert.equal(dom().querySelector("#ccQuestionStepText"), null);
  assert.equal(questionWrites(calls).length, 0);
  await qact("remove-open", { questionId: Q_RPE });
  await qact("send");
  const write = questionWrites(calls).at(-1);
  assert.equal(write.url, `/api/calendar/events/${E_MATCH}/questions/${Q_RPE}/remove`);
  assert.deepEqual(Object.keys(write.body).sort(), ["expectedRevision", "requestKey"]);
  assert.equal(dom().querySelector(".cc-panel-questions .cc-link-message").textContent, "Removed.");
  assert.equal(nativeConfirms.length, 0);
});

test("P8. Stop an answered question: its own words; after the read it is closed early - Closed. The answers given stay.", async () => {
  await openQuestionsPanel({ questions: [liveQuestion(Q_RPE, "rpe", AFTER(), { answered: 3 })] });
  await qact("remove-open", { questionId: Q_RPE });
  assert.equal(dom().querySelector("#ccQuestionStepText").textContent, "Stop the RPE question? 3 answers are kept; nobody else can answer.");
  assert.equal(dom().querySelector('.cc-inline-confirm [data-act="send"]').textContent, "Stop question");
  await qact("send");
  assert.equal(dom().querySelector(".cc-panel-questions .cc-link-message").textContent, "Closed. The answers given stay.");
  assert.match(section().textContent, /Closed early — the answers given stay\./);
});

test("P9. a lost answer: not confirmed, every control off (Edit too); Check result sends the same path, body and key; try_again keeps it", async () => {
  let checks = 0;
  const calls = await openQuestionsPanel({ lose: true, questions: [liveQuestion(Q_RPE, "rpe", AFTER())] });
  await qact("remove-open", { questionId: Q_RPE });
  await qact("send");
  const first = questionWrites(calls).at(-1);
  let doc = dom();
  assert.match(section().textContent, /The result is not confirmed\./);
  assert.equal(doc.querySelector('[data-action="central-calendar-edit-event"]').disabled, true);
  assert.equal(doc.querySelector('[data-act="ask-open"]').disabled, true);
  assert.match(doc.querySelector(".cc-uncertain-line").textContent, /Check the question for “Cup match”/);
  // A busy server on the check: still not confirmed.
  const responder = panelServer({ questions: [] });
  installFetchMock((call) => {
    if (call.method === "POST") {
      checks += 1;
      if (checks === 1) return { status: 503, body: { error: "try_again" } };
    }
    return call.method === "POST" ? { status: 200, body: { question: { id: Q_RPE }, event: { id: E_MATCH, revision: 3 } } } : responder(call);
  });
  const checkCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    checkCalls.push({ url, init });
    return realFetch(url, init);
  };
  const key = section().querySelector('[data-action="central-calendar-link-check"]').dataset.requestKey;
  await act({ action: "central-calendar-link-check", requestKey: key });
  assert.match(section().textContent, /The result is not confirmed\./);
  await act({ action: "central-calendar-link-check", requestKey: key });
  globalThis.fetch = realFetch;
  const posts = checkCalls.filter((call) => call.init?.method === "POST");
  assert.equal(posts.length, 2);
  for (const post of posts) {
    assert.equal(post.url, first.url);
    assert.deepEqual(JSON.parse(post.init.body), first.body, "the same key and body");
  }
  doc = dom();
  assert.equal(doc.querySelector(".cc-uncertain-line"), null, "settled");
  assert.equal(doc.querySelector('[data-action="central-calendar-edit-event"]').disabled, false);
});

test("P10. one control at a time: a double press sends one request; a step blocks the others", async () => {
  const calls = await openQuestionsPanel();
  await qact("ask-open", { kind: "rpe" });
  assert.equal(dom().querySelector('[data-act="ask-open"][data-kind="wellness"]').disabled, true);
  await Promise.all([qact("send"), qact("send")]);
  assert.equal(questionWrites(calls).length, 1);
});

test("P11. RPE with linked trainings: no Ask RPE, its line; the RPE gap names Ask RPE when it can be asked", async () => {
  await openQuestionsPanel({ event: eventView({ sessionLinks: [{ id: "s1" }] }), items: [eventItem(E_MATCH, DAY(1), { expects: ["rpe"], gaps: ["rpe"] })] });
  let doc = dom();
  assert.equal(doc.querySelector('[data-act="ask-open"][data-kind="rpe"]'), null);
  assert.match(section().textContent, /RPE comes from the linked trainings\./);
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  await openQuestionsPanel({ items: [eventItem(E_MATCH, DAY(1), { expects: ["rpe"], gaps: ["rpe"] })] });
  doc = dom();
  assert.equal(doc.querySelector(".cc-panel-gap").textContent, "RPE is expected, but nothing attached to this event asks the athletes for it yet. Use Ask RPE below.");
});

test("P12. a revision move reads the questions again; the section's HTML names no id or code", async () => {
  const calls = await openQuestionsPanel({ questions: [liveQuestion(Q_RPE, "rpe", AFTER())] });
  const html = section().outerHTML.replace(/data-[a-z-]+="[^"]*"/g, "");
  assert.doesNotMatch(html, /[0-9a-f]{8}-[0-9a-f]{4}-/i);
  assert.doesNotMatch(html, /after_event|next_morning|closed_early|_/);
  invalidateCache();
  await loadCentralCalendar({ render, forceRefresh: true });
  await tick();
  assert.equal(questionReads(calls).length, 1, "the same revision: not read again");
  currentServer.bump();
  invalidateCache();
  await loadCentralCalendar({ render, forceRefresh: true });
  await tick();
  assert.equal(questionReads(calls).length, 2, "the card's revision moved: read again");
  await qact("ask-open", { kind: "wellness" });
  await qact("send");
  assert.ok(questionReads(calls).length >= 2, "read again after a confirmed write");
});

test("P13. leaving with a question in flight asks first, in the question's words; a yes keeps it to check", async () => {
  const { centralCalendarMayBeLeft } = await import("../central-calendar-actions.js");
  await openQuestionsPanel();
  const release = currentServer.hold();
  await qact("ask-open", { kind: "rpe" });
  const sending = qact("send");
  await tick();
  nativeConfirms.length = 0;
  assert.equal(centralCalendarMayBeLeft(), true);
  assert.match(nativeConfirms[0], /^A question is still being saved\. Leave anyway\?/);
  assert.ok(centralCalendarUncertainWrites().some((entry) => entry.mode === "question"));
  release();
  await sending;
});

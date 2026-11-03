// Central calendar (K2a-2, docs/ai/central-calendar-k2a-2-plan.md): events in
// the screen - the Filters panel, the card, the selected day, and creating,
// editing and cancelling an event - through the real handlers, loaders and
// templates with a fake fetch (tests/support/fetch-mock.mjs) and JSDOM for the
// markup. The fake answers the K2a-1a API's own shapes
// (backend/src/routes/calendarEvents.js, calendarEventService.js; the
// `kind: "event"` items of GET /api/calendar, calendarQuery.js publicCard).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

let confirmAnswer = true;
const questions = [];
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: (question) => { questions.push(question); return confirmAnswer; } };

const { state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const {
  CENTRAL_CALENDAR_STAYED,
  centralCalendarCanCreateEvents,
  centralCalendarEventRoster,
  centralCalendarMayBeLeft,
  centralCalendarRosterIndex,
  centralCalendarUncertainWrites,
  clearCentralCalendarUncertainWrites,
  closeCentralCalendarPanel,
  handleCentralCalendarAction,
  handleCentralCalendarBeforeUnload,
  handleCentralCalendarInput,
  handleCentralCalendarKeydown,
  submitCentralCalendarEventForm,
} = await import("../central-calendar-actions.js");
const { loadCentralCalendar, resetCentralCalendarForWorkspaceChange } = await import("../central-calendar-data.js");
const view = await import("../central-calendar-view.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
const DAY = (offset) => addDaysIso(MONDAY, offset);
const CLUB = "c1c1c1c1-0000-4000-8000-000000000001";
const U19 = "11111111-1111-4111-8111-111111111111";
const U17 = "22222222-2222-4222-8222-222222222222";
const U13 = "33333333-3333-4333-8333-333333333333";
const TEAMS = [
  { teamId: U19, name: "U19", athleteCount: 20 },
  { teamId: U17, name: "U17", athleteCount: 18 },
  { teamId: U13, name: "U13", athleteCount: 12 },
];
const E_MATCH = "e0000000-0000-4000-8000-000000000001";
const E_CAMP = "e0000000-0000-4000-8000-000000000002";
const E_MEETING = "e0000000-0000-4000-8000-000000000003";
const E_NEW = "e0000000-0000-4000-8000-0000000000aa";
const T_TRAINING = "70000000-0000-4000-8000-000000000001";
const T_MATCH = "70000000-0000-4000-8000-000000000002";
const T_MEETING = "70000000-0000-4000-8000-000000000003";
const T_TEST = "70000000-0000-4000-8000-000000000004";
const TYPES = [
  { id: T_TRAINING, kind: "training", key: "training", label: "Training", defaultExpects: ["rpe"], iconKey: null, sortOrder: 10, ownerScope: "club" },
  { id: T_MATCH, kind: "match", key: "match", label: "Match", defaultExpects: ["rpe"], iconKey: null, sortOrder: 20, ownerScope: "club" },
  { id: T_MEETING, kind: "meeting", key: "meeting", label: "Meeting", defaultExpects: [], iconKey: null, sortOrder: 40, ownerScope: "club" },
  { id: T_TEST, kind: "test", key: "test", label: "Test", defaultExpects: ["test_result"], iconKey: null, sortOrder: 70, ownerScope: "club" },
];
const A1 = "aaaaaaaa-0000-4000-8000-000000000001";
const A2 = "aaaaaaaa-0000-4000-8000-000000000002";
const A3 = "aaaaaaaa-0000-4000-8000-000000000003";
const ROSTER = [
  { athlete_uuid: A1, athlete_id: "1", athlete: "Marko Test" },
  { athlete_uuid: A2, athlete_id: "2", athlete: "Ana Test" },
  { athlete_uuid: A3, athlete_id: "3", athlete: "Luka Test" },
];

function baseItem(overrides) {
  return {
    key: "", kind: "planned", date: DAY(0), title: null, slot: null, startTime: null, startsAt: null,
    teamIds: [U19], athleteIds: [], athleteCount: 0, expects: [], status: "none", rpe: null, attendance: null,
    results: null, cancelled: false, projected: false, links: {}, ...overrides,
  };
}
// An event card as a manager reads it (publicCard of calendarQuery.js).
function eventItem(id, date, overrides) {
  return baseItem({
    key: `event:${id}:${date}`, kind: "event", date, eventId: id, eventKind: "training", eventTypeLabel: "Training", eventTypeId: T_TRAINING,
    endTime: null, location: null, span: { from: date, to: date }, gaps: [], scheduleFold: { external: null, test: null }, revision: 1, canManage: true, notes: null,
    links: { eventId: id, planIds: [], logicalSessionIds: [], activityIds: [], externalScheduleId: null, testScheduleId: null },
    ...overrides,
  });
}
const CAMP_SPAN = { from: DAY(2), to: DAY(4) };
const ITEMS = [
  baseItem({ key: "planned:batch-1", date: DAY(0), title: "Team training", slot: { amPm: "AM", bta: "T", order: 1 }, athleteCount: 20, expects: ["rpe"], status: "planned", rpe: { asked: 20, submitted: 0 } }),
  eventItem(E_MEETING, DAY(0), { title: "Parents meeting", eventKind: "meeting", eventTypeLabel: "Meeting", status: "cancelled", cancelled: true, teamIds: [U19] }),
  baseItem({ key: "activity:act-1", kind: "activity", date: DAY(0), title: "Gym", origin: "manual", teamIds: [U19], athleteCount: 2, status: "none" }),
  eventItem(E_MATCH, DAY(1), {
    title: "Cup match", eventKind: "match", eventTypeLabel: "Match", eventTypeId: T_MATCH, startTime: "15:00", endTime: "17:00", location: "City stadium",
    teamIds: [U17], athleteCount: 18, expects: ["rpe"], status: "planned", gaps: ["rpe"], revision: 2, notes: "Bring both kits",
  }),
  ...[2, 3, 4].map((offset) => eventItem(E_CAMP, DAY(offset), {
    title: "Summer camp", eventKind: "camp", eventTypeLabel: "Camp", span: CAMP_SPAN, teamIds: [U19], athleteCount: 20, expects: [], status: "none", canManage: false,
    links: { eventId: E_CAMP, activityIds: [] },
  })),
];

function rangeAnswer(url, items = ITEMS, workspace = { type: "club", scopeId: CLUB }) {
  const params = new URL(url, "http://localhost").searchParams;
  const from = params.get("from");
  const to = params.get("to");
  const days = [];
  for (let cursor = from; cursor <= to; cursor = addDaysIso(cursor, 1)) days.push({ date: cursor, items: items.filter((item) => item.date === cursor).map((item) => (params.get("include") === "athletes" ? { ...item, athletes: [] } : { ...item })) });
  return { from, to, today: params.get("today"), workspace, teams: workspace.type === "private_coach" ? [] : TEAMS, days };
}

// GET /api/calendar/events/:id as the manager's view (calendarEventService viewOf).
function eventView(overrides = {}) {
  return {
    id: E_MATCH, ownerScope: "club", ownerClubId: CLUB, ownerTeamId: null, ownerUserId: null,
    eventTypeId: T_MATCH, eventKind: "match", eventTypeLabel: "Match", title: "Cup match", day: DAY(1), endDay: null,
    startTime: "15:00", endTime: "17:00", timezone: "Europe/Belgrade", location: "City stadium", status: "planned",
    cancelledAt: null, cancelReason: null, expects: ["rpe"], externalScheduleId: null, testScheduleId: null, revision: 2,
    createdAt: "2026-10-30T10:00:00.000Z", updatedAt: "2026-10-30T10:00:00.000Z",
    targets: [{ kind: "team", id: U17, name: "U17" }], links: { planIds: [], activityIds: [] }, canManage: true, notes: "Bring both kits",
    ...overrides,
  };
}

const NOT_FOUND = { status: 404, body: { error: "notFound", message: "Not found." } };

// The fake server: the calendar read, the types, one event, and the writes
// (`writes` decides per call; default: a created / saved / cancelled event,
// which the next calendar read then serves as the real API would). The
// default writes keep the service's requestKey contract (runEventCommand):
// the same key with the same body (and resource) replays the saved answer
// with `replayed: true` and writes nothing; the same key with another body is
// 409 request_key_reused. `loseFirstAnswer` saves the first write and then
// drops its answer (a lost answer after a COMMIT).
function server({ items = ITEMS, workspace, types = TYPES, event = eventView(), writes = null, loseFirstAnswer = false } = {}) {
  const live = items.map((item) => ({ ...item }));
  const keys = new Map();
  let lose = loseFirstAnswer;
  const responder = (call) => {
    const path = call.url.split("?")[0];
    if (path === "/api/calendar" && call.method === "GET") return { status: 200, body: rangeAnswer(call.url, live, workspace) };
    if (path === "/api/calendar/events/types" && call.method === "GET") return typeof types === "function" ? types(call) : { status: 200, body: { types } };
    if (path.startsWith("/api/calendar/events/") && call.method === "GET") {
      if (typeof event === "function") return event(call);
      return path.endsWith(`/${event.id}`) ? { status: 200, body: { event } } : NOT_FOUND;
    }
    if (path.startsWith("/api/calendar/events")) {
      if (writes) return writes(call);
      const { requestKey, ...rest } = call.body || {};
      const hash = JSON.stringify({ method: call.method, path, rest });
      const saved = keys.get(requestKey);
      if (saved) return saved.hash === hash ? { status: saved.status, body: { ...saved.body, replayed: true } } : { status: 409, body: { error: "request_key_reused", message: "This requestKey was already used for a different request." } };
      const answer = write(call, path);
      if (answer.status < 300) keys.set(requestKey, { hash, ...answer });
      if (lose) {
        lose = false;
        return { throwNetworkError: true };
      }
      return answer;
    }
    return { status: 404, body: { error: "unexpected", message: call.url } };
  };
  function write(call, path) {
    {
      if (call.method === "POST" && path === "/api/calendar/events") {
        const from = call.body.day;
        const to = call.body.endDay || from;
        for (let day = from; day <= to; day = addDaysIso(day, 1)) live.push(eventItem(E_NEW, day, { title: call.body.title, span: { from, to } }));
        return { status: 201, body: { event: eventView({ id: E_NEW, title: call.body.title, day: from, endDay: call.body.endDay || null, revision: 1 }) } };
      }
      if (call.method === "PATCH") {
        for (const item of live) if (item.eventId === E_MATCH && call.body.title) item.title = call.body.title;
        return { status: 200, body: { event: eventView({ ...call.body, revision: 3 }) } };
      }
      if (call.method === "POST" && path.endsWith("/cancel")) {
        for (const item of live) if (item.eventId === E_MATCH) Object.assign(item, { status: "cancelled", cancelled: true });
        return { status: 200, body: { event: eventView({ status: "cancelled", revision: 3 }) } };
      }
    }
    return { status: 404, body: { error: "unexpected", message: call.url } };
  }
  responder.live = live;
  return responder;
}

let rendered = "";
let layout = "wide";
function render() {
  rendered = view.renderCentralCalendarHtml(state.centralCalendar, {
    today: TODAY, layout, roster: centralCalendarRosterIndex(), canCreate: centralCalendarCanCreateEvents(), eventRoster: centralCalendarEventRoster(),
    uncertainWrites: centralCalendarUncertainWrites(),
  });
}
function dom(html = rendered) {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
}
async function act(dataset) {
  return handleCentralCalendarAction(fakeAction(dataset), { render });
}
// A form control as the browser reports it to app.js's input / change route.
function input(dataset, { value = "", checked = false } = {}) {
  return handleCentralCalendarInput({ dataset, value, checked, closest: (selector) => (selector === "[data-cc-event-form]" ? {} : null) }, { render });
}
const writesOf = (calls) => calls.filter((call) => call.url.startsWith("/api/calendar/events") && call.method !== "GET");
const rangeReads = (calls) => calls.filter((call) => call.url.startsWith("/api/calendar?"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  clearCentralCalendarUncertainWrites();
  state.deliberateNavigation = false;
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: CLUB, label: "First Club" } };
  state.activeTab = "central-calendar";
  state.athletes = ROSTER.map((row) => ({ ...row }));
  layout = "wide";
  rendered = "";
  confirmAnswer = true;
  questions.length = 0;
});

// --- 1. The card ---------------------------------------------------------------

test("1a. an event card: its type's icon, Event · type, the time span, the place, the team pill and the status pill", async () => {
  installFetchMock(server());
  await loadCentralCalendar({ render });
  const card = dom().querySelector(`.cc-card[data-key="event:${E_MATCH}:${DAY(1)}"]`);
  assert.ok(card, "the event is a card of its day");
  assert.ok(card.classList.contains("cc-card-event"));
  assert.equal(card.querySelector(".cc-card-kind").textContent, "Event · Match · 18 athletes");
  assert.equal(card.querySelector(".cc-card-when").textContent, "15:00–17:00");
  assert.equal(card.querySelector(".cc-card-place").textContent, "City stadium");
  assert.equal(card.querySelector(".cc-team-pill .cc-team-pill-name").textContent, "U17");
  assert.match(card.querySelector(".cc-team-pill").getAttribute("style"), /--cc-team-1/, "the pill wears the team's colour");
  assert.equal(card.querySelector(".cc-badge").textContent, "Planned");
  assert.ok(card.querySelector("svg.cc-card-icon"), "the type's icon");
  assert.equal(view.centralCalendarItemIconKey({ kind: "event", eventKind: "match" }), "trophy");
  assert.equal(view.centralCalendarItemIconKey({ kind: "event", eventKind: "day_off" }), "bed");
  assert.equal(view.centralCalendarItemIconKey({ kind: "event", eventKind: "unknown" }), "calendar-event");
  assert.equal(view.centralCalendarItemIconKey({ kind: "planned" }), "barbell");
  assert.match(card.getAttribute("aria-label"), /Cup match, Event · Match · 18 athletes, 15:00–17:00, City stadium, Planned/);
});

test("1b. a multi-day event says which day of the span each card is; a cancelled one is struck with its pill", async () => {
  installFetchMock(server());
  await loadCentralCalendar({ render });
  const doc = dom();
  assert.equal(doc.querySelector(`.cc-card[data-key="event:${E_CAMP}:${DAY(3)}"] .cc-card-span`).textContent, "Day 2 of 3");
  assert.equal(doc.querySelector(`.cc-card[data-key="event:${E_CAMP}:${DAY(4)}"] .cc-card-span`).textContent, "Day 3 of 3");
  const meeting = doc.querySelector(`.cc-card[data-key="event:${E_MEETING}:${DAY(0)}"]`);
  assert.ok(meeting.classList.contains("is-cancelled"));
  assert.equal(meeting.querySelector(".cc-badge").textContent, "Cancelled");
  assert.equal(view.centralCalendarSpanLabel(eventItem(E_MATCH, DAY(1), {})), "", "a one-day event has no span word");
});

test("1c. the status pill: Planned for a planned item and for an event expecting nothing until its day; device data awaited by name", () => {
  const badge = (item, today = "2026-11-05") => view.centralCalendarStatusBadge(item, today)?.label ?? null;
  assert.equal(badge(eventItem(E_CAMP, "2026-11-05", { status: "none" })), "Planned", "on its day");
  assert.equal(badge(eventItem(E_CAMP, "2026-11-04", { status: "none" })), null, "after its day nothing is waited for");
  assert.equal(badge(eventItem(E_CAMP, "2026-11-06", { status: "none", cancelled: true })), null);
  assert.equal(badge(baseItem({ kind: "activity", status: "none" })), null, "only an event reads Planned on `none`");
  assert.equal(badge(baseItem({ kind: "activity", status: "planned", origin: "api_import" })), null, "an activity of today is recorded, not planned");
  assert.equal(badge(baseItem({ kind: "planned", status: "planned" })), "Planned");
  // The type's word only when the title is not that word already.
  assert.equal(view.centralCalendarKindLabel(eventItem(E_MATCH, DAY(1), { title: "Match", eventKind: "match", eventTypeLabel: "Match", athleteCount: 3 })), "Event · 3 athletes");
  assert.equal(view.centralCalendarKindLabel(eventItem(E_MATCH, DAY(1), { title: null, eventKind: "match", eventTypeLabel: "Match" })), "Event");
  assert.equal(view.centralCalendarKindLabel(baseItem({ kind: "test", athleteCount: 16 })), "Scheduled test · 16 athletes");
  assert.equal(badge(eventItem(E_MATCH, "2026-11-01", { status: "awaiting_entry", expects: ["device_data"] })), "Awaiting device data");
  assert.equal(badge(eventItem(E_MATCH, "2026-11-01", { status: "done", expects: ["rpe"] })), "Done");
});

test("1d. a referenced schedule shown beside the event (scheduleFold: separate): the card and the panel say so, no gap note", async () => {
  const items = [
    ...ITEMS.filter((item) => item.eventId !== E_MATCH),
    eventItem(E_MATCH, DAY(1), { title: "Cup match", eventKind: "match", eventTypeLabel: "Match", teamIds: [U17], athleteCount: 2, expects: ["rpe"], status: "planned", gaps: [], scheduleFold: { external: "separate", test: null } }),
    baseItem({ key: "external:sch-9:d1", kind: "external", date: DAY(1), title: "Cup match RPE", eventType: "match", teamIds: [U17], athleteCount: 18, expects: ["rpe"], status: "planned", rpe: { asked: 18, submitted: 0 } }),
  ];
  installFetchMock(server({ items }));
  await loadCentralCalendar({ render });
  const card = dom().querySelector(`.cc-card[data-key="event:${E_MATCH}:${DAY(1)}"]`);
  assert.equal(card.querySelector(".cc-card-note").textContent, "Linked schedule shown separately");
  assert.match(card.getAttribute("aria-label"), /Linked schedule shown separately/);
  assert.ok(dom().querySelector('.cc-card[data-key="external:sch-9:d1"]'), "the schedule's own card is beside it");
  await act({ action: "central-calendar-open-item", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  const panel = dom().querySelector(".cc-panel").textContent;
  assert.match(panel, /The linked RPE request reaches athletes this event does not list, so it is shown as its own card on this day, with its own counts\./);
  assert.doesNotMatch(panel, /nothing attached to this event asks/);
  assert.equal(view.centralCalendarScheduleSeparate(eventItem(E_MATCH, DAY(1), { scheduleFold: { external: "folded", test: null } })), false);
  assert.equal(view.centralCalendarScheduleSeparate(eventItem(E_MATCH, DAY(1), { scheduleFold: { external: null, test: "separate" } })), true);
});

// --- 2. The Filters panel and the chips -------------------------------------------

test("2a. the Filters panel starts collapsed with one summary line; the chips are in the markup, hidden; the toggle opens it", async () => {
  const calls = installFetchMock(server());
  await loadCentralCalendar({ render });
  let doc = dom();
  const toggle = doc.querySelector('[data-action="central-calendar-toggle-filters"]');
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.querySelector(".cc-filters-summary").textContent, "All groups · all types");
  assert.ok(doc.querySelector("#ccFiltersBody").hasAttribute("hidden"));
  assert.ok(doc.querySelector('#ccFiltersBody [data-action="central-calendar-toggle-team"]'), "the chips stay in the markup");
  await act({ action: "central-calendar-toggle-filters" });
  doc = dom();
  assert.equal(doc.querySelector('[data-action="central-calendar-toggle-filters"]').getAttribute("aria-expanded"), "true");
  assert.equal(doc.querySelector("#ccFiltersBody").hasAttribute("hidden"), false);
  await act({ action: "central-calendar-toggle-team", teamId: U19 });
  await act({ action: "central-calendar-toggle-kind", kind: "event" });
  assert.equal(dom().querySelector(".cc-filters-summary").textContent, "U19 · Events");
  await act({ action: "central-calendar-toggle-team", teamId: U17 });
  await act({ action: "central-calendar-toggle-team", teamId: U13 });
  await act({ action: "central-calendar-toggle-event-kind", eventKind: "match" });
  await act({ action: "central-calendar-toggle-kind", kind: "planned" });
  assert.equal(dom().querySelector(".cc-filters-summary").textContent, "3 groups · Planned training, Match", "Match turned Events off");
  await act({ action: "central-calendar-toggle-kind", kind: "activity" });
  assert.equal(dom().querySelector(".cc-filters-summary").textContent, "3 groups · 3 types");
  assert.equal(rangeReads(calls).length, 1, "no chip sends a request");
});

test("2b. All groups and All types count every card and clear their row; the Types chips name Events and RPE requests (9.10)", async () => {
  installFetchMock(server());
  await loadCentralCalendar({ render });
  let doc = dom();
  const count = (selector) => doc.querySelector(`${selector} .cc-chip-count`).textContent;
  assert.equal(count('[data-action="central-calendar-all-groups"]'), String(ITEMS.length));
  assert.equal(count('[data-action="central-calendar-all-types"]'), String(ITEMS.length));
  assert.equal(doc.querySelector('[data-action="central-calendar-all-groups"]').getAttribute("aria-pressed"), "true");
  assert.equal(count('[data-kind="event"]'), "5");
  assert.equal(doc.querySelector('[data-kind="event"] .cc-chip-label').textContent, "Events");
  assert.equal(doc.querySelector('[data-kind="external"] .cc-chip-label').textContent, "RPE requests");
  assert.equal(doc.querySelector('[data-kind="planned"] .cc-chip-label').textContent, "Planned training");
  assert.ok(doc.querySelector('[data-kind="event"] svg.cc-chip-icon'), "a type chip carries its icon");
  await act({ action: "central-calendar-toggle-team", teamId: U17 });
  doc = dom();
  assert.equal(doc.querySelector('[data-action="central-calendar-all-groups"]').getAttribute("aria-pressed"), "false");
  await act({ action: "central-calendar-all-groups" });
  assert.deepEqual(state.centralCalendar.filters.teamIds, []);
  await act({ action: "central-calendar-toggle-kind", kind: "event" });
  await act({ action: "central-calendar-toggle-event-kind", eventKind: "camp" });
  await act({ action: "central-calendar-all-types" });
  assert.deepEqual(state.centralCalendar.filters, { teamIds: [], kinds: [], eventKinds: [] });
});

test("2c. the Event types chips: one per kind on the displayed days with its icon and count; Events and the event types exclude each other, so every pressed chip changes the list", async () => {
  installFetchMock(server());
  await loadCentralCalendar({ render });
  let doc = dom();
  const chips = [...doc.querySelectorAll('[data-action="central-calendar-toggle-event-kind"]')];
  assert.deepEqual(chips.map((chip) => chip.dataset.eventKind), ["match", "meeting", "camp"], "the kinds present, in D2's order");
  assert.equal(doc.querySelector('[data-event-kind="camp"] .cc-chip-count').textContent, "3");
  assert.equal(doc.querySelector('[data-event-kind="match"] .cc-chip-label').textContent, "Match");
  assert.ok(doc.querySelector('[data-event-kind="match"] svg.cc-chip-icon'));
  const keys = () => [...dom().querySelectorAll(".cc-card")].map((card) => card.dataset.key);
  await act({ action: "central-calendar-toggle-event-kind", eventKind: "match" });
  assert.deepEqual(keys(), [`event:${E_MATCH}:${DAY(1)}`], "Match alone: the matches only");
  await act({ action: "central-calendar-toggle-kind", kind: "planned" });
  assert.deepEqual(keys(), ["planned:batch-1", `event:${E_MATCH}:${DAY(1)}`], "a kind and an event kind add up");
  await act({ action: "central-calendar-toggle-kind", kind: "event" });
  assert.equal(keys().filter((key) => key.startsWith("event:")).length, 5, "Events lets every event through");
  assert.deepEqual(state.centralCalendar.filters.eventKinds, [], "Events clears the event types it covers");
  await act({ action: "central-calendar-toggle-event-kind", eventKind: "camp" });
  assert.deepEqual(state.centralCalendar.filters.kinds, ["planned"], "an event type turns Events off");
  assert.deepEqual(keys(), ["planned:batch-1", ...[2, 3, 4].map((offset) => `event:${E_CAMP}:${DAY(offset)}`)]);
  await act({ action: "central-calendar-toggle-event-kind", eventKind: "bogus" });
  assert.deepEqual(state.centralCalendar.filters.eventKinds, ["camp"], "an unknown kind is ignored");
  assert.equal(dom().querySelector('[data-kind="test"] .cc-chip-label').textContent, "Scheduled tests");
  // A chosen kind keeps its chip even on a week without it.
  state.centralCalendar.filters = { teamIds: [], kinds: [], eventKinds: ["travel"] };
  render();
  doc = dom();
  assert.equal(doc.querySelector('[data-event-kind="travel"] .cc-chip-count').textContent, "0");
  assert.equal(doc.querySelector('[data-event-kind="travel"]').getAttribute("aria-pressed"), "true");
});

test("2d. a week without events has no Event types row; the K1b Types chips keep counting", async () => {
  installFetchMock(server({ items: ITEMS.filter((item) => item.kind !== "event") }));
  await loadCentralCalendar({ render });
  const doc = dom();
  assert.equal(doc.querySelector('[aria-label="Event types"]'), null);
  assert.equal(doc.querySelector('[data-kind="event"] .cc-chip-count').textContent, "0");
});

// --- 3. The selected day and the strip ----------------------------------------------

test("3a. a phone's day: the per-team row (every team, 0 included), the timed cards in the server's order, then No time", async () => {
  layout = "phone";
  installFetchMock(server());
  state.centralCalendar.anchor = DAY(0);
  state.centralCalendar.selectedDate = DAY(0);
  await loadCentralCalendar({ render });
  const doc = dom();
  const row = [...doc.querySelectorAll(".cc-day-teams .cc-team-pill-name")].map((node) => node.textContent);
  assert.deepEqual(row, ["U19 · 3 items", "U17 · 0 items", "U13 · 0 items"]);
  assert.ok(doc.querySelector(".cc-day-teams .cc-team-pill.is-empty"));
  const list = doc.querySelector(".cc-day-list");
  const order = [...list.querySelectorAll(".cc-card, .cc-day-section")].map((node) => (node.classList.contains("cc-day-section") ? `[${node.textContent}]` : node.dataset.key));
  assert.deepEqual(order, ["planned:batch-1", "[No time]", `event:${E_MEETING}:${DAY(0)}`, "activity:act-1"], "a slot counts as a time; the untimed keep their order");
  // The Groups chips choose the teams the row names; one team alone would
  // only repeat the day's count.
  await act({ action: "central-calendar-toggle-team", teamId: U17 });
  await act({ action: "central-calendar-toggle-team", teamId: U13 });
  assert.deepEqual([...dom().querySelectorAll(".cc-day-teams .cc-team-pill-name")].map((node) => node.textContent), ["U17 · 0 items", "U13 · 0 items"]);
  await act({ action: "central-calendar-toggle-team", teamId: U13 });
  assert.equal(dom().querySelector(".cc-day-teams"), null);
});

test("3b. the strip: one team-colour dot per team with a visible card that day, named in the day's label", async () => {
  layout = "phone";
  installFetchMock(server());
  await loadCentralCalendar({ render });
  const doc = dom();
  const day = (offset) => doc.querySelector(`.cc-strip-day[data-date="${DAY(offset)}"]`);
  assert.equal(day(0).querySelectorAll(".cc-strip-dots .cc-team-dot").length, 1);
  assert.match(day(0).querySelector(".cc-strip-dots .cc-team-dot").getAttribute("style"), /--cc-team-0/);
  assert.match(day(1).querySelector(".cc-strip-dots .cc-team-dot").getAttribute("style"), /--cc-team-1/);
  assert.match(day(1).getAttribute("aria-label"), /1 item, U17$/);
  assert.equal(day(5).querySelector(".cc-strip-dots"), null, "an empty day has no dots");
  assert.deepEqual(view.centralCalendarDayTeamIds([{ teamIds: [U13, U19] }, { teamIds: [U17] }], TEAMS), [U19, U17, U13], "in teams[] order");
  assert.deepEqual(view.centralCalendarDayTeamIds([{ teamIds: [U13, U19, U17] }], TEAMS, 2), [U19, U17]);
  // More than four teams on a day: three dots and "+N"; the label names them all.
  const six = Array.from({ length: 6 }, (_, index) => ({ teamId: `t${index}`, name: `G${index}` }));
  state.centralCalendar.data = { ...state.centralCalendar.data, teams: six, days: state.centralCalendar.data.days.map((day) => (day.date === DAY(5) ? { ...day, items: [baseItem({ key: "p:six", date: DAY(5), teamIds: six.map((team) => team.teamId) })] } : day)) };
  render();
  const busy = dom().querySelector(`.cc-strip-day[data-date="${DAY(5)}"]`);
  assert.equal(busy.querySelectorAll(".cc-strip-dots .cc-team-dot").length, 3);
  assert.equal(busy.querySelector(".cc-strip-more").textContent, "+3");
  assert.match(busy.getAttribute("aria-label"), /G0, G1, G2, G3, G4, G5$/);
});

// --- 4. Who sees New event, Edit and Cancel --------------------------------------

test("4a. New event only in a club, team or private-coach workspace; never in the platform workspace", async () => {
  for (const [type, expected] of [["club", true], ["team", true], ["private_coach", true], ["platform", false]]) {
    clearAllViewCache();
    resetCentralCalendarForWorkspaceChange();
    installFetchMock(server({ workspace: { type, scopeId: type === "club" ? CLUB : type === "team" ? U19 : null } }));
    await loadCentralCalendar({ render });
    assert.equal(Boolean(dom().querySelector('[data-action="central-calendar-new-event"]')), expected, `${type}: New event ${expected ? "shown" : "absent"}`);
  }
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  render();
  assert.equal(dom().querySelector('[data-action="central-calendar-new-event"]'), null, "nothing before the answer says the workspace");
});

test("4b. Edit and Cancel event only on an event whose card says canManage and that is not cancelled; the panel shows its facts and gaps", async () => {
  const calls = installFetchMock(server());
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-open-item", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  let doc = dom();
  assert.ok(doc.querySelector('.cc-panel [data-action="central-calendar-edit-event"]'));
  assert.ok(doc.querySelector('.cc-panel [data-action="central-calendar-cancel-event"]'));
  assert.equal(doc.querySelector(".cc-panel-place").textContent, "City stadium");
  assert.match(doc.querySelector(".cc-panel").textContent, /Collects: athletes' RPE\./);
  assert.match(doc.querySelector(".cc-panel-gap").textContent, /RPE is expected, but nothing attached to this event asks the athletes for it yet\./);
  assert.equal(doc.querySelector(".cc-panel-notes-text").textContent, "Bring both kits");
  await act({ action: "central-calendar-open-item", key: `event:${E_CAMP}:${DAY(3)}`, date: DAY(3) });
  doc = dom();
  assert.equal(doc.querySelector('[data-action="central-calendar-edit-event"]'), null, "a reader's event: no write control");
  assert.match(doc.querySelector(".cc-panel").textContent, /Nothing is expected after this event\./);
  assert.doesNotMatch(doc.querySelector(".cc-panel").textContent, /Collects:/, "said once, not twice");
  assert.match(doc.querySelector(".cc-panel").textContent, /\(day 2 of 3\)/);
  await act({ action: "central-calendar-open-item", key: `event:${E_MEETING}:${DAY(0)}`, date: DAY(0) });
  assert.equal(dom().querySelector('[data-action="central-calendar-cancel-event"]'), null, "a cancelled event: nothing to change");
  // The handlers refuse the same events, whatever is clicked.
  await act({ action: "central-calendar-edit-event", key: `event:${E_CAMP}:${DAY(3)}`, date: DAY(3) });
  await act({ action: "central-calendar-cancel-event", key: `event:${E_MEETING}:${DAY(0)}`, date: DAY(0) });
  assert.equal(state.centralCalendar.form, null);
  assert.equal(calls.filter((call) => call.url.startsWith("/api/calendar/events")).length, 0, "not even the event is read");
});

// --- 5. Create --------------------------------------------------------------------

async function openCreate(options) {
  const calls = installFetchMock(server(options));
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-new-event" });
  return calls;
}

test("5a. New event: the form takes the panel's place with the first type, its defaults pre-ticked (D19) and the chosen day", async () => {
  state.centralCalendar.selectedDate = DAY(2);
  const calls = await openCreate();
  const form = state.centralCalendar.form;
  assert.equal(form.mode, "create");
  assert.equal(form.draft.eventTypeId, T_TRAINING);
  assert.equal(form.draft.title, "Training", "the title follows the type until it is typed");
  assert.deepEqual(form.draft.expects, ["rpe"]);
  assert.equal(form.draft.day, DAY(2));
  assert.equal(calls.filter((call) => call.url === "/api/calendar/events/types").length, 1);
  const doc = dom();
  assert.ok(doc.querySelector(".cc-panel [data-cc-event-form]"));
  assert.ok(doc.querySelector(".central-calendar").classList.contains("cc-panel-open"));
  assert.equal(doc.querySelector('[data-cc-event-expect="rpe"]').checked, true);
  assert.equal(doc.querySelector('[data-cc-event-expect="device_data"]').checked, false);
  assert.equal(doc.querySelector('[data-cc-event-expect="test_result"]').checked, false);
  assert.match(doc.querySelector(".cc-fieldset").textContent + doc.body.textContent, /wellness check-in counts as a test/);
  assert.equal(doc.querySelector('[data-action="central-calendar-new-event"]').disabled, true, "one form at a time");
  // A type change re-ticks its defaults; once the coach touched them they stay.
  input({ ccEventField: "eventTypeId" }, { value: T_TEST });
  assert.deepEqual(form.draft.expects, ["test_result"]);
  assert.equal(form.draft.title, "Test");
  input({ ccEventExpect: "device_data" }, { checked: true });
  input({ ccEventField: "eventTypeId" }, { value: T_MEETING });
  assert.deepEqual(form.draft.expects, ["device_data", "test_result"], "touched: the type no longer re-ticks");
  input({ ccEventField: "title" }, { value: "Cup final" });
  input({ ccEventField: "eventTypeId" }, { value: T_MATCH });
  assert.equal(form.draft.title, "Cup final", "a typed title stays");
  // The types are read once per workspace.
  await act({ action: "central-calendar-event-form-close" });
  await act({ action: "central-calendar-new-event" });
  assert.equal(calls.filter((call) => call.url === "/api/calendar/events/types").length, 1);
});

test("5b. a club's form offers the club, its teams and the roster's athletes; a team's its team; a private coach's athletes with Choose all", async () => {
  await openCreate();
  let doc = dom();
  const targets = (d) => [...d.querySelectorAll("[data-cc-event-target]")].map((box) => `${box.dataset.ccEventTarget}:${box.dataset.targetId}`);
  assert.deepEqual(targets(doc), [`club:${CLUB}`, `team:${U19}`, `team:${U17}`, `team:${U13}`]);
  assert.match(doc.querySelector(".cc-fieldset").textContent, /The whole club \(First Club\)/);
  await act({ action: "central-calendar-event-athletes" });
  doc = dom();
  assert.deepEqual(targets(doc).filter((t) => t.startsWith("athlete:")), [`athlete:${A1}`, `athlete:${A2}`, `athlete:${A3}`]);
  input({ ccEventAthleteSearch: "" }, { value: "ana" });
  assert.deepEqual(targets(dom()).filter((t) => t.startsWith("athlete:")), [`athlete:${A2}`], "the search narrows the list");

  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  state.currentUser.activeWorkspace = { type: "team", scopeId: U19, label: "U19" };
  installFetchMock(server({ workspace: { type: "team", scopeId: U19 } }));
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-new-event" });
  assert.deepEqual(state.centralCalendar.form.draft.targets.map((t) => `${t.kind}:${t.id}`), [`team:${U19}`], "a team's own team, preselected");
  assert.deepEqual(targets(dom()), [`team:${U19}`]);

  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  state.currentUser.activeWorkspace = { type: "private_coach", scopeId: null, label: "Private coaching" };
  installFetchMock(server({ workspace: { type: "private_coach", scopeId: null } }));
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-new-event" });
  assert.deepEqual(state.centralCalendar.form.draft.targets, []);
  await act({ action: "central-calendar-event-athletes" });
  await act({ action: "central-calendar-event-all-athletes" });
  assert.deepEqual(state.centralCalendar.form.draft.targets.map((t) => t.id), [A1, A2, A3]);
  assert.equal(dom().querySelector("[data-cc-event-target='club'], [data-cc-event-target='team']"), null, "no club or team for a private coach");
  await act({ action: "central-calendar-event-no-athletes" });
  assert.deepEqual(state.centralCalendar.form.draft.targets, []);
});

test("5c. Create event: one POST with a fresh UUID requestKey and exactly the form's body; the calendar is read again and the event's panel opens", async () => {
  state.centralCalendar.selectedDate = DAY(2);
  state.centralCalendar.filters.teamIds = [U19];
  const calls = await openCreate();
  const form = state.centralCalendar.form;
  assert.deepEqual(form.draft.targets.map((t) => `${t.kind}:${t.id}`), [`team:${U19}`], "the chosen group is the first target");
  input({ ccEventField: "title" }, { value: "  Morning   session " });
  input({ ccEventField: "endDay" }, { value: DAY(3) });
  input({ ccEventField: "startTime" }, { value: "09:00" });
  input({ ccEventField: "endTime" }, { value: "10:30" });
  input({ ccEventField: "location" }, { value: "Hall B" });
  input({ ccEventField: "notes" }, { value: "Line one\nLine two" });
  input({ ccEventExpect: "device_data" }, { checked: true });
  input({ ccEventTarget: "athlete", targetId: A2, targetName: "Ana Test" }, { checked: true });
  await submitCentralCalendarEventForm({ render });
  const writes = writesOf(calls);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "POST");
  assert.equal(writes[0].url, "/api/calendar/events");
  const { requestKey, ...body } = writes[0].body;
  assert.match(requestKey, UUID);
  assert.deepEqual(body, {
    eventTypeId: T_TRAINING, title: "Morning session", day: DAY(2), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    expects: ["rpe", "device_data"], targets: [{ kind: "team", id: U19 }, { kind: "athlete", id: A2 }],
    endDay: DAY(3), startTime: "09:00", endTime: "10:30", location: "Hall B", notes: "Line one\nLine two",
  });
  const cal = state.centralCalendar;
  assert.equal(cal.form, null);
  assert.equal(cal.notice, "“Morning session” was created.");
  assert.deepEqual({ open: cal.panel.open, key: cal.panel.key }, { open: true, key: `event:${E_NEW}:${DAY(2)}` });
  const reads = rangeReads(calls);
  assert.equal(reads.filter((call) => !call.url.includes("include=athletes")).length, 2, "the range is read again after the save");
});

test("5d. the form's own checks: nothing is sent while a field is wrong", async () => {
  const calls = await openCreate();
  const form = state.centralCalendar.form;
  input({ ccEventField: "title" }, { value: "   " });
  input({ ccEventField: "day" }, { value: DAY(3) });
  input({ ccEventField: "endDay" }, { value: DAY(1) });
  input({ ccEventField: "endTime" }, { value: "10:00" });
  input({ ccEventField: "location" }, { value: "x".repeat(121) });
  await submitCentralCalendarEventForm({ render });
  assert.deepEqual(Object.keys(form.errors).sort(), ["endDay", "endTime", "location", "targets", "title"]);
  assert.equal(form.errors.endTime, "An end time needs a start time.");
  assert.equal(form.errors.endDay, "The last day cannot be before the first.");
  assert.equal(form.error, "Check the marked fields.");
  input({ ccEventField: "endDay" }, { value: "" });
  input({ ccEventField: "startTime" }, { value: "11:00" });
  await submitCentralCalendarEventForm({ render });
  assert.equal(form.errors.endTime, "The end must be after the start.");
  assert.equal(writesOf(calls).length, 0);
  const doc = dom();
  assert.equal(doc.querySelector("#ccEvent-title").getAttribute("aria-invalid"), "true");
  assert.equal(doc.querySelector("#ccEvent-title").getAttribute("aria-describedby"), "ccEvent-title-error");
});

// --- 6. The answers of a write ---------------------------------------------------------

function fillValid() {
  input({ ccEventTarget: "team", targetId: U17, targetName: "U17" }, { checked: true });
}

test("6a. a lost answer: Result not confirmed; nothing is sent by itself; Check result sends the SAME key and body; an unsettled check says why; the replay saves", async () => {
  let answers = [{ throwNetworkError: true }, { status: 409, body: { error: "try_again", message: "The event is being changed. Try again." } }];
  const calls = await openCreate({ writes: (call) => answers.shift() || { status: 201, body: { event: eventView({ id: E_NEW, title: call.body.title, day: call.body.day }), replayed: true } } });
  fillValid();
  await submitCentralCalendarEventForm({ render });
  const form = state.centralCalendar.form;
  assert.equal(form.unconfirmed, true);
  assert.equal(form.busy, false);
  let doc = dom();
  assert.match(doc.querySelector(".cc-unconfirmed").textContent, /Result not confirmed/);
  assert.ok(doc.querySelector('[data-action="central-calendar-event-check-result"]'));
  assert.equal(doc.querySelector(".cc-form-fields").disabled, true, "the sent form is locked");
  assert.equal(doc.querySelector('.cc-event-form button[type="submit"]'), null, "no second Create while not confirmed");
  await tick();
  assert.equal(writesOf(calls).length, 1, "never sent again by itself");
  // Typing into the locked form changes nothing.
  input({ ccEventField: "title" }, { value: "Changed" });
  await submitCentralCalendarEventForm({ render });
  assert.equal(writesOf(calls).length, 1);

  await act({ action: "central-calendar-event-check-result" });
  const [first, second] = writesOf(calls);
  assert.deepEqual(second.body, first.body, "the same body, the same requestKey");
  assert.equal(form.unconfirmed, true, "a busy answer comes before the request record: still not confirmed");
  assert.match(form.checkNote, /server was busy/);
  doc = dom();
  assert.match(doc.querySelector(".cc-unconfirmed").textContent, /server was busy/);

  await act({ action: "central-calendar-event-check-result" });
  const third = writesOf(calls)[2];
  assert.equal(third.body.requestKey, first.body.requestKey);
  assert.equal(state.centralCalendar.form, null);
  assert.equal(state.centralCalendar.notice, "Checked: “Training” was created.");
});

test("6b. 503 outcome_unknown and an uncoded 5xx are not confirmed; 500 internal_error and a 409 try_again are stated: the form opens again", async () => {
  for (const answer of [{ status: 503, body: { error: "outcome_unknown", message: "Not sure." } }, { status: 502, text: "<html>Bad gateway</html>", body: null }]) {
    clearAllViewCache();
    resetCentralCalendarForWorkspaceChange();
    await openCreate({ writes: () => answer });
    fillValid();
    await submitCentralCalendarEventForm({ render });
    assert.equal(state.centralCalendar.form.unconfirmed, true, `${answer.status}: not confirmed`);
  }
  for (const [answer, sentence] of [
    [{ status: 500, body: { error: "internal_error", message: "Nothing was saved. Try again." } }, "Nothing was saved. Try again."],
    [{ status: 409, body: { error: "try_again", message: "The event is being changed. Try again." } }, "The calendar is busy. Nothing was saved; try again in a moment."],
  ]) {
    clearAllViewCache();
    resetCentralCalendarForWorkspaceChange();
    const calls = await openCreate({ writes: () => answer });
    fillValid();
    await submitCentralCalendarEventForm({ render });
    const form = state.centralCalendar.form;
    assert.equal(form.unconfirmed, false);
    assert.equal(form.error, sentence);
    const firstKey = writesOf(calls)[0].body.requestKey;
    await submitCentralCalendarEventForm({ render });
    assert.notEqual(writesOf(calls)[1].body.requestKey, firstKey, "a new send has a new key; only Check result reuses one");
  }
});

test("6c. a stated refusal: its sentence on the field, nothing re-read, the form keeps every value", async () => {
  const calls = await openCreate({ writes: () => ({ status: 400, body: { error: "target_not_available", message: "One of the chosen targets is not available in this workspace." } }) });
  fillValid();
  input({ ccEventField: "location" }, { value: "Hall B" });
  const readsBefore = rangeReads(calls).length;
  await submitCentralCalendarEventForm({ render });
  const form = state.centralCalendar.form;
  assert.ok(form, "the form stays");
  assert.equal(form.error, "Check the marked fields. Nothing was saved.");
  assert.equal(form.errors.targets, "One of the chosen groups or athletes is not available in this workspace on that day.");
  assert.equal(form.draft.location, "Hall B");
  assert.equal(rangeReads(calls).length, readsBefore, "nothing changed, nothing is read again");
  assert.match(dom().querySelector(".cc-panel").textContent, /not available in this workspace on that day/);
});

test("6d. 403 workspace_required and a create's 404 read as sentences, never the server's text", async () => {
  await openCreate({ writes: () => ({ status: 403, body: { error: "workspace_required", message: "Open the club's workspace to create or change its events." } }) });
  fillValid();
  await submitCentralCalendarEventForm({ render });
  assert.equal(state.centralCalendar.form.error, "Open the club's workspace to create or change its events. Nothing was saved.");
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  await openCreate({ writes: () => NOT_FOUND });
  fillValid();
  await submitCentralCalendarEventForm({ render });
  assert.equal(state.centralCalendar.form, null);
  assert.equal(state.centralCalendar.notice, "Events cannot be created in this workspace now. Nothing was saved.");
  assert.doesNotMatch(rendered, /Not found\./);
});

test("6e. the types cannot be read: a forbidden workspace says so without a retry; a failed read offers Try again", async () => {
  await openCreate({ types: () => ({ status: 403, body: { error: "Forbidden" } }) });
  assert.equal(state.centralCalendar.form.loadError, "Events cannot be created in this workspace.");
  assert.equal(dom().querySelector('[data-action="central-calendar-event-form-retry"]'), null);
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  let fail = true;
  const calls = await openCreate({ types: () => (fail ? { throwNetworkError: true } : { status: 200, body: { types: TYPES } }) });
  assert.equal(state.centralCalendar.form.loadError, "The event types could not be read.");
  fail = false;
  await act({ action: "central-calendar-event-form-retry" });
  assert.equal(state.centralCalendar.form.loadError, "");
  assert.equal(state.centralCalendar.form.draft.eventTypeId, T_TRAINING);
  assert.equal(calls.filter((call) => call.url === "/api/calendar/events/types").length, 2);
});

test("6f. a create saved but its answer lost: Check result replays the SAME key, the server writes nothing twice (one event), the panel opens on it", async () => {
  const fake = server({ loseFirstAnswer: true });
  const calls = installFetchMock(fake);
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-new-event" });
  fillValid();
  await submitCentralCalendarEventForm({ render });
  assert.equal(state.centralCalendar.form.unconfirmed, true);
  assert.equal(fake.live.filter((item) => item.eventId === E_NEW).length, 1, "the first write landed");
  await act({ action: "central-calendar-event-check-result" });
  const [first, second] = writesOf(calls);
  assert.equal(second.body.requestKey, first.body.requestKey);
  assert.equal(fake.live.filter((item) => item.eventId === E_NEW).length, 1, "the replay wrote nothing");
  assert.equal(state.centralCalendar.notice, "Checked: “Training” was created.");
  assert.equal(state.centralCalendar.panel.key, `event:${E_NEW}:${TODAY}`, "the event's panel, from the calendar read again");
  // The fake keeps the contract: the same key with another body is refused.
  assert.equal(fake({ url: "/api/calendar/events", method: "POST", body: { ...first.body, title: "Other" } }).status, 409);
});

test("6g. leaving a result not confirmed reads the calendar again at once and says where Check result is before creating it again", async () => {
  const fake = server({ loseFirstAnswer: true });
  const calls = installFetchMock(fake);
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-new-event" });
  input({ ccEventField: "title" }, { value: "Cup final" });
  fillValid();
  await submitCentralCalendarEventForm({ render });
  const reads = rangeReads(calls).length;
  confirmAnswer = true;
  await act({ action: "central-calendar-event-form-close" });
  await tick();
  assert.match(questions.at(-1), /not confirmed/);
  assert.equal(state.centralCalendar.form, null);
  assert.equal(rangeReads(calls).length, reads + 1, "read again, never the cached answer from before the write");
  assert.equal(state.centralCalendar.notice, "The result of “Cup final” is not confirmed. The calendar was read again. New event offers Check result first: use it before creating the event again.");
  assert.ok(dom().querySelector(`.cc-card[data-key="event:${E_NEW}:${TODAY}"]`), "the event that landed is on screen");
  assert.equal(centralCalendarUncertainWrites().length, 1, "the write waits to be checked");
});

test("6h. an answer that arrives after the coach left the saving form settles it: the calendar is read again and the line says what happened", async () => {
  let release;
  const calls = installFetchMock(server({ writes: () => new Promise((resolve) => { release = resolve; }) }));
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-new-event" });
  fillValid();
  const sending = submitCentralCalendarEventForm({ render });
  confirmAnswer = true;
  closeCentralCalendarPanel(render);
  await tick();
  const reads = rangeReads(calls).length;
  release({ status: 201, body: { event: eventView({ id: E_NEW, title: "Training", day: TODAY }) } });
  await sending;
  await tick();
  assert.ok(rangeReads(calls).length > reads, "the late success is read, not dropped");
  assert.equal(state.centralCalendar.form, null);
  assert.equal(state.centralCalendar.notice, "“Training” was created.", "the late answer's line, never the leave's 'not confirmed'");
  assert.deepEqual(centralCalendarUncertainWrites(), [], "settled: nothing waits to be checked");
  await act({ action: "central-calendar-new-event" });
  assert.equal(state.centralCalendar.form.pending, undefined, "New event opens the plain form again");
});

test("6k. leaving a result not confirmed by opening another card paints the read again with its line", async () => {
  const calls = installFetchMock(server({ loseFirstAnswer: true }));
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-new-event" });
  fillValid();
  await submitCentralCalendarEventForm({ render });
  const reads = rangeReads(calls).filter((call) => !call.url.includes("include=athletes")).length;
  confirmAnswer = true;
  await act({ action: "central-calendar-open-item", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  await tick();
  assert.equal(rangeReads(calls).filter((call) => !call.url.includes("include=athletes")).length, reads + 1);
  assert.match(rendered, /is not confirmed\. The calendar was read again\./, "painted, not only in state");
  assert.equal(state.centralCalendar.panel.key, `event:${E_MATCH}:${DAY(1)}`);
});

test("6i. Enter in the athlete search never submits the form; elsewhere Enter is left alone", () => {
  const prevented = (target) => {
    const event = { key: "Enter", target, preventDefault() { this.done = true; } };
    handleCentralCalendarKeydown(event);
    return Boolean(event.done);
  };
  assert.equal(prevented({ matches: (selector) => selector === "[data-cc-event-athlete-search]" }), true);
  assert.equal(prevented({ matches: () => false }), false, "Enter in the title still saves, as in every form");
  const other = { key: "a", target: { matches: () => true }, preventDefault() { this.done = true; } };
  handleCentralCalendarKeydown(other);
  assert.equal(other.done, undefined);
  // A phone's Search key also puts the keyboard away.
  let blurred = false;
  globalThis.window.matchMedia = (query) => ({ matches: query === "(pointer: coarse)" });
  try {
    handleCentralCalendarKeydown({ key: "Enter", target: { matches: () => true, blur: () => { blurred = true; } }, preventDefault() {} });
  } finally {
    delete globalThis.window.matchMedia;
  }
  assert.equal(blurred, true);
});

test("6j. typing in the athlete search redraws only the list: the input itself is never replaced", async () => {
  await openCreate();
  await act({ action: "central-calendar-event-athletes" });
  const list = { innerHTML: "" };
  const original = globalThis.document.querySelector;
  globalThis.document.querySelector = (selector) => (selector === "#ccEventAthleteList" ? list : null);
  const before = rendered;
  try {
    input({ ccEventAthleteSearch: "" }, { value: "luk" });
  } finally {
    globalThis.document.querySelector = original;
  }
  assert.equal(rendered, before, "no full repaint while typing");
  assert.match(list.innerHTML, /Luka Test/);
  assert.doesNotMatch(list.innerHTML, /Ana Test/);
  assert.equal(state.centralCalendar.form.athleteQuery, "luk");
  assert.match(rendered, /enterkeyhint="search"/);
});

// --- 7. Edit -----------------------------------------------------------------------------

async function openEdit(options) {
  const calls = installFetchMock(server(options));
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-open-item", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  await act({ action: "central-calendar-edit-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  return calls;
}

test("7a. Edit reads the event, fills the form, and PATCHes only what changed with expectedRevision", async () => {
  const calls = await openEdit();
  const form = state.centralCalendar.form;
  assert.equal(form.mode, "edit");
  assert.equal(calls.filter((call) => call.url === `/api/calendar/events/${E_MATCH}`).length, 1);
  assert.equal(form.draft.title, "Cup match");
  assert.equal(form.draft.notes, "Bring both kits");
  assert.deepEqual(form.draft.targets.map((t) => `${t.kind}:${t.id}`), [`team:${U17}`]);
  assert.equal(dom().querySelector("#ccEvent-title").value, "Cup match");
  await submitCentralCalendarEventForm({ render });
  assert.equal(form.error, "Nothing changed: change a field, or Close.");
  assert.equal(writesOf(calls).length, 0);
  input({ ccEventField: "title" }, { value: "Cup final" });
  input({ ccEventField: "endTime" }, { value: "" });
  input({ ccEventTarget: "team", targetId: U19, targetName: "U19" }, { checked: true });
  await submitCentralCalendarEventForm({ render });
  const [write] = writesOf(calls);
  assert.equal(write.method, "PATCH");
  assert.equal(write.url, `/api/calendar/events/${E_MATCH}`);
  const { requestKey, ...body } = write.body;
  assert.match(requestKey, UUID);
  assert.deepEqual(body, { expectedRevision: 2, title: "Cup final", endTime: null, targets: [{ kind: "team", id: U17 }, { kind: "team", id: U19 }] });
  assert.equal(state.centralCalendar.notice, "Changes to “Cup final” were saved.");
  assert.equal(state.centralCalendar.panel.key, `event:${E_MATCH}:${DAY(1)}`);
});

test("7b. event_changed and event_cancelled close the form with their sentence and read the calendar again", async () => {
  for (const [code, sentence] of [
    ["event_changed", "Nothing was saved: this event was changed meanwhile. It is shown as it is now; make your change again."],
    ["event_cancelled", "Nothing was saved: this event was cancelled meanwhile and can no longer be changed."],
  ]) {
    clearAllViewCache();
    resetCentralCalendarForWorkspaceChange();
    const calls = await openEdit({ writes: () => ({ status: 409, body: { error: code, message: "x", current: eventView({ revision: 3 }) } }) });
    const reads = rangeReads(calls).length;
    input({ ccEventField: "title" }, { value: "Cup final" });
    await submitCentralCalendarEventForm({ render });
    assert.equal(state.centralCalendar.form, null);
    assert.equal(state.centralCalendar.notice, sentence);
    assert.ok(rangeReads(calls).length > reads, "the calendar is read again");
    assert.equal(state.centralCalendar.panel.key, `event:${E_MATCH}:${DAY(1)}`, "the event's panel shows it as it is");
  }
});

test("7c. a stranger's 404 on Edit (the identical body) closes with the neutral sentence; a reader's view is not edited", async () => {
  await openEdit({ event: () => NOT_FOUND });
  assert.equal(state.centralCalendar.form, null);
  assert.equal(state.centralCalendar.notice, "This event is no longer available in this workspace.");
  assert.doesNotMatch(rendered, /Not found\./);
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  await openEdit({ event: () => ({ status: 200, body: { event: { ...eventView(), canManage: false, notes: undefined } } }) });
  assert.equal(state.centralCalendar.form, null);
  assert.equal(state.centralCalendar.notice, "This event can no longer be changed in this workspace.");
});

test("7d. in the platform workspace (support) the type and the targets are read-only and never sent", async () => {
  state.currentUser.activeWorkspace = { type: "platform", scopeId: null, label: "Platform administration" };
  const calls = await openEdit({ workspace: { type: "platform", scopeId: null }, types: TYPES.map((type) => ({ ...type, id: `${type.id.slice(0, -1)}9`, ownerScope: "system" })) });
  const form = state.centralCalendar.form;
  assert.equal(form.readOnlyType, true);
  assert.equal(form.readOnlyTargets, true);
  const doc = dom();
  assert.equal(doc.querySelector("#ccEvent-eventTypeId"), null);
  assert.equal(doc.querySelector("[data-cc-event-target]"), null);
  assert.match(doc.querySelector(".cc-fieldset-static").textContent, /U17/);
  input({ ccEventField: "location" }, { value: "Away ground" });
  await submitCentralCalendarEventForm({ render });
  const { requestKey, ...body } = writesOf(calls)[0].body;
  assert.deepEqual(body, { expectedRevision: 2, location: "Away ground" });
});

test("7e. a failed types read on Edit keeps the type as it is and says why, never that it belongs to another workspace", async () => {
  await openEdit({ types: () => ({ throwNetworkError: true }) });
  const form = state.centralCalendar.form;
  assert.equal(form.readOnlyType, true);
  const text = dom().querySelector(".cc-event-form").textContent;
  assert.match(text, /The event types could not be read\. Close and open Edit again to change the type\./);
  assert.doesNotMatch(text, /own workspace/);
});

// --- 8. Cancel ------------------------------------------------------------------------------

test("8a. Cancel event asks first, naming the event and its day; the POST carries requestKey, expectedRevision and the reason", async () => {
  const calls = installFetchMock(server());
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-open-item", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  await act({ action: "central-calendar-cancel-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  const doc = dom();
  assert.equal(doc.querySelector("#ccPanelTitle").textContent, "Cancel this event?");
  assert.match(doc.querySelector(".cc-cancel-name").textContent, /Cup match/);
  assert.match(doc.querySelector(".cc-cancel-name").textContent, new RegExp(view.centralCalendarLongDate(DAY(1))));
  assert.ok(doc.querySelector('[data-action="central-calendar-event-form-close"]'), "Keep event");
  assert.equal(writesOf(calls).length, 0, "nothing is sent before the confirmation");
  input({ ccEventField: "reason" }, { value: "  Pitch closed " });
  await submitCentralCalendarEventForm({ render });
  const [write] = writesOf(calls);
  assert.equal(write.url, `/api/calendar/events/${E_MATCH}/cancel`);
  assert.equal(write.method, "POST");
  const { requestKey, ...body } = write.body;
  assert.match(requestKey, UUID);
  assert.deepEqual(body, { expectedRevision: 2, reason: "Pitch closed" });
  assert.equal(state.centralCalendar.notice, "“Cup match” was cancelled.");
});

test("8b. Keep event closes the confirmation and the event's panel is there again; a 404 on the cancel is the neutral sentence", async () => {
  installFetchMock(server({ writes: () => NOT_FOUND }));
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-open-item", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  await act({ action: "central-calendar-cancel-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  await act({ action: "central-calendar-event-form-close" });
  assert.equal(state.centralCalendar.form, null);
  assert.equal(dom().querySelector("#ccPanelTitle").textContent, "Cup match");
  await act({ action: "central-calendar-cancel-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  await submitCentralCalendarEventForm({ render });
  assert.equal(state.centralCalendar.notice, "This event is no longer available in this workspace.");
});

test("8c. a refusal naming a field the form does not show is the form's own line: a support edit that moves the day, whose targets the server judges again", async () => {
  state.currentUser.activeWorkspace = { type: "platform", scopeId: null, label: "Platform administration" };
  // updateEvent re-judges the existing targets on a new day (calendarEventService.js): reachable.
  await openEdit({ workspace: { type: "platform", scopeId: null }, writes: () => ({ status: 400, body: { error: "target_not_available", message: "x" } }) });
  input({ ccEventField: "day" }, { value: DAY(2) });
  await submitCentralCalendarEventForm({ render });
  const form = state.centralCalendar.form;
  assert.deepEqual(form.errors, {}, "the targets are read-only here: nothing to mark");
  assert.equal(form.error, "One of the chosen groups or athletes is not available in this workspace on that day. Nothing was saved.");
  assert.doesNotMatch(dom().querySelector(".cc-panel").textContent, /Check the marked fields/);
});

test("8d. cancelling a multi-day event from one day's card says that every day is cancelled; never that the athletes are told", async () => {
  installFetchMock(server({ items: ITEMS.map((item) => (item.eventId === E_CAMP ? { ...item, canManage: true } : item)) }));
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-cancel-event", key: `event:${E_CAMP}:${DAY(3)}`, date: DAY(3) });
  const text = dom().querySelector(".cc-panel").textContent;
  assert.match(text, /This cancels all 3 days\. To drop only some days, use Edit and change its dates instead\./);
  assert.match(text, /OptiMove does not tell the athletes: let them know yourself\./);
  assert.match(text, new RegExp(`${view.centralCalendarLongDate(DAY(2))} - ${view.centralCalendarLongDate(DAY(4))}`));
});

// --- 9. Leaving --------------------------------------------------------------------------------

test("9a. a form with unsaved values asks before another item, Escape and a workspace switch; a No keeps it", async () => {
  await openCreate();
  assert.equal(centralCalendarMayBeLeft(), true, "an untouched form leaves quietly");
  input({ ccEventField: "title" }, { value: "Something" });
  confirmAnswer = false;
  await act({ action: "central-calendar-open-item", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  assert.ok(state.centralCalendar.form, "declined: the form stays");
  assert.equal(state.centralCalendar.panel.open, false);
  assert.equal(closeCentralCalendarPanel(render), CENTRAL_CALENDAR_STAYED, "Escape / Back is handled, and Back is told the form stayed");
  assert.ok(state.centralCalendar.form);
  assert.equal(centralCalendarMayBeLeft(), false);
  assert.deepEqual(questions, ["Discard the new event you have not saved?", "Discard the new event you have not saved?", "Discard the new event you have not saved?"]);
  const unload = { preventDefault() { this.prevented = true; }, returnValue: undefined };
  assert.equal(handleCentralCalendarBeforeUnload(unload), true);
  assert.equal(unload.prevented, true);
  confirmAnswer = true;
  await act({ action: "central-calendar-open-item", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  assert.equal(state.centralCalendar.form, null);
  assert.equal(state.centralCalendar.panel.key, `event:${E_MATCH}:${DAY(1)}`);
  assert.equal(handleCentralCalendarBeforeUnload({ preventDefault() {} }), false, "nothing to protect any more");
});

test("9b. a save in flight and a result not confirmed ask with their own words", async () => {
  let release;
  await openCreate({ writes: () => new Promise((resolve) => { release = resolve; }) });
  fillValid();
  const sending = submitCentralCalendarEventForm({ render });
  assert.equal(state.centralCalendar.form.busy, true);
  confirmAnswer = false;
  assert.equal(centralCalendarMayBeLeft(), false);
  assert.match(questions.at(-1), /still being saved/);
  release({ throwNetworkError: true });
  await sending;
  assert.equal(centralCalendarMayBeLeft(), false);
  assert.match(questions.at(-1), /not confirmed/);
});

test("9c. a cancel confirmation with a typed reason asks before Escape; an untouched one leaves quietly", async () => {
  installFetchMock(server());
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-cancel-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  assert.equal(centralCalendarMayBeLeft(), true);
  input({ ccEventField: "reason" }, { value: "Rain" });
  confirmAnswer = false;
  assert.equal(closeCentralCalendarPanel(render), CENTRAL_CALENDAR_STAYED);
  assert.ok(state.centralCalendar.form, "declined: the confirmation stays");
  assert.deepEqual(questions, ["Discard the reason you have typed?"]);
  confirmAnswer = true;
  assert.equal(closeCentralCalendarPanel(render), true, "accepted: closed");
  assert.equal(state.centralCalendar.form, null);
});

// --- 10. The markup's rules ---------------------------------------------------------------------

test("10a. no data-tab anywhere, every control a button or a labelled field; the form's fields are 16 px and the chips 13 px", async () => {
  await openCreate();
  await act({ action: "central-calendar-event-athletes" });
  await act({ action: "central-calendar-toggle-filters" });
  assert.doesNotMatch(rendered, /data-tab\b/, "app.js hijacks any data-tab");
  const doc = dom();
  for (const node of doc.querySelectorAll("[data-action]")) assert.equal(node.tagName, "BUTTON", `${node.dataset.action} is a button`);
  for (const field of doc.querySelectorAll(".cc-event-form input, .cc-event-form select, .cc-event-form textarea")) {
    assert.ok(field.closest("label"), `${field.id || field.dataset.ccFocus} sits in its label`);
  }
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const block = css.slice(css.indexOf("Central calendar (K2a-2)"));
  assert.match(block, /\.cc-event-form input:not\(\[type="checkbox"\]\),\n\.cc-event-form select,\n\.cc-event-form textarea \{[^}]*font-size: 16px;[^}]*min-height: 44px;|\.cc-event-form textarea \{[^}]*min-height: 44px;[^}]*font-size: 16px;/);
  assert.match(block, /\.cc-chip \{\n  gap: 6px;\n  padding: 0 10px;\n  font-size: 13px;\n\}/);
  assert.match(block, /\.cc-check \{[^}]*min-height: 44px;/);
  assert.match(block, /\.cc-check-list \{\n  display: grid;\n\}/, "no scroller of its own inside the panel or the sheet");
  assert.match(block, /\.cc-form-grid \{[^}]*align-items: start;/);
  assert.match(block, /@media \(min-width: 1024px\) and \(pointer: fine\) \{\n  \.cc-chip \{\n    min-height: 36px;/, "the compact chip only on a pointer screen");
  assert.match(block, /\.cc-refresh-note,\n\.cc-unconfirmed,\n\.cc-unconfirmed \.cc-panel-note,\n\.cc-panel-kind,\n\.cc-panel-when,\n\.cc-panel-note,\n\.cc-panel-sentence \{\n  min-width: 0;\n  overflow-wrap: anywhere;\n\}/, "a long title without a space wraps in every line and in the pending check (the review's MEDIUM-A)");
});

// --- 11. The independent review of PR #306 -------------------------------------------------------

// The fake server behind a switch that takes the calendar read down (the
// writes still answer): the reviewer's repro of HIGH-1.
function withReadDown(fake) {
  const control = { down: false };
  const calls = installFetchMock((call) => (control.down && call.url.startsWith("/api/calendar?") ? { throwNetworkError: true } : fake(call)));
  return { calls, control };
}

test("11a. HIGH-1: the create was saved, its answer lost and the calendar read fails on leaving - the line says the calendar was NOT read; New event offers Check the earlier result with the SAME key and body, never by itself", async () => {
  const fake = server({ loseFirstAnswer: true });
  const { calls, control } = withReadDown(fake);
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-new-event" });
  input({ ccEventField: "title" }, { value: "Cup final" });
  fillValid();
  await submitCentralCalendarEventForm({ render });
  assert.equal(state.centralCalendar.form.unconfirmed, true);
  assert.equal(fake.live.filter((item) => item.eventId === E_NEW).length, 1, "the server saved it");
  control.down = true;
  await act({ action: "central-calendar-event-form-close" });
  await tick();
  assert.match(state.centralCalendar.refreshError, /Showing the last loaded calendar/);
  assert.equal(state.centralCalendar.notice, "The result of “Cup final” is not confirmed, and the calendar could not be read again, so it may not show the result yet. New event offers Check result first: use it before creating the event again.");
  assert.doesNotMatch(state.centralCalendar.notice, /was read again/);
  assert.equal(dom().querySelector(`.cc-card[data-key="event:${E_NEW}:${TODAY}"]`), null, "the saved event is not on screen: the read failed");
  assert.equal(writesOf(calls).length, 1);
  await tick();
  assert.equal(writesOf(calls).length, 1, "nothing is sent by itself");
  // New event: the earlier result first - no fields, the same request.
  await act({ action: "central-calendar-new-event" });
  const form = state.centralCalendar.form;
  assert.equal(form.pending, true);
  assert.equal(form.mode, "create");
  const panel = dom().querySelector(".cc-panel");
  assert.equal(panel.querySelector("#ccPanelTitle").textContent, "Check the earlier result");
  assert.match(panel.textContent, /A new event “Cup final” on .+ was sent, but its answer was lost: it is not known whether it was created\./);
  assert.equal(panel.querySelector(".cc-event-form"), null, "nothing to edit");
  assert.equal(writesOf(calls).length, 1, "opening it sends nothing");
  control.down = false;
  await act({ action: "central-calendar-event-check-result" });
  const [first, second] = writesOf(calls);
  assert.equal(second.body.requestKey, first.body.requestKey, "the SAME key");
  assert.deepEqual(second.body, first.body, "the SAME body");
  assert.equal(fake.live.filter((item) => item.eventId === E_NEW).length, 1, "one event, never a duplicate");
  assert.equal(state.centralCalendar.notice, "Checked: “Cup final” was created.");
  assert.deepEqual(centralCalendarUncertainWrites(), [], "settled: no longer waited for");
  await act({ action: "central-calendar-close-panel" });
  await act({ action: "central-calendar-new-event" });
  assert.equal(state.centralCalendar.form.pending, undefined, "New event opens the plain form again");
});

test("11b. HIGH-1: an edit left unconfirmed gates that event's Edit and Cancel (not New event); a settled refusal on the check forgets it and says so", async () => {
  const answers = [{ throwNetworkError: true }, { status: 409, body: { error: "event_changed", message: "Changed.", current: { revision: 3 } } }];
  const items = ITEMS.map((item) => (item.eventId === E_CAMP ? { ...item, canManage: true } : item));
  const calls = await openEdit({ items, writes: () => answers.shift() });
  input({ ccEventField: "title" }, { value: "Cup final" });
  await submitCentralCalendarEventForm({ render });
  assert.equal(state.centralCalendar.form.unconfirmed, true);
  await act({ action: "central-calendar-event-form-close" });
  await tick();
  assert.match(state.centralCalendar.notice, /^The result of the change to “Cup match” is not confirmed\. The calendar was read again\. The event's Edit and Cancel offer Check result first/);
  for (const action of ["central-calendar-edit-event", "central-calendar-cancel-event"]) {
    await act({ action, key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
    assert.equal(state.centralCalendar.form.pending, true, `${action} opens the check first`);
    assert.equal(state.centralCalendar.form.mode, "edit");
    assert.match(dom().querySelector(".cc-panel").textContent, /A change to “Cup match” was sent/);
    await act({ action: "central-calendar-event-form-close" });
    assert.equal(state.centralCalendar.form, null, "a pending check closes without a question and stays waiting");
    assert.equal(centralCalendarUncertainWrites().length, 1);
  }
  await act({ action: "central-calendar-new-event" });
  assert.equal(state.centralCalendar.form.pending, undefined, "no create waits: New event is the plain form");
  await act({ action: "central-calendar-event-form-close" });
  await act({ action: "central-calendar-cancel-event", key: `event:${E_CAMP}:${DAY(3)}`, date: DAY(3) });
  assert.equal(state.centralCalendar.form.mode, "cancel");
  assert.equal(state.centralCalendar.form.pending, undefined, "another event's Cancel is its plain confirmation");
  await act({ action: "central-calendar-event-form-close" });
  const reads = calls.filter((call) => call.url === `/api/calendar/events/${E_MATCH}`).length;
  await act({ action: "central-calendar-edit-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  assert.equal(calls.filter((call) => call.url === `/api/calendar/events/${E_MATCH}`).length, reads, "the check reads nothing first");
  await act({ action: "central-calendar-event-check-result" });
  const [first, second] = writesOf(calls);
  assert.deepEqual(second.body, first.body, "the SAME body and key");
  assert.equal(second.url, first.url);
  assert.equal(second.method, "PATCH");
  assert.equal(state.centralCalendar.notice, "Checked: The change to “Cup match” was not saved. The event was changed meanwhile; make your change again.");
  assert.deepEqual(centralCalendarUncertainWrites(), []);
});

test("11c. HIGH-1: a check that does not settle keeps it waiting; Forget it asks with the duplicate's risk, a No keeps it, a Yes lets New event open the plain form", async () => {
  const answers = [{ throwNetworkError: true }, { status: 503, body: { error: "try_again", message: "Busy." } }];
  const calls = await openCreate({ writes: () => answers.shift() || { throwNetworkError: true } });
  fillValid();
  await submitCentralCalendarEventForm({ render });
  await act({ action: "central-calendar-event-form-close" });
  await tick();
  await act({ action: "central-calendar-new-event" });
  await act({ action: "central-calendar-event-check-result" });
  assert.equal(state.centralCalendar.form.pending, true, "busy: still not confirmed");
  assert.match(state.centralCalendar.form.checkNote, /server was busy/);
  assert.equal(centralCalendarUncertainWrites().length, 1);
  confirmAnswer = false;
  await act({ action: "central-calendar-event-forget" });
  assert.match(questions.at(-1), /If the event was created, creating it again makes a second one/);
  assert.equal(state.centralCalendar.form.pending, true, "a No keeps the check");
  confirmAnswer = true;
  await act({ action: "central-calendar-event-forget" });
  assert.equal(state.centralCalendar.form, null);
  assert.deepEqual(centralCalendarUncertainWrites(), []);
  await act({ action: "central-calendar-new-event" });
  assert.equal(state.centralCalendar.form.pending, undefined);
  assert.equal(writesOf(calls).length, 2, "forgetting sends nothing");
});

test("11d. HIGH-1: a write waiting to be checked belongs to its sign-in and workspace - never shown or offered in another club, back on returning", async () => {
  installFetchMock(server({ loseFirstAnswer: true }));
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-new-event" });
  fillValid();
  await submitCentralCalendarEventForm({ render });
  await act({ action: "central-calendar-event-form-close" });
  await tick();
  render();
  assert.match(dom().querySelector(".cc-uncertain-line").textContent, /1 save of an event is not confirmed\./);
  const OTHER = "c2c2c2c2-0000-4000-8000-000000000002";
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: OTHER, label: "Other Club" } };
  resetCentralCalendarForWorkspaceChange();
  clearAllViewCache();
  installFetchMock(server({ workspace: { type: "club", scopeId: OTHER } }));
  await loadCentralCalendar({ render });
  assert.deepEqual(centralCalendarUncertainWrites(), []);
  assert.equal(dom().querySelector(".cc-uncertain-line"), null);
  await act({ action: "central-calendar-new-event" });
  assert.equal(state.centralCalendar.form.pending, undefined, "the other club's New event is the plain form");
  await act({ action: "central-calendar-event-form-close" });
  confirmAnswer = false;
  assert.equal(centralCalendarMayBeLeft({ final: true }), false, "a sign-out from the other club still asks: it drops the first club's write too");
  assert.match(questions.at(-1), /It cannot be checked after signing out\./);
  state.currentUser = { id: "coach-2", activeWorkspace: { type: "club", scopeId: CLUB, label: "First Club" } };
  assert.deepEqual(centralCalendarUncertainWrites(), [], "another sign-in never sees it");
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: CLUB, label: "First Club" } };
  assert.equal(centralCalendarUncertainWrites().length, 1, "back in its own club: still waiting");
});

test("11e. HIGH-1: the screen's line opens the check of its write; it hides while a form holds the panel", async () => {
  await openCreate({ writes: () => ({ throwNetworkError: true }) });
  input({ ccEventField: "title" }, { value: "<b>Final</b>" });
  fillValid();
  await submitCentralCalendarEventForm({ render });
  await act({ action: "central-calendar-event-form-close" });
  await tick();
  const line = dom().querySelector(".cc-uncertain-line");
  const button = line.querySelector('[data-action="central-calendar-event-pending"]');
  assert.equal(button.textContent, "Check “<b>Final</b>”", "the title as text");
  assert.equal(line.querySelector("b"), null);
  await act({ action: "central-calendar-event-pending", requestKey: button.dataset.requestKey });
  assert.equal(state.centralCalendar.form.pending, true);
  assert.equal(dom().querySelector(".cc-uncertain-line"), null, "hidden while the form is open");
});

test("11f. HIGH-1 (a): event_changed whose read again fails never says 'shown as it is now'; a success whose read fails says the calendar may not show it", async () => {
  let ctl = withReadDown(server({ writes: () => ({ status: 409, body: { error: "event_changed", message: "Changed.", current: { revision: 3 } } }) }));
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-open-item", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  await act({ action: "central-calendar-edit-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  input({ ccEventField: "title" }, { value: "Cup final" });
  ctl.control.down = true;
  await submitCentralCalendarEventForm({ render });
  assert.equal(state.centralCalendar.notice, "Nothing was saved: this event was changed meanwhile, and the calendar could not be read again. Read it again to see the event as it is now before changing it.");
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  ctl = withReadDown(server());
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-new-event" });
  fillValid();
  ctl.control.down = true;
  await submitCentralCalendarEventForm({ render });
  assert.equal(state.centralCalendar.notice, "“Training” was created. The calendar could not be read again, so it may not show this yet.");
});

test("11g. MEDIUM-1: a deliberate navigation (sign-out, an athlete-workspace switch) is never asked again on unload; sign-out asks before its logout request", async () => {
  let release;
  await openCreate({ writes: () => new Promise((resolve) => { release = resolve; }) });
  fillValid();
  const sending = submitCentralCalendarEventForm({ render });
  const unload = { isTrusted: true, preventDefault() { this.prevented = true; } };
  assert.equal(handleCentralCalendarBeforeUnload(unload), true, "a save in flight is protected");
  state.deliberateNavigation = true;
  const deliberate = { isTrusted: true, preventDefault() { this.prevented = true; } };
  assert.equal(handleCentralCalendarBeforeUnload(deliberate), false);
  assert.equal(deliberate.prevented, undefined);
  state.deliberateNavigation = false;
  confirmAnswer = false;
  assert.equal(centralCalendarMayBeLeft({ final: true }), false);
  assert.match(questions.at(-1), /^An event is still being saved\. Sign out anyway\? .*It cannot be checked after signing out\./);
  release({ throwNetworkError: true });
  await sending;
  confirmAnswer = true;
  await act({ action: "central-calendar-event-form-close" });
  await tick();
  // No form, a write waiting: a sign-out still asks.
  confirmAnswer = false;
  assert.equal(centralCalendarMayBeLeft({ final: true }), false);
  assert.match(questions.at(-1), /^The result of an event's save is not confirmed\. It cannot be checked after signing out\. Sign out anyway\?/);
  assert.equal(centralCalendarMayBeLeft(), true, "a workspace switch keeps it to check later without asking");
  // app.js: the question comes before signOut() and its logout request, and
  // the button is the only way into it. Settings -> Calendar (K2b-1c) is
  // asked right after the calendar, still before the request.
  const appJs = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(appJs, /els\.signOut\?\.addEventListener\("click", \(\) => \{\s*if \(centralCalendarMayBeLeft\(\{ final: "sign-out" \}\) && calendarSettingsMayBeLeft\(\{ final: "sign-out" \}\)\) void signOut\(\);\s*\}\);/, "sign-out asks the calendar first");
  assert.equal((appJs.match(/\bsignOut\(\);/g) || []).length, 1, "signOut() is called from that listener only");
  assert.doesNotMatch(appJs, /addEventListener\("click", signOut\)/);
  assert.equal(CENTRAL_CALENDAR_STAYED, "stayed", "app.js's Back passes it on as its own BACK_STAYED");
  // The workspace switch asks before its PUT (workspace-actions.js).
  const ws = readFileSync(new URL("../workspace-actions.js", import.meta.url), "utf8");
  assert.ok(ws.indexOf("if (handlers.confirmLeave && !handlers.confirmLeave({ reload })) return true;") < ws.indexOf('api("/api/auth/workspace"'));
});

test("11h. LOW-2: the update banner's probe (an untrusted beforeunload) counts only what is being saved, never a form that is merely changed", async () => {
  await openCreate();
  input({ ccEventField: "title" }, { value: "Changed" });
  const probe = { isTrusted: false, preventDefault() { this.prevented = true; } };
  assert.equal(handleCentralCalendarBeforeUnload(probe), false, "the banner asks normally; its mayLeave asks about the values");
  assert.equal(handleCentralCalendarBeforeUnload({ isTrusted: true, preventDefault() {} }), true, "a real unload still protects the values");
  state.centralCalendar.form.unconfirmed = true;
  assert.equal(handleCentralCalendarBeforeUnload({ isTrusted: false, preventDefault() {} }), true, "a result not confirmed is 'being saved'");
});

test("11i. LOW-3: hostile strings stay text in the card, the panel, the form, the cancel confirmation and the line", async () => {
  const H = { title: `<img src=x onerror="alert(1)">Cup`, location: `"><script>alert(2)</script>`, notes: `<b>bold</b> & <i>it</i>`, type: `<svg onload="alert(3)">Match` };
  const items = ITEMS.map((item) => (item.eventId === E_MATCH ? { ...item, title: H.title, location: H.location, notes: H.notes, eventTypeLabel: H.type } : item));
  const event = eventView({ title: H.title, location: H.location, notes: H.notes, eventTypeLabel: H.type, eventTypeId: "70000000-0000-4000-8000-0000000000ff", targets: [{ kind: "team", id: U17, name: "<u>U17</u>" }] });
  // A type the coach's club named itself (K2b): its label in the select's option.
  const HOSTILE_TYPE = { id: "70000000-0000-4000-8000-0000000000ee", kind: "training", key: "x", label: `<img src=y onerror="alert(4)">Drill`, defaultExpects: [], iconKey: null, sortOrder: 5, ownerScope: "club" };
  const calls = installFetchMock(server({ items, event, types: [HOSTILE_TYPE, ...TYPES], writes: () => ({ status: 200, body: { event: { ...event, status: "cancelled", revision: 3 } } }) }));
  state.athletes = [{ athlete_uuid: A1, athlete_id: "1", athlete: "<i>Ana</i>" }];
  await loadCentralCalendar({ render });
  const injected = (doc) => doc.querySelectorAll(".central-calendar img, .central-calendar script, .central-calendar b, .central-calendar i, .central-calendar u, .central-calendar [onload], .central-calendar [onerror]").length;
  let doc = dom();
  assert.equal(injected(doc), 0, "the card");
  assert.match(doc.querySelector(`.cc-card[data-key="event:${E_MATCH}:${DAY(1)}"]`).textContent, /<img src=x/);
  await act({ action: "central-calendar-open-item", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  doc = dom();
  assert.equal(injected(doc), 0, "the panel (notes and the type's label: M10b, M11)");
  assert.equal(doc.querySelector(".cc-panel-notes-text").textContent, H.notes);
  assert.match(doc.querySelector(".cc-panel-kind").textContent, /<svg onload="alert\(3\)">Match/);
  await act({ action: "central-calendar-edit-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  await act({ action: "central-calendar-event-athletes" });
  doc = dom();
  assert.equal(injected(doc), 0, "the edit form");
  assert.equal(doc.querySelector("#ccEvent-title").value, H.title);
  assert.equal(doc.querySelector("#ccEvent-notes").value, H.notes);
  assert.match(doc.querySelector(".cc-field-static").textContent, /<svg onload/, "the read-only type's label (M11)");
  await act({ action: "central-calendar-event-form-close" });
  await act({ action: "central-calendar-cancel-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  doc = dom();
  assert.equal(injected(doc), 0, "the cancel confirmation");
  assert.equal(doc.querySelector(".cc-cancel-name strong").textContent, H.title);
  await submitCentralCalendarEventForm({ render });
  doc = dom();
  assert.equal(injected(doc), 0, "the line after it");
  assert.match(doc.querySelector(".cc-refresh-note").textContent, /<img src=x onerror="alert\(1\)">Cup/);
  assert.equal(writesOf(calls).length, 1);
  // New event: the type's label in the select's option (the review's M11 of
  // the option) - a select drops tags it does not take, so the text itself.
  await act({ action: "central-calendar-close-panel" });
  await act({ action: "central-calendar-new-event" });
  doc = dom();
  assert.equal(injected(doc), 0, "the new event form");
  assert.equal(doc.querySelector(`#ccEvent-eventTypeId option[value="${HOSTILE_TYPE.id}"]`).textContent, HOSTILE_TYPE.label);
});

test("11l. LOW-A: a switch into or out of the athlete workspace loads the page again - it asks as finally as a sign-out, in its own words", async () => {
  const { handleWorkspaceAction } = await import("../workspace-actions.js");
  const seen = [];
  const handlers = { confirmLeave: (leave) => { seen.push(leave); return false; } };
  await handleWorkspaceAction({ dataset: { action: "workspace-select", workspaceType: "athlete", workspaceScopeId: "" } }, handlers);
  await handleWorkspaceAction({ dataset: { action: "workspace-select", workspaceType: "team", workspaceScopeId: U19 } }, handlers);
  assert.deepEqual(seen, [{ reload: true }, { reload: false }], "the switch says whether it loads the page again, before its PUT");
  await openCreate({ writes: () => ({ throwNetworkError: true }) });
  fillValid();
  await submitCentralCalendarEventForm({ render });
  confirmAnswer = false;
  assert.equal(centralCalendarMayBeLeft({ final: "switch" }), false, "the form not confirmed");
  assert.equal(questions.at(-1), "The last save of an event is not confirmed. Switch without checking? It cannot be checked after this switch: the page is loaded again.");
  confirmAnswer = true;
  await act({ action: "central-calendar-event-form-close" });
  await tick();
  confirmAnswer = false;
  assert.equal(centralCalendarMayBeLeft({ final: "switch" }), false, "a write waiting, no form");
  assert.equal(questions.at(-1), "The result of an event's save is not confirmed. It cannot be checked after this switch: the page is loaded again. Switch anyway?");
  const asked = questions.length;
  assert.equal(centralCalendarMayBeLeft({ final: false }), true, "a switch between clubs keeps it to check later, unasked");
  assert.equal(questions.length, asked);
  const appJs = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(appJs, /confirmLeave: \(leave\) => askLeaveTrainingLoad\(\) && centralCalendarMayBeLeft\(\{ final: leave\?\.reload \? "switch" : false \}\)/, "app.js maps the reload to a final question");
});

test("11j. LOW-3: Cancel needs the card's canManage (M6); a sent form's fields are locked while its result is not confirmed (M17)", async () => {
  const calls = installFetchMock(server());
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-cancel-event", key: `event:${E_CAMP}:${DAY(3)}`, date: DAY(3) });
  assert.equal(state.centralCalendar.form, null, "a reader's card: no cancel confirmation");
  assert.equal(writesOf(calls).length, 0);
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  await openCreate({ writes: () => ({ throwNetworkError: true }) });
  fillValid();
  await submitCentralCalendarEventForm({ render });
  const form = state.centralCalendar.form;
  const sentBody = JSON.stringify(form.sentBody);
  assert.equal(dom().querySelector(".cc-event-form fieldset.cc-form-fields").disabled, true, "the fields are disabled");
  input({ ccEventField: "title" }, { value: "Changed after sending" });
  input({ ccEventTarget: "team", targetId: U19, targetName: "U19" }, { checked: true });
  assert.notEqual(form.draft.title, "Changed after sending", "the draft does not move");
  assert.equal(form.draft.targets.some((target) => target.id === U19), false);
  assert.equal(JSON.stringify(form.sentBody), sentBody, "Check result sends what was sent");
});

test("11k. HIGH-1: a late answer that does not settle (no answer, 503 outcome_unknown) keeps the write waiting; New event still offers the check", async () => {
  for (const late of [{ throwNetworkError: true }, { status: 503, body: { error: "outcome_unknown", message: "Unknown." } }]) {
    clearAllViewCache();
    resetCentralCalendarForWorkspaceChange();
    clearCentralCalendarUncertainWrites();
    let release;
    await openCreate({ writes: () => new Promise((resolve) => { release = resolve; }) });
    fillValid();
    const sending = submitCentralCalendarEventForm({ render });
    confirmAnswer = true;
    closeCentralCalendarPanel(render);
    await tick();
    release(late);
    await sending;
    await tick();
    assert.equal(centralCalendarUncertainWrites().length, 1, "still waiting to be checked");
    assert.match(state.centralCalendar.notice, /is not confirmed/, "the leave's line stays: nothing was learned");
    await act({ action: "central-calendar-new-event" });
    assert.equal(state.centralCalendar.form.pending, true);
  }
});

// Central calendar K5-3 (docs/ai/central-calendar-k5-plan.md, "Add to the event?"): a lone activity's or RPE
// request's panel offers to add it to a training or match of its day, through the real handlers, loaders and
// templates with a fake fetch and JSDOM. The fake keeps the routes' contracts (calendarEventService.js attachActivity
// and updateEvent's externalScheduleId, the runner's requestKey replay and expectedRevision): an added activity or RPE
// request folds under its event on the next calendar read, a refusal changes nothing.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true };

const { state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const {
  centralCalendarCanCreateEvents, centralCalendarEventRoster, centralCalendarRosterIndex, centralCalendarUncertainWrites,
  clearCentralCalendarUncertainWrites, handleCentralCalendarAction,
} = await import("../central-calendar-actions.js");
const { loadCentralCalendar, resetCentralCalendarForWorkspaceChange } = await import("../central-calendar-data.js");
const links = await import("../central-calendar-links.js");
const view = await import("../central-calendar-view.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const D = addDaysIso(weekMondayIso(TODAY), 1);
const CLUB = "c1c1c1c1-0000-4000-8000-000000000001";
const U19 = "11111111-1111-4111-8111-111111111111";
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E_MEET = "e0000000-0000-4000-8000-000000000003";
const A1 = "aaaaaaaa-0000-4000-8000-000000000001";
const A2 = "aaaaaaaa-0000-4000-8000-000000000002";
const A3 = "aaaaaaaa-0000-4000-8000-000000000003";
const A4 = "aaaaaaaa-0000-4000-8000-000000000004";
const ACT1 = "a0000000-0000-4000-8000-000000000001";
const EXT1 = "b0000000-0000-4000-8000-000000000001";
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CODES = /\b(activity_\w+|schedule_\w+|rpe_\w+|event_changed|request_key_reused|try_again|externalScheduleId|activityId)\b/;

function baseItem(overrides) {
  return {
    key: "", kind: "activity", date: D, title: null, slot: null, startTime: null, startsAt: null,
    teamIds: [U19], athleteIds: [], athleteCount: 0, expects: [], status: "none", rpe: null, attendance: null,
    results: null, cancelled: false, projected: false, links: {}, ...overrides,
  };
}
function eventItem(id, overrides) {
  return baseItem({
    key: `event:${id}:${D}`, kind: "event", eventId: id, eventKind: "training", eventTypeLabel: "Training", eventTypeId: null,
    endTime: null, location: null, span: { from: D, to: D }, gaps: [], scheduleFold: { external: null, test: null }, revision: 1,
    canManage: true, notes: null, details: { selected: 0, filled: 0, required: 0, filledRequired: 0 }, alignment: { pending: 0 },
    links: { eventId: id, planIds: [], logicalSessionIds: [], activityIds: [], externalScheduleId: null, testScheduleId: null },
    ...overrides,
  });
}
const TRAINING = (o = {}) => eventItem(E1, { title: "Training", athleteIds: [A1, A2, A3], athleteCount: 3, startTime: "10:00", endTime: "11:30", ...o });
const ACT = (o = {}) => baseItem({ key: `activity:${ACT1}`, kind: "activity", title: "GPS session", origin: "api_import", startTime: "10:05", athleteIds: [A2, A4], athleteCount: 2, links: { activityIds: [ACT1] }, ...o });
const EXT = (o = {}) => baseItem({ key: `external:${EXT1}:${D}`, kind: "external", title: "RPE after training", startTime: "18:00", expects: ["rpe"], athleteIds: [A1, A2], athleteCount: 2, links: { externalScheduleId: EXT1, activityIds: [] }, ...o });

function server({ items = [TRAINING(), ACT(), EXT()], refuse = null, lose = 0 } = {}) {
  const live = items.map((item) => ({ ...item, links: { ...item.links } }));
  const keys = new Map();
  let losing = lose;
  const eventOf = (id) => live.find((item) => item.kind === "event" && item.eventId === id);
  const managerView = (e) => ({ id: e.eventId, title: e.title, revision: e.revision, expects: e.expects, canManage: true, status: "planned", fields: [], sessionLinks: [], activityLinks: [], alignment: { pending: 0 } });
  function write(call, path) {
    const m = path.match(/^\/api\/calendar\/events\/([^/]+)(\/activities)?$/);
    if (!m) return { status: 404, body: { error: "unexpected" } };
    const e = eventOf(m[1]);
    if (!e) return { status: 404, body: { error: "notFound", message: "Not found." } };
    if (call.body.expectedRevision !== e.revision) return { status: 409, body: { error: "event_changed", message: "x" } };
    if (m[2] && call.method === "POST") {
      const card = live.find((item) => item.kind === "activity" && item.links.activityIds[0] === call.body.activityId);
      if (!card) return { status: 400, body: { error: "activity_not_available", message: "x" } };
      live.splice(live.indexOf(card), 1);
      e.links.activityIds = [...e.links.activityIds, ACT1];
      e.revision += 1;
      return { status: 200, body: { event: managerView(e), attached: true } };
    }
    if (!m[2] && call.method === "PATCH") {
      const keys = Object.keys(call.body).filter((k) => k !== "requestKey" && k !== "expectedRevision");
      assert.deepEqual(keys, ["externalScheduleId"], "the add sends one field");
      const card = live.find((item) => item.kind === "external" && item.links.externalScheduleId === call.body.externalScheduleId);
      if (!card) return { status: 400, body: { error: "schedule_not_available", message: "x" } };
      live.splice(live.indexOf(card), 1);
      e.links.externalScheduleId = call.body.externalScheduleId;
      e.scheduleFold = { external: "folded", test: null };
      e.revision += 1;
      return { status: 200, body: { event: managerView(e) } };
    }
    return { status: 404, body: { error: "unexpected" } };
  }
  const responder = (call) => {
    const path = call.url.split("?")[0];
    if (path === "/api/calendar" && call.method === "GET") {
      const params = new URL(call.url, "http://localhost").searchParams;
      const days = [];
      for (let cursor = params.get("from"); cursor <= params.get("to"); cursor = addDaysIso(cursor, 1)) {
        days.push({ date: cursor, items: live.filter((item) => item.date === cursor).map((item) => (params.get("include") === "athletes" ? { ...item, athletes: [] } : { ...item })) });
      }
      return { status: 200, body: { from: params.get("from"), to: params.get("to"), today: params.get("today"), workspace: { type: "club", scopeId: CLUB }, teams: [{ teamId: U19, name: "U19", athleteCount: 20 }], days } };
    }
    if (path === "/api/calendar/events/types") return { status: 200, body: { types: [] } };
    if (path.startsWith("/api/calendar/events/") && call.method === "GET") {
      const e = eventOf(path.split("/").pop());
      return e ? { status: 200, body: { event: managerView(e) } } : { status: 404, body: { error: "notFound" } };
    }
    if (path.startsWith("/api/calendar/events/") && (call.method === "POST" || call.method === "PATCH")) {
      const { requestKey, ...rest } = call.body || {};
      const hash = JSON.stringify({ path, method: call.method, rest });
      const saved = keys.get(requestKey);
      if (saved) return saved.hash === hash ? { status: saved.status, body: { ...saved.body, replayed: true } } : { status: 409, body: { error: "request_key_reused" } };
      const refusal = refuse?.(call, path);
      if (refusal) return refusal;
      const answer = write(call, path);
      if (answer.status < 300) keys.set(requestKey, { hash, ...answer });
      if (answer.status < 300 && losing > 0) {
        losing -= 1;
        return { throwNetworkError: true };
      }
      return answer;
    }
    return { status: 404, body: { error: "unexpected", message: call.url } };
  };
  responder.live = live;
  return responder;
}

let rendered = "";
function render() {
  rendered = view.renderCentralCalendarHtml(state.centralCalendar, {
    today: TODAY, layout: "wide", roster: centralCalendarRosterIndex(), canCreate: centralCalendarCanCreateEvents(), eventRoster: centralCalendarEventRoster(),
    uncertainWrites: centralCalendarUncertainWrites(),
  });
}
const dom = () => new JSDOM(`<!doctype html><body>${rendered}</body>`).window.document;
const act = (dataset) => handleCentralCalendarAction(fakeAction(dataset), { render });
const writesOf = (calls) => calls.filter((call) => call.url.startsWith("/api/calendar/events") && (call.method === "POST" || call.method === "PATCH"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const open = (key) => act({ action: "central-calendar-open-item", key, date: D });
const section = () => dom().querySelector(".cc-add-event");
const addButtons = () => [...dom().querySelectorAll('.cc-add-event [data-action="central-calendar-link"]')];
const press = (button) => act({ ...button.dataset });

async function start(options) {
  const fake = server(options);
  const calls = installFetchMock(fake);
  await loadCentralCalendar({ render });
  await tick();
  return { fake, calls };
}

beforeEach(() => {
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  clearCentralCalendarUncertainWrites();
  state.deliberateNavigation = false;
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: CLUB, label: "First Club" } };
  state.activeTab = "central-calendar";
  state.athletes = [];
  rendered = "";
});

// --- 1. The rule ---------------------------------------------------------------------------

test("1a. an activity: a training or match of its day, same half, at least one athlete in common", () => {
  const offers = (items, item = items.find((x) => x.kind === "activity")) => links.centralCalendarAddToEventOffers({ days: [{ date: D, items }] }, item).map((o) => o.item.eventId);
  assert.deepEqual(offers([TRAINING(), ACT()]), [E1]);
  assert.deepEqual(offers([TRAINING({ eventKind: "match" }), ACT()]), [E1], "a match too");
  assert.deepEqual(offers([TRAINING({ eventKind: "meeting" }), ACT()]), [], "not a meeting");
  assert.deepEqual(offers([TRAINING({ eventKind: "test" }), ACT()]), [], "not a test event");
  assert.deepEqual(offers([TRAINING(), ACT({ athleteIds: [A4] })]), [], "no athlete in common");
  assert.deepEqual(offers([TRAINING(), ACT({ startTime: "17:00" })]), [], "the other half of the day (O15)");
  assert.deepEqual(offers([TRAINING(), ACT({ startTime: null })]), [E1], "no start: no half-of-day limit");
  assert.deepEqual(offers([TRAINING({ startTime: null, endTime: null }), ACT({ startTime: "17:00" })]), [E1], "an event with no time: no limit");
  assert.deepEqual(offers([TRAINING({ canManage: false }), ACT()]), [], "a reader's event");
  assert.deepEqual(offers([TRAINING({ cancelled: true }), ACT()]), [], "a cancelled event");
  assert.deepEqual(offers([TRAINING(), ACT({ cancelled: true })]), [], "a cancelled card");
  const tomorrow = addDaysIso(D, 1);
  const otherDay = { days: [{ date: D, items: [ACT()] }, { date: tomorrow, items: [TRAINING({ date: tomorrow })] }] };
  assert.deepEqual(links.centralCalendarAddToEventOffers(otherDay, ACT()).map((o) => o.item.eventId), [], "another day");
});

test("1b. an RPE request: every athlete in the event, no RPE schedule and no linked training on the event; tests never", () => {
  const offers = (items, item) => links.centralCalendarAddToEventOffers({ days: [{ date: D, items }] }, item).map((o) => o.item.eventId);
  assert.deepEqual(offers([TRAINING(), EXT()], EXT()), [E1], "no half-of-day rule: its time is when RPE opens");
  assert.deepEqual(offers([TRAINING(), EXT({ athleteIds: [A1, A4] })], EXT({ athleteIds: [A1, A4] })), [], "A4 is not in the event: it would not fold");
  const withSchedule = TRAINING({ links: { ...TRAINING().links, externalScheduleId: "b0000000-0000-4000-8000-000000000009" } });
  assert.deepEqual(offers([withSchedule, EXT()], EXT()), [], "the event already refers to an RPE schedule");
  const withSessions = TRAINING({ links: { ...TRAINING().links, logicalSessionIds: ["10000000-0000-4000-8000-000000000001"] } });
  assert.deepEqual(offers([withSessions, EXT()], EXT()), [], "RPE comes from its linked trainings");
  const test1 = baseItem({ key: `test:x:${D}`, kind: "test", athleteIds: [A1], links: { testScheduleId: "c0000000-0000-4000-8000-000000000001" } });
  assert.deepEqual(offers([TRAINING(), test1], test1), [], "a test schedule is never offered (A2)");
  const planned = baseItem({ key: "planned:p1", kind: "planned", athleteIds: [A1], links: { logicalSessionIds: ["x"] } });
  assert.deepEqual(offers([TRAINING(), planned], planned), [], "a planned card has its own Link to an event");
  assert.equal(links.centralCalendarAddToEventQuestion(TRAINING()), "Add to “Training 10:00”?");
  assert.equal(links.centralCalendarAddToEventQuestion(TRAINING({ title: "Training 10:00" })), "Add to “Training 10:00”?", "the time once");
});

// --- 2. The panel and Add ------------------------------------------------------------------

test("2. an activity's panel asks, Add sends one POST with the exact body, the panel moves to the event", async () => {
  const { calls, fake } = await start();
  await open(`activity:${ACT1}`);
  const s = section();
  assert.ok(s, "the question is there");
  assert.match(s.textContent, /Add to “Training 10:00”\?/);
  assert.equal(addButtons().length, 1);
  assert.ok(s.querySelector('[data-action="central-calendar-add-leave"]'), "and Leave");
  assert.doesNotMatch(s.textContent, UUID_ANYWHERE);
  assert.equal(writesOf(calls).length, 0, "never sent by itself");
  await press(addButtons()[0]);
  await tick();
  const writes = writesOf(calls);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "POST");
  assert.equal(writes[0].url, `/api/calendar/events/${E1}/activities`);
  const { requestKey, ...body } = writes[0].body;
  assert.ok(requestKey);
  assert.deepEqual(body, { expectedRevision: 1, activityId: ACT1 });
  assert.equal(fake.live.some((item) => item.kind === "activity"), false, "folded under the event");
  assert.equal(state.centralCalendar.panel.key, `event:${E1}:${D}`, "the panel moved to the event");
  assert.equal(state.centralCalendar.linkMessage?.text, "Added to “Training 10:00”.");
});

test("3. an RPE request's panel: Add sends one PATCH with only externalScheduleId", async () => {
  const { calls } = await start();
  await open(`external:${EXT1}:${D}`);
  assert.match(section().textContent, /Add to “Training 10:00”\?/);
  assert.match(section().textContent, /will collect this RPE request/);
  await press(addButtons()[0]);
  await tick();
  const writes = writesOf(calls);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PATCH");
  assert.equal(writes[0].url, `/api/calendar/events/${E1}`);
  const { requestKey, ...body } = writes[0].body;
  assert.ok(requestKey);
  assert.deepEqual(body, { expectedRevision: 1, externalScheduleId: EXT1 });
  assert.equal(state.centralCalendar.panel.key, `event:${E1}:${D}`);
});

test("4. Leave sends nothing and hides the question for this card; another card still asks", async () => {
  const { calls } = await start();
  await open(`activity:${ACT1}`);
  await act({ action: "central-calendar-add-leave" });
  assert.equal(section(), null);
  assert.equal(writesOf(calls).length, 0);
  await open(`external:${EXT1}:${D}`);
  assert.ok(section(), "the RPE request still asks");
  await open(`activity:${ACT1}`);
  assert.equal(section(), null, "still left after reopening");
});

test("5. several events: one row each with its Add, then Leave", async () => {
  await start({ items: [TRAINING(), eventItem(E2, { title: "Match", eventKind: "match", eventTypeLabel: "Match", athleteIds: [A2], athleteCount: 1, startTime: "09:00" }), eventItem(E_MEET, { title: "Meeting", eventKind: "meeting", athleteIds: [A2], startTime: "10:00" }), ACT()] });
  await open(`activity:${ACT1}`);
  const rows = [...dom().querySelectorAll(".cc-add-event .cc-link-row")];
  assert.deepEqual(rows.map((row) => row.querySelector(".cc-link-name").textContent), ["Match", "Training"], "by start time; not the meeting");
  assert.equal(addButtons().length, 2);
});

test("6. a refusal: one plain sentence, the pair kept without its Add, nothing resent", async () => {
  const { calls } = await start({ refuse: (call) => (call.method === "PATCH" ? { status: 409, body: { error: "rpe_from_sessions", message: "RPE comes from the linked sessions." } } : null) });
  await open(`external:${EXT1}:${D}`);
  await press(addButtons()[0]);
  await tick();
  assert.equal(writesOf(calls).length, 1);
  const text = state.centralCalendar.linkMessage?.text || "";
  assert.match(text, /takes RPE from its linked trainings/);
  assert.doesNotMatch(text, CODES);
  assert.equal(state.centralCalendar.panel.key, `external:${EXT1}:${D}`, "the panel stays");
  assert.equal(addButtons().length, 0, "no Add for the refused pair");
  assert.match(section().textContent, /This event already takes RPE another way\./);
  assert.match(section().textContent, /Can't be added to an event on this day\./, "no question offering a missing choice");
  assert.doesNotMatch(section().textContent, /Add to one of these events\?/);
  assert.equal(dom().querySelector('[data-action="central-calendar-add-leave"]').textContent, "Hide");
});

test("6b. an RPE-channel refusal is offered again once the event changed (its revision moved)", () => {
  const pair = links.centralCalendarRefusedPairKey(E1, EXT());
  for (const code of ["rpe_from_question", "rpe_from_sessions"]) {
    const refused = new Map([[pair, { code, revision: 1 }]]);
    const data = (revision) => ({ days: [{ date: D, items: [TRAINING({ revision }), EXT()] }] });
    assert.notEqual(links.centralCalendarAddToEventOffers(data(1), EXT(), refused)[0].refused, "", `${code}: kept while the event is as it was`);
    assert.equal(links.centralCalendarAddToEventOffers(data(2), EXT(), refused)[0].refused, "", `${code}: offered again`);
  }
  const kept = new Map([[pair, { code: "schedule_already_referenced", revision: 1 }]]);
  assert.notEqual(links.centralCalendarAddToEventOffers({ days: [{ date: D, items: [TRAINING({ revision: 2 }), EXT()] }] }, EXT(), kept)[0].refused, "", "a schedule refusal stays");
});

test("1c. an RPE schedule an event of the loaded range already refers to is not offered on another day", () => {
  const tomorrow = addDaysIso(D, 1);
  const elsewhere = eventItem(E2, { date: tomorrow, key: `event:${E2}:${tomorrow}`, athleteIds: [A1, A2], links: { ...TRAINING().links, eventId: E2, externalScheduleId: EXT1 } });
  const data = { days: [{ date: D, items: [TRAINING(), EXT()] }, { date: tomorrow, items: [elsewhere] }] };
  assert.deepEqual(links.centralCalendarAddToEventOffers(data, EXT()), []);
  const cancelledElsewhere = { ...elsewhere, cancelled: true };
  assert.deepEqual(links.centralCalendarAddToEventOffers({ days: [data.days[0], { date: tomorrow, items: [cancelledElsewhere] }] }, EXT()).map((o) => o.item.eventId), [E1], "a cancelled event frees it");
});

test("7. a lost answer: Result not confirmed, the panel's buttons off; Check result sends the same request and settles it", async () => {
  const { calls } = await start({ lose: 1 });
  await open(`activity:${ACT1}`);
  await press(addButtons()[0]);
  await tick();
  assert.equal(writesOf(calls).length, 1);
  assert.match(section().textContent, /The result is not confirmed\./);
  assert.ok(addButtons().every((b) => b.disabled), "Add is off");
  const check = dom().querySelector('[data-action="central-calendar-link-check"]');
  const first = writesOf(calls)[0];
  await act({ ...check.dataset });
  await tick();
  const second = writesOf(calls)[1];
  assert.equal(second.url, first.url);
  assert.equal(second.method, first.method);
  assert.deepEqual(second.body, first.body, "the same key and body");
  assert.equal(centralCalendarUncertainWrites().length, 0);
  assert.equal(state.centralCalendar.panel.key, `event:${E1}:${D}`);
});

test("7b. a lost PATCH: Check result sends PATCH again, never a POST", async () => {
  const { calls } = await start({ lose: 1 });
  await open(`external:${EXT1}:${D}`);
  await press(addButtons()[0]);
  await tick();
  await act({ ...dom().querySelector('[data-action="central-calendar-link-check"]').dataset });
  await tick();
  assert.deepEqual(writesOf(calls).map((c) => c.method), ["PATCH", "PATCH"]);
});

test("8. a reader's and a cancelled event: no question in the panel", async () => {
  await start({ items: [TRAINING({ canManage: false, details: undefined, alignment: undefined }), ACT()] });
  await open(`activity:${ACT1}`);
  assert.equal(section(), null, "a reader's event");
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  await start({ items: [TRAINING({ cancelled: true, status: "cancelled" }), ACT()] });
  await open(`activity:${ACT1}`);
  assert.equal(section(), null, "a cancelled event");
});

test("9. a forged press for an event that is not offered sends nothing", async () => {
  const { calls } = await start({ items: [TRAINING(), eventItem(E_MEET, { title: "Meeting", eventKind: "meeting", athleteIds: [A2] }), ACT()] });
  await open(`activity:${ACT1}`);
  await act({ action: "central-calendar-link", act: "add-activity", eventKey: `event:${E_MEET}:${D}` });
  await act({ action: "central-calendar-link", act: "add-rpe", eventKey: `event:${E1}:${D}` });
  await tick();
  assert.equal(writesOf(calls).length, 0);
});

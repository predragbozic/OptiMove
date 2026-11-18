// Central calendar K2c-1 (docs/ai/central-calendar-k2c-plan.md section 1.1):
// linking a Builder training or a recorded activity to an event from the
// calendar's panels, through the real handlers, loaders and templates with a
// fake fetch and JSDOM. The fake keeps the K2a-1b routes' contracts
// (backend/src/calendarEventService.js attachSessions / detachSessions /
// alignSessions / attachActivity / detachActivity, the runner's requestKey
// replay and expectedRevision): a linked planned group folds under its event
// on the next calendar read, a detach brings it back, a refusal changes
// nothing.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
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
  centralCalendarCanCreateEvents,
  centralCalendarEventRoster,
  centralCalendarMayBeLeft,
  centralCalendarRosterIndex,
  centralCalendarUncertainWrites,
  clearCentralCalendarUncertainWrites,
  handleCentralCalendarAction,
  handleCentralCalendarBeforeUnload,
} = await import("../central-calendar-actions.js");
const { loadCentralCalendar, resetCentralCalendarForWorkspaceChange } = await import("../central-calendar-data.js");
const links = await import("../central-calendar-links.js");
const view = await import("../central-calendar-view.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
const DAY = (offset) => addDaysIso(MONDAY, offset);
const D = DAY(1);
const CLUB = "c1c1c1c1-0000-4000-8000-000000000001";
const U19 = "11111111-1111-4111-8111-111111111111";
const TEAMS = [{ teamId: U19, name: "U19", athleteCount: 20 }];
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E_READ = "e0000000-0000-4000-8000-000000000003";
const E_OFF = "e0000000-0000-4000-8000-000000000004";
const A1 = "aaaaaaaa-0000-4000-8000-000000000001";
const A2 = "aaaaaaaa-0000-4000-8000-000000000002";
const A3 = "aaaaaaaa-0000-4000-8000-000000000003";
const A4 = "aaaaaaaa-0000-4000-8000-000000000004";
const L1 = "10000000-0000-4000-8000-000000000001";
const L2 = "10000000-0000-4000-8000-000000000002";
const L3 = "10000000-0000-4000-8000-000000000003";
const L4 = "10000000-0000-4000-8000-000000000004";
const PLAN1 = "50000000-0000-4000-8000-000000000001";
const PLAN2 = "50000000-0000-4000-8000-000000000002";
const ACT1 = "a0000000-0000-4000-8000-000000000001";
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CODES = /\b(event_changed|session_not_available|athlete_not_targeted|session_already_attached|link_not_available|nothing_to_align|activity_\w+|request_key_reused|try_again|outcome_unknown|logicalSessionIds|linkIds)\b/;

function baseItem(overrides) {
  return {
    key: "", kind: "planned", date: D, title: null, slot: null, startTime: null, startsAt: null,
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
function plannedItem(key, title, athleteIds, logicalSessionIds, planIds, overrides = {}) {
  return baseItem({
    key, title, slot: { amPm: "AM", bta: "T", order: 1 }, athleteIds, athleteCount: athleteIds.length, expects: [], status: "planned",
    links: { activityIds: [], planIds, logicalSessionIds }, ...overrides,
  });
}
const P1 = () => plannedItem("planned:p1", "Morning session", [A1, A2], [L1, L2], [PLAN1]);
const P_PART = () => plannedItem("planned:p2", "Gym", [A1, A4], [L3, L4], [PLAN2], { slot: { amPm: "PM", bta: "T", order: 1 } });
const ACT = () => baseItem({ key: `activity:${ACT1}`, kind: "activity", title: "GPS session", origin: "api_import", athleteIds: [A2], athleteCount: 1, links: { activityIds: [ACT1] } });

function defaultItems() {
  return [
    eventItem(E1, { title: "Team training", athleteIds: [A1, A2, A3], athleteCount: 3, expects: ["rpe"], startTime: "10:00" }),
    P1(),
    P_PART(),
    ACT(),
  ];
}

// The fake server. `refuse(call, path)` may answer a write before the default
// behaviour; `lose` drops the answer of the next write that saves.
function server({ items = defaultItems(), refuse = null, lose = 0, eventStatus = null, rpeOn = false } = {}) {
  const live = items.map((item) => ({ ...item }));
  const keys = new Map();
  const linked = new Map(); // eventId -> { sessions: [{ group, link ids }], activities: [] }
  let losing = lose;
  let nextLink = 1;
  const linkId = () => `f0000000-0000-4000-8000-${String(nextLink++).padStart(12, "0")}`;
  const eventOf = (id) => live.find((item) => item.kind === "event" && item.eventId === id);
  const state1 = (id) => {
    if (!linked.has(id)) linked.set(id, { sessions: [], activities: [] });
    return linked.get(id);
  };
  const managerView = (id) => {
    const e = eventOf(id);
    const s = state1(id);
    return {
      id, title: e.title, revision: e.revision, expects: e.expects, canManage: true, status: e.cancelled ? "cancelled" : "planned", fields: [],
      sessionLinks: s.sessions.flatMap((group) => group.links.map((link) => ({
        id: link.id, planId: group.card.links.planIds[0], day: D, amPm: group.card.slot.amPm, bta: group.card.slot.bta, order: 1,
        state: group.orphaned ? "orphaned" : "linked", sessionName: group.orphaned ? null : group.card.title, sessionNameAtLink: group.card.title,
        logicalSessionId: link.logical, athleteId: link.athleteId, asksRpe: rpeOn, aligned: !e.expects.includes("rpe") || rpeOn,
      }))),
      activityLinks: s.activities.map((a) => ({ id: a.linkId, activityId: a.card.links.activityIds[0], day: D, visible: true, name: a.card.title, origin: "api_import" })),
      alignment: { pending: e.alignment.pending },
    };
  };
  const pending = (id) => {
    const e = eventOf(id);
    const count = state1(id).sessions.filter((g) => !g.orphaned).reduce((n, g) => n + g.links.length, 0);
    e.alignment = { pending: e.expects.includes("rpe") && !rpeOn ? count : 0 };
  };
  const bump = (id) => {
    for (const item of live) if (item.kind === "event" && item.eventId === id) item.revision += 1;
  };
  function write(call, path) {
    const m = path.match(/^\/api\/calendar\/events\/([^/]+)\/(sessions|sessions\/detach|sessions\/align|activities|activities\/detach)$/);
    if (!m) return { status: 404, body: { error: "unexpected" } };
    const [, id, what] = m;
    const e = eventOf(id);
    if (!e) return { status: 404, body: { error: "notFound", message: "Not found." } };
    if (call.body.expectedRevision !== e.revision) return { status: 409, body: { error: "event_changed", message: "x", current: { revision: e.revision } } };
    const s = state1(id);
    if (what === "sessions") {
      const card = live.find((item) => item.kind === "planned" && JSON.stringify(item.links.logicalSessionIds) === JSON.stringify(call.body.logicalSessionIds));
      if (!card) return { status: 400, body: { error: "session_not_available", message: "x" } };
      live.splice(live.indexOf(card), 1);
      s.sessions.push({ card, links: card.athleteIds.map((athleteId, i) => ({ id: linkId(), athleteId, logical: card.links.logicalSessionIds[i] })) });
      pending(id);
      bump(id);
      return { status: 200, body: { event: managerView(id), attached: card.athleteIds.length, alreadyAttached: 0, alignment: null } };
    }
    if (what === "sessions/detach") {
      const group = s.sessions.find((g) => JSON.stringify(g.links.map((l) => l.id).sort()) === JSON.stringify(call.body.linkIds));
      if (!group) return { status: 400, body: { error: "link_not_available", message: "x" } };
      s.sessions.splice(s.sessions.indexOf(group), 1);
      if (!group.orphaned) live.push(group.card);
      pending(id);
      bump(id);
      return { status: 200, body: { event: managerView(id), detached: group.links.length } };
    }
    if (what === "sessions/align") {
      const count = e.alignment.pending;
      if (!count) return { status: 409, body: { error: "nothing_to_align", message: "x" } };
      e.alignment = { pending: 0 };
      bump(id);
      return { status: 200, body: { event: managerView(id), alignment: { direction: e.expects.includes("rpe") ? "rpe_on" : "rpe_off", changed: count, unchanged: 0, notAllowed: 0, switchOff: 0 } } };
    }
    if (what === "activities") {
      const card = live.find((item) => item.kind === "activity" && item.links.activityIds[0] === call.body.activityId);
      if (!card) return { status: 400, body: { error: "activity_not_available", message: "x" } };
      live.splice(live.indexOf(card), 1);
      s.activities.push({ card, linkId: linkId() });
      bump(id);
      return { status: 200, body: { event: managerView(id), attached: true } };
    }
    const link = s.activities.find((a) => a.card.links.activityIds[0] === call.body.activityId);
    if (!link) return { status: 400, body: { error: "link_not_available", message: "x" } };
    s.activities.splice(s.activities.indexOf(link), 1);
    live.push(link.card);
    bump(id);
    return { status: 200, body: { event: managerView(id), detached: 1 } };
  }
  const responder = (call) => {
    const path = call.url.split("?")[0];
    if (path === "/api/calendar" && call.method === "GET") {
      const params = new URL(call.url, "http://localhost").searchParams;
      const days = [];
      for (let cursor = params.get("from"); cursor <= params.get("to"); cursor = addDaysIso(cursor, 1)) {
        days.push({ date: cursor, items: live.filter((item) => item.date === cursor).map((item) => (params.get("include") === "athletes" ? { ...item, athletes: [] } : { ...item })) });
      }
      return { status: 200, body: { from: params.get("from"), to: params.get("to"), today: params.get("today"), workspace: { type: "club", scopeId: CLUB }, teams: TEAMS, days } };
    }
    if (path === "/api/calendar/events/types") return { status: 200, body: { types: [] } };
    if (path.startsWith("/api/calendar/events/") && call.method === "GET") {
      const special = eventStatus?.(call);
      if (special) return special;
      const id = path.split("/").pop();
      return eventOf(id) ? { status: 200, body: { event: managerView(id) } } : { status: 404, body: { error: "notFound", message: "Not found." } };
    }
    if (path.startsWith("/api/calendar/events/") && call.method === "POST") {
      const { requestKey, ...rest } = call.body || {};
      const hash = JSON.stringify({ path, rest });
      const saved = keys.get(requestKey);
      if (saved) return saved.hash === hash ? { status: saved.status, body: { ...saved.body, replayed: true } } : { status: 409, body: { error: "request_key_reused", message: "x" } };
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
  responder.linked = linked;
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
const writesOf = (calls) => calls.filter((call) => call.url.startsWith("/api/calendar/events") && call.method === "POST");
const eventReads = (calls) => calls.filter((call) => /^\/api\/calendar\/events\/[0-9a-f-]{36}$/.test(call.url) && call.method === "GET");
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const openEvent = (id = E1) => act({ action: "central-calendar-open-item", key: `event:${id}:${D}`, date: D });
const openPlanned = (key = "planned:p1") => act({ action: "central-calendar-open-item", key, date: D });
const section = () => dom().querySelector(".cc-panel-links");
const linkButton = (selector) => dom().querySelector(`.cc-panel-links [data-action="central-calendar-link"]${selector}`);
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
  confirmAnswer = true;
  questions.length = 0;
});

// --- 1. The suggestion rule ------------------------------------------------------------

test("1a. the rule: every athlete in the event is offered, a partial overlap is counted, another day and none are not", () => {
  const data = { days: [
    { date: D, items: [...defaultItems(), plannedItem("planned:p3", "Other team", [A4], [L4], [PLAN2])] },
    { date: DAY(2), items: [plannedItem("planned:p9", "Tomorrow", [A1], [L1], [PLAN1], { date: DAY(2) })] },
  ] };
  const event = data.days[0].items[0];
  const out = links.centralCalendarLinkSuggestions(data, event);
  assert.deepEqual(out.trainings.map((x) => x.item.key), ["planned:p1"]);
  assert.equal(out.partial, 1, "Gym shares A1 but has A4");
  assert.deepEqual(out.activities.map((x) => x.item.key), [`activity:${ACT1}`]);
  const noTarget = { ...ACT(), athleteIds: [A4] };
  assert.equal(links.centralCalendarLinkSuggestions({ days: [{ date: D, items: [event, noTarget] }] }, event).activities.length, 0);
  // A cancelled event and a reader's get nothing.
  assert.equal(links.centralCalendarLinkSuggestions(data, { ...event, cancelled: true }).trainings.length, 0);
  assert.equal(links.centralCalendarLinkSuggestions(data, { ...event, canManage: false }).trainings.length, 0);
  // The planned card's side.
  const forPlanned = links.centralCalendarEventsForPlanned(data, P1());
  assert.deepEqual(forPlanned.events.map((x) => x.item.eventId), [E1]);
  assert.equal(links.centralCalendarEventsForPlanned(data, P_PART()).events.length, 0);
  assert.equal(links.centralCalendarEventsForPlanned(data, P_PART()).manageable, 1);
});

test("1b. the section: the event's panel lists the day's training and activity, the partial line; a reader's, a cancelled event's and the athlete's panels have none", async () => {
  const items = [
    ...defaultItems(),
    eventItem(E_READ, { title: "Club meeting", athleteIds: [A1, A2], athleteCount: 2, canManage: false, details: undefined, alignment: undefined, links: { eventId: E_READ, activityIds: [] } }),
    eventItem(E_OFF, { title: "Called off", athleteIds: [A1, A2], athleteCount: 2, cancelled: true, status: "cancelled" }),
  ];
  const { calls } = await start({ items });
  await openEvent();
  const s = section();
  assert.ok(s, "the section");
  assert.equal(s.querySelector(".cc-panel-subtitle").textContent, "Trainings and activities");
  assert.ok(linkButton('[data-planned-key="planned:p1"]'), "the covered training is offered");
  assert.equal(linkButton('[data-planned-key="planned:p2"]'), null, "the partial one is not");
  assert.match(s.textContent, /1 more training that day has athletes this event does not include\./);
  assert.ok(linkButton(`[data-activity-key="activity:${ACT1}"]`));
  assert.equal(eventReads(calls).length, 1, "the manager's GO (a): one GET per open");
  await openEvent(E_READ);
  assert.equal(section(), null, "a reader: nothing");
  await openEvent(E_OFF);
  assert.equal(section(), null, "a cancelled event: nothing");
  assert.equal(eventReads(calls).length, 1, "no read for a reader's or a cancelled event's panel");
  // The athlete's view of an event carries no canManage: no section.
  assert.equal(view.renderCentralCalendarHtml({ ...state.centralCalendar, panel: { open: true, key: `event:${E1}:${D}`, date: D } }, { today: TODAY })
    .includes("cc-panel-links") , true, "sanity: the manager's card has it");
  const athleteCard = { key: `event:${E1}:${D}`, kind: "event", date: D, title: "Team training", eventKind: "training", status: "planned", cancelled: false, teamIds: [], links: { eventId: E1 } };
  const athleteCal = { ...state.centralCalendar, data: { ...state.centralCalendar.data, days: [{ date: D, items: [athleteCard] }] }, panel: { open: true, key: athleteCard.key, date: D } };
  assert.equal(view.renderCentralCalendarHtml(athleteCal, { today: TODAY }).includes("cc-panel-links"), false, "the athlete: nothing");
});

// --- 2. Link from the event ---------------------------------------------------------------

test("2. Link from the event: one POST with the exact body; the calendar read again; the training is linked; the notice points at Align", async () => {
  const { calls } = await start();
  await openEvent();
  const reads = calls.filter((c) => c.url.startsWith("/api/calendar?")).length;
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  const writes = writesOf(calls);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, `/api/calendar/events/${E1}/sessions`);
  const { requestKey, ...body } = writes[0].body;
  assert.match(requestKey, UUID_ANYWHERE);
  assert.deepEqual(body, { expectedRevision: 1, logicalSessionIds: [L1, L2], alignSessions: false });
  assert.ok(calls.filter((c) => c.url.startsWith("/api/calendar?")).length > reads, "the calendar was read again");
  assert.equal(linkButton('[data-planned-key="planned:p1"]'), null, "no longer offered");
  const s = section();
  assert.match(s.textContent, /Linked trainings/);
  assert.match(s.querySelector(".cc-link-row").textContent, /Morning session/);
  assert.match(s.querySelector(".cc-link-row").textContent, /AM · Training · 2 athletes/);
  assert.equal(state.centralCalendar.notice, "Linked “Morning session”. These trainings do not ask for RPE yet: use Ask RPE in the linked trainings.");
  assert.equal(dom().querySelector('[data-act="align"]').textContent, "Ask RPE in the linked trainings");
});

// --- 3. Link from a planned card --------------------------------------------------------------

test("3a. a planned card with one covering event: the primary Link to “title”; after it the event's panel opens with the notice", async () => {
  const { calls } = await start();
  await openPlanned();
  const button = linkButton(`[data-event-key="event:${E1}:${D}"]`);
  assert.ok(button.classList.contains("primary-button"));
  assert.equal(button.textContent, "Link to “Team training”");
  assert.equal(eventReads(calls).length, 0, "a planned card's panel reads no event");
  await press(button);
  await tick();
  assert.equal(writesOf(calls)[0].url, `/api/calendar/events/${E1}/sessions`);
  assert.equal(state.centralCalendar.panel.key, `event:${E1}:${D}`, "the event's panel opened");
  assert.match(state.centralCalendar.notice, /^Linked to “Team training”\. These trainings do not ask for RPE yet/);
});

test("3b. two covering events: two rows with Link; none covering: the quiet line; no manageable event: no section", async () => {
  const items = [...defaultItems(), eventItem(E2, { title: "Extra", athleteIds: [A1, A2], athleteCount: 2 })];
  await start({ items });
  await openPlanned();
  const buttons = dom().querySelectorAll('.cc-panel-links [data-act="link-to-event"]');
  assert.equal(buttons.length, 2);
  assert.ok([...buttons].every((b) => b.textContent === "Link" && !b.classList.contains("primary-button")));
  await openPlanned("planned:p2");
  assert.equal(section().textContent.includes("No event on this day includes all of these athletes."), true);
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  await start({ items: [P1()] });
  await openPlanned();
  assert.equal(section(), null);
});

// --- 4. Unlink ----------------------------------------------------------------------------------

test("4. Unlink a group sends all its link ids; an orphaned row; an activity link and unlink", async () => {
  const { calls, fake } = await start();
  await openEvent();
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  const linkIds = fake.linked.get(E1).sessions[0].links.map((l) => l.id).sort();
  await press(linkButton('[data-act="unlink-sessions"]'));
  await tick();
  const detach = writesOf(calls).at(-1);
  assert.equal(detach.url, `/api/calendar/events/${E1}/sessions/detach`);
  assert.deepEqual(detach.body.linkIds, linkIds, "every link of the group");
  assert.equal(detach.body.expectedRevision, 2);
  assert.ok(linkButton('[data-planned-key="planned:p1"]'), "offered again");
  assert.equal(state.centralCalendar.notice, "Unlinked “Morning session”.");
  // An orphaned link: one row, one Unlink.
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  // The Builder deletes the plan: the links are orphaned (the event's revision
  // stays; a calendar read with a new revision re-reads the manager view).
  fake.linked.get(E1).sessions[0].orphaned = true;
  fake.live.find((item) => item.eventId === E1).revision += 1;
  await act({ action: "central-calendar-retry" });
  await tick();
  assert.match(section().textContent, /1 linked training was deleted in the Builder\./, "one training (two athletes' sessions)");
  await press(linkButton('[data-group="orphaned"]'));
  await tick();
  assert.deepEqual(writesOf(calls).at(-1).body.linkIds.length, 2);
  // An activity.
  await press(linkButton(`[data-activity-key="activity:${ACT1}"]`));
  await tick();
  assert.deepEqual(writesOf(calls).at(-1).body, { ...writesOf(calls).at(-1).body, activityId: ACT1 });
  assert.equal(state.centralCalendar.notice, "Linked “GPS session”.");
  assert.match(section().textContent, /Linked activities/);
  await press(linkButton(`[data-act="unlink-activity"][data-activity-id="${ACT1}"]`));
  await tick();
  assert.equal(writesOf(calls).at(-1).url, `/api/calendar/events/${E1}/activities/detach`);
  assert.equal(state.centralCalendar.notice, "Unlinked the activity.");
});

// --- 5. Align -------------------------------------------------------------------------------------

test("5a. Align only with alignment.pending; its words by expects; the answer's counts in the notice", async () => {
  const items = defaultItems();
  items[0] = { ...items[0], alignment: { pending: 2 } };
  const { calls } = await start({ items });
  await openEvent();
  assert.equal(dom().querySelector('[data-act="align"]').textContent, "Ask RPE in the linked trainings");
  assert.match(section().textContent, /2 linked sessions do not ask for RPE yet\./);
  await press(linkButton('[data-act="align"]'));
  await tick();
  assert.equal(writesOf(calls)[0].url, `/api/calendar/events/${E1}/sessions/align`);
  assert.deepEqual({ ...writesOf(calls)[0].body, requestKey: "k" }, { requestKey: "k", expectedRevision: 1, confirmDisableWithResults: false });
  assert.equal(state.centralCalendar.notice, "RPE is now asked in 2 linked sessions.");
  assert.equal(dom().querySelector('[data-act="align"]'), null, "gone once aligned");
  const off = links.centralCalendarAlignLine({ expects: [], alignment: { pending: 1 } });
  assert.equal(off.button, "Stop asking RPE in the linked trainings");
  assert.equal(off.text, "1 linked session still asks for RPE, which this event does not collect.");
  assert.equal(links.centralCalendarAlignLine({ expects: ["rpe"], alignment: { pending: 0 } }), null);
  assert.equal(links.centralCalendarLinkDoneText("align", { data: { alignment: { direction: "rpe_off", changed: 1, notAllowed: 2, switchOff: 1 } } }),
    "RPE is no longer asked in 1 linked session. 2 belong to another coach's plans and were left as they are. RPE requests are switched off in Training Load, so athletes will not be asked until they are switched on.");
});

test("5b. has_existing_results: the question; No sends nothing more; Yes sends a new key with confirmDisableWithResults", async () => {
  const items = defaultItems();
  items[0] = { ...items[0], expects: [], alignment: { pending: 1 } };
  let refuseOnce = true;
  const refuse = (call) => (call.url.endsWith("/align") && !call.body.confirmDisableWithResults && refuseOnce
    ? { status: 409, body: { error: "has_existing_results", message: "x", resultCount: 3 } } : null);
  const { calls } = await start({ items, refuse });
  await openEvent();
  confirmAnswer = false;
  await press(linkButton('[data-act="align"]'));
  await tick();
  assert.equal(questions[0], "3 RPE answers were already given in these trainings. Stop asking for RPE anyway? The answers are kept.");
  assert.equal(writesOf(calls).length, 1, "No: nothing more");
  confirmAnswer = true;
  await press(linkButton('[data-act="align"]'));
  await tick();
  const [, second, third] = writesOf(calls);
  assert.equal(second.body.confirmDisableWithResults, false);
  assert.equal(third.body.confirmDisableWithResults, true);
  assert.notEqual(third.body.requestKey, second.body.requestKey, "a new key");
  assert.equal(state.centralCalendar.notice, "RPE is no longer asked in 1 linked session.");
});

// --- 6. Refusals -----------------------------------------------------------------------------------

test("6. every refusal code reads as one sentence with no code or id; nothing changes; the next press sends a new key", async () => {
  const cases = [
    ["event_changed", 409, "This event was changed meanwhile. The calendar was read again: try again."],
    ["athlete_not_targeted", 409, "Some athletes of this training are not part of this event. Add them to the event first, or link another training."],
    ["session_outside_event", 409, "This training is not on the event's day. Nothing was saved."],
    ["try_again", 409, "The calendar is busy. Nothing was saved; try again in a moment."],
    ["internal_error", 500, "Nothing was saved. Try again."],
    ["forbidden", 403, "Events cannot be changed in this workspace. Nothing was saved."],
  ];
  for (const [code, status, sentence] of cases) {
    clearAllViewCache();
    resetCentralCalendarForWorkspaceChange();
    let once = true;
    const { calls } = await start({ refuse: () => (once ? ((once = false), { status, body: { error: code, message: "server words" } }) : null) });
    await openEvent();
    await press(linkButton('[data-planned-key="planned:p1"]'));
    await tick();
    const s = section();
    assert.equal(s.querySelector('.cc-link-message[role="alert"]').textContent, sentence, code);
    assert.doesNotMatch(s.textContent, CODES, code);
    assert.doesNotMatch(s.textContent, UUID_ANYWHERE, code);
    assert.doesNotMatch(s.textContent, /server words/);
    assert.ok(linkButton('[data-planned-key="planned:p1"]'), `${code}: still offered`);
    await press(linkButton('[data-planned-key="planned:p1"]'));
    await tick();
    const [first, second] = writesOf(calls);
    assert.notEqual(second.body.requestKey, first.body.requestKey, `${code}: a new key`);
  }
  for (const code of ["link_not_available", "nothing_to_align", "activity_superseded", "activity_outside_event", "activity_not_targeted", "request_key_reused"]) {
    assert.doesNotMatch(links.centralCalendarLinkRefusalText({ status: 409, code }), CODES);
  }
  assert.equal(links.centralCalendarLinkRefusalText({ status: 401, code: "x" }), "Please sign in again. Nothing was saved.");
});

// --- 7. A lost answer -----------------------------------------------------------------------------

test("7. a lost answer: Result not confirmed · Check result sends the same path, body and key; buttons off meanwhile; leaving keeps it", async () => {
  const { calls } = await start({ lose: 1 });
  await openEvent();
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  let s = section();
  assert.match(s.querySelector(".cc-link-unconfirmed").textContent, /The result is not confirmed\./);
  assert.ok([...s.querySelectorAll('[data-action="central-calendar-link"]')].every((b) => b.disabled), "every Link / Unlink off");
  assert.ok(dom().querySelector('[data-action="central-calendar-edit-event"]').disabled, "Edit off");
  assert.ok(dom().querySelector('[data-action="central-calendar-cancel-event"]').disabled, "Cancel event off");
  await act({ action: "central-calendar-edit-event", key: `event:${E1}:${D}`, date: D });
  assert.equal(state.centralCalendar.form, null, "the handler refuses too");
  // Leaving the page asks (a save not confirmed).
  const unload = { isTrusted: true, preventDefault() {}, returnValue: "" };
  assert.equal(handleCentralCalendarBeforeUnload(unload), true);
  confirmAnswer = false;
  assert.equal(centralCalendarMayBeLeft({ final: "sign-out" }), false);
  // Another card and back: it is still there, in the line too.
  await openPlanned("planned:p2");
  assert.match(dom().querySelector(".cc-uncertain-line").textContent, /Check linking for “Team training”/);
  await openEvent();
  s = section();
  const check = s.querySelector('[data-action="central-calendar-link-check"]');
  await act({ ...check.dataset });
  await tick();
  const [first, again] = writesOf(calls);
  assert.equal(again.url, first.url);
  assert.deepEqual(again.body, first.body, "the same body and key");
  assert.equal(centralCalendarUncertainWrites().length, 0, "settled by the replay");
  assert.match(state.centralCalendar.notice, /^Linked “Morning session”\./);
});

test("7b. a check answered try_again stays not confirmed; a settling code ends it with its sentence; the line's button checks too", async () => {
  let mode = "lose";
  const refuse = (call) => {
    if (!call.url.endsWith("/sessions")) return null;
    if (mode === "lose") return { throwNetworkError: true };
    if (mode === "busy") return { status: 409, body: { error: "try_again", message: "x" } };
    if (mode === "settle") return { status: 409, body: { error: "session_already_attached", message: "x" } };
    return null;
  };
  const { calls } = await start({ refuse });
  await openEvent();
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  mode = "busy";
  await act({ action: "central-calendar-link-check", requestKey: writesOf(calls)[0].body.requestKey });
  await tick();
  assert.equal(centralCalendarUncertainWrites().length, 1, "try_again settles nothing");
  assert.match(section().textContent, /the server was busy\. The result is still not confirmed/);
  mode = "settle";
  await act({ action: "central-calendar-event-pending", requestKey: writesOf(calls)[0].body.requestKey });
  await tick();
  assert.equal(centralCalendarUncertainWrites().length, 0);
  assert.equal(new Set(writesOf(calls).map((c) => c.body.requestKey)).size, 1, "every check with the first key");
  assert.equal(section().querySelector(".cc-link-message").textContent, "This training is already linked to another event. Unlink it there first.");
});

// --- 8. One control at a time ------------------------------------------------------------------------

test("8. a double click sends one request; Edit and Cancel event are off while it is in flight", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fake = server();
  const calls = installFetchMock(async (call) => {
    if (call.method === "POST") await gate;
    return fake(call);
  });
  await loadCentralCalendar({ render });
  await tick();
  await openEvent();
  await tick();
  const button = linkButton('[data-planned-key="planned:p1"]');
  const one = press(button);
  const two = press(button);
  await tick();
  assert.equal(writesOf(calls).length, 1, "one request");
  assert.equal(linkButton('[data-planned-key="planned:p1"]').textContent, "Linking…");
  assert.ok(dom().querySelector('[data-action="central-calendar-edit-event"]').disabled);
  assert.equal(section().getAttribute("aria-busy"), "true");
  release();
  await Promise.all([one, two]);
  await tick();
  assert.equal(writesOf(calls).length, 1);
  assert.equal(dom().querySelector('[data-action="central-calendar-edit-event"]').disabled, false);
});

// --- 9. The manager view's states ---------------------------------------------------------------------

test("9. the manager view loading and failing: its sentence and Try again; the suggestions stay usable", async () => {
  let fail = true;
  const { calls } = await start({ eventStatus: () => (fail ? { status: 503, body: { error: "database_busy", message: "x" } } : null) });
  await openEvent();
  await tick();
  let s = section();
  assert.match(s.textContent, /Linked trainings could not be loaded\./);
  assert.ok(linkButton('[data-planned-key="planned:p1"]'), "Link still offered");
  assert.equal(linkButton('[data-planned-key="planned:p1"]').disabled, false);
  fail = false;
  await act({ action: "central-calendar-details-retry" });
  await tick();
  s = section();
  assert.doesNotMatch(s.textContent, /could not be loaded/);
  assert.equal(eventReads(calls).length, 2);
  // While it loads: its own line.
  const cal = state.centralCalendar;
  cal.panelEvent = { key: cal.panel.key, loading: true, error: "", event: null };
  render();
  assert.match(section().textContent, /Loading linked trainings…/);
});

// --- 10. No id or code; empty -------------------------------------------------------------------------

test("10. no id or code in the section's text; the empty line", async () => {
  await start();
  await openEvent();
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  await press(linkButton(`[data-activity-key="activity:${ACT1}"]`));
  await tick();
  const text = section().textContent;
  assert.doesNotMatch(text, UUID_ANYWHERE);
  assert.doesNotMatch(text, CODES);
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  await start({ items: [eventItem(E1, { title: "Lonely", athleteIds: [A3], athleteCount: 1 })] });
  await openEvent();
  await tick();
  assert.match(section().textContent, /No training or activity on this day can be linked to this event\./);
});

// --- 11. The refusals the read cannot predict (the manager's GO) ----------------------------------------

test("11. session_not_available / session_already_attached / activity twins: after the re-read the row stays without its Link; the other side too", async () => {
  for (const [code, kind] of [["session_not_available", "planned"], ["session_already_attached", "planned"], ["activity_not_available", "activity"], ["activity_already_attached", "activity"]]) {
    clearAllViewCache();
    resetCentralCalendarForWorkspaceChange();
    const refuse = (call) => ((kind === "planned" ? call.url.endsWith("/sessions") : call.url.endsWith("/activities")) ? { status: code.endsWith("available") ? 400 : 409, body: { error: code, message: "x" } } : null);
    const { calls } = await start({ refuse });
    await openEvent();
    const selector = kind === "planned" ? '[data-planned-key="planned:p1"]' : `[data-activity-key="activity:${ACT1}"]`;
    const reads = calls.filter((c) => c.url.startsWith("/api/calendar?")).length;
    await press(linkButton(selector));
    await tick();
    assert.ok(calls.filter((c) => c.url.startsWith("/api/calendar?")).length > reads, `${code}: read again`);
    assert.equal(linkButton(selector), null, `${code}: no stale Link`);
    assert.match(section().textContent, /Can't be linked to this event\./, code);
    assert.equal(section().querySelector(".cc-link-message").textContent, links.centralCalendarLinkRefusalText({ status: 409, code }));
    if (kind === "planned") {
      await openPlanned();
      assert.equal(dom().querySelector('.cc-panel-links [data-act="link-to-event"]'), null, `${code}: not from the planned card either`);
      assert.match(section().textContent, /Can't be linked to this event\./);
    }
    assert.equal(writesOf(calls).length, 1);
  }
});

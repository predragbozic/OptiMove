// Central calendar K2c-1 (docs/ai/central-calendar-k2c-plan.md section 1.1):
// linking a Builder training or a recorded activity to an event from the
// calendar's panels, through the real handlers, loaders and templates with a
// fake fetch and JSDOM. The fake keeps the K2a-1b routes' contracts
// (backend/src/calendarEventService.js attachSessions / detachSessions /
// alignSessions / attachActivity / detachActivity, the runner's requestKey
// replay and expectedRevision): a linked planned group folds under its event
// on the next calendar read, a detach brings it back, a refusal changes
// nothing.
import { openEveryPanelSection } from "./support/central-calendar-panel-sections.mjs";
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
  closeCentralCalendarPanel,
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
// The suites written before the redesign see every section open; the layout tests below (section 20) set it false.
let unfold = true;
function render() {
  if (unfold) openEveryPanelSection(state.centralCalendar);
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
// The redesign (2026-11-23): a linked row's Unlink sits in its "⋯" menu; open the row's menu first (the real action),
// then the same Unlink button as before is there.
async function unlinkButton(selector) {
  for (const more of [...dom().querySelectorAll(".cc-panel-links .cc-row-more")]) {
    if (more.getAttribute("aria-expanded") !== "true") await act({ ...more.dataset });
    const button = linkButton(selector);
    if (button) return button;
  }
  return null;
}
// The words of a link command's result in the open panel (review M4).
const said = () => state.centralCalendar.linkMessage?.text ?? null;

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
  unfold = true;
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
  assert.deepEqual(links.centralCalendarEventsForPlanned(data, P_PART()).partial.map((e) => e.eventId), [E1]);
  // Review M2: a linked athlete who is no target any more does not count when the card carries its athletes.
  const withAthletes = { ...event, athletes: [{ athleteId: A1, targeted: true }, { athleteId: A2, targeted: false }, { athleteId: A3, targeted: true }] };
  assert.deepEqual(links.centralCalendarLinkSuggestions(data, withAthletes).trainings.map((x) => x.item.key), [], "A2 is no target: P1 is not covered");
  assert.equal(links.centralCalendarLinkSuggestions({ days: [{ date: D, items: [withAthletes, ACT()] }] }, withAthletes).activities.length, 0, "the activity's only athlete is A2");
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
  assert.equal(s.querySelector("#ccLinksTitle").textContent, "Trainings and activities", "the status line's focus target");
  assert.deepEqual([...s.querySelectorAll(".cc-psec")].map((sec) => sec.dataset.section), ["trainings", "activities"], "two sections");
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
  assert.match(s.querySelector('.cc-psec[data-section="trainings"] .cc-link-heading').textContent, /^Linked$/);
  assert.match(s.querySelector(".cc-link-row").textContent, /Morning session/);
  assert.match(s.querySelector(".cc-link-row").textContent, /AM · Training · 2 athletes/);
  assert.equal(said(), "Linked “Morning session”. These trainings do not ask for RPE yet: use Ask for RPE in the linked trainings.");
  assert.equal(dom().querySelector('.cc-panel-links .cc-link-message[role="status"]').textContent, said(), "in the panel's own line (review M4)");
  assert.equal(state.centralCalendar.notice, "", "not behind the sheet");
  assert.equal(dom().querySelector('[data-act="align"]').textContent, "Ask for RPE in the linked trainings");
  assert.match(section().textContent, /A linked training shows inside this event on the calendar\. To unlink one, use ⋯ on its row\./);
});

// --- 3. Link from a planned card --------------------------------------------------------------

test("3a. a planned card with one covering event: the primary Link to “title”; after it the event's panel opens with the notice", async () => {
  const { calls } = await start();
  await openPlanned();
  const button = linkButton(`[data-event-key="event:${E1}:${D}"]`);
  assert.ok(button.classList.contains("cc-primary"));
  assert.equal(button.textContent, "Link to “Team training”");
  assert.equal(eventReads(calls).length, 0, "a planned card's panel reads no event");
  await press(button);
  await tick();
  assert.equal(writesOf(calls)[0].url, `/api/calendar/events/${E1}/sessions`);
  assert.equal(state.centralCalendar.panel.key, `event:${E1}:${D}`, "the event's panel opened");
  assert.match(said(), /^Linked to “Team training”\. These trainings do not ask for RPE yet/);
});

test("3b. two covering events: two rows with Link; none covering: the quiet line; no manageable event: no section", async () => {
  const items = [...defaultItems(), eventItem(E2, { title: "Extra", athleteIds: [A1, A2], athleteCount: 2 })];
  await start({ items });
  await openPlanned();
  const buttons = dom().querySelectorAll('.cc-panel-links [data-act="link-to-event"]');
  assert.equal(buttons.length, 2);
  assert.ok([...buttons].every((b) => b.textContent === "Link" && !b.classList.contains("cc-primary")));
  await openPlanned("planned:p2");
  assert.match(section().textContent, /“Team training” does not include all of these athletes\. Add them to the event, then link\./);
  assert.match(section().textContent, /“Extra” does not include all of these athletes\./);
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
  await press(await unlinkButton('[data-act="unlink-sessions"]'));
  await tick();
  const detach = writesOf(calls).at(-1);
  assert.equal(detach.url, `/api/calendar/events/${E1}/sessions/detach`);
  assert.deepEqual(detach.body.linkIds, linkIds, "every link of the group");
  assert.equal(detach.body.expectedRevision, 2);
  assert.ok(linkButton('[data-planned-key="planned:p1"]'), "offered again");
  assert.equal(said(), "Unlinked “Morning session”.");
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
  assert.match(section().textContent, /Unlink to clear it; nothing else changes\./);
  await press(await unlinkButton('[data-group="orphaned"]'));
  await tick();
  assert.deepEqual(writesOf(calls).at(-1).body.linkIds.length, 2);
  // An activity.
  await press(linkButton(`[data-activity-key="activity:${ACT1}"]`));
  await tick();
  assert.deepEqual(writesOf(calls).at(-1).body, { ...writesOf(calls).at(-1).body, activityId: ACT1 });
  assert.equal(said(), "Linked “GPS session”.");
  assert.match(section().querySelector('.cc-psec[data-section="activities"] .cc-link-heading').textContent, /^Linked$/);
  await press(await unlinkButton(`[data-act="unlink-activity"][data-activity-id="${ACT1}"]`));
  await tick();
  assert.equal(writesOf(calls).at(-1).url, `/api/calendar/events/${E1}/activities/detach`);
  assert.equal(said(), "Unlinked the activity.");
});

// --- 5. Align -------------------------------------------------------------------------------------

test("5a. Align: one line without a number; the first press shows the step and sends nothing; Not now; the second press sends; the notice without a count", async () => {
  const items = defaultItems();
  items[0] = { ...items[0], alignment: { pending: 2 } };
  const { calls } = await start({ items });
  await openEvent();
  assert.equal(dom().querySelector('[data-act="align"]').textContent, "Ask for RPE in the linked trainings");
  assert.match(section().textContent, /The linked trainings do not ask for RPE yet\./);
  assert.doesNotMatch(section().querySelector(".cc-link-align").textContent, /\d/, "no number");
  await press(linkButton('[data-act="align"]'));
  assert.equal(writesOf(calls).length, 0, "the first press only shows the step");
  assert.match(section().querySelector(".cc-link-align").textContent, /Athletes of the linked trainings will be asked for RPE after each training\./);
  await act({ action: "central-calendar-align-cancel" });
  assert.equal(dom().querySelector('[data-act="align-confirm"]'), null, "Not now folds it");
  assert.equal(writesOf(calls).length, 0);
  await press(linkButton('[data-act="align"]'));
  const confirm = linkButton('[data-act="align-confirm"]');
  assert.equal(confirm.textContent, "Ask for RPE");
  assert.ok(dom().querySelector('[data-action="central-calendar-align-cancel"]'), "Not now");
  await press(confirm);
  await tick();
  assert.equal(writesOf(calls)[0].url, `/api/calendar/events/${E1}/sessions/align`);
  assert.deepEqual({ ...writesOf(calls)[0].body, requestKey: "k" }, { requestKey: "k", expectedRevision: 1, confirmDisableWithResults: false });
  assert.equal(said(), "The linked trainings now ask for RPE.");
  assert.equal(dom().querySelector('[data-act="align"]'), null, "gone once aligned");
  const off = links.centralCalendarAlignLine({ expects: [], alignment: { pending: 1 } });
  assert.equal(off.button, "Stop asking for RPE in the linked trainings");
  assert.equal(off.text, "The linked trainings still ask for RPE, which this event does not collect.");
  assert.equal(off.step, "Athletes of the linked trainings will no longer be asked for RPE.");
  assert.equal(off.confirm, "Stop asking");
  assert.equal(links.centralCalendarAlignLine({ expects: ["rpe"], alignment: { pending: 0 } }), null);
  assert.equal(links.centralCalendarLinkDoneText("align", { data: { alignment: { direction: "rpe_off", changed: 1, notAllowed: 2, switchOff: 1 } } }),
    "The linked trainings you manage no longer ask for RPE. RPE requests are switched off in Training Load, so athletes will not be asked until they are switched on.");
});

test("5b. has_existing_results: the question in the Align row; Not now sends nothing more; Stop asking sends a new key with confirmDisableWithResults", async () => {
  const items = defaultItems();
  items[0] = { ...items[0], expects: [], alignment: { pending: 1 } };
  const refuse = (call) => (call.url.endsWith("/align") && !call.body.confirmDisableWithResults
    ? { status: 409, body: { error: "has_existing_results", message: "x", resultCount: 3 } } : null);
  const { calls } = await start({ items, refuse });
  await openEvent();
  await press(linkButton('[data-act="align"]'));
  await press(linkButton('[data-act="align-confirm"]'));
  await tick();
  assert.equal(questions.length, 0, "no confirm()");
  assert.match(section().querySelector(".cc-link-align").textContent, /Stop asking for RPE in the linked trainings\? 3 RPE answers were already given; they are kept\./);
  await act({ action: "central-calendar-align-cancel" });
  assert.equal(writesOf(calls).length, 1, "Not now: nothing more");
  await press(linkButton('[data-act="align"]'));
  await press(linkButton('[data-act="align-confirm"]'));
  await tick();
  const results = linkButton('[data-act="align-results"]');
  assert.equal(results.textContent, "Stop asking");
  await press(results);
  await tick();
  const [, second, third] = writesOf(calls);
  assert.equal(second.body.confirmDisableWithResults, false);
  assert.equal(third.body.confirmDisableWithResults, true);
  assert.notEqual(third.body.requestKey, second.body.requestKey, "a new key");
  assert.equal(said(), "The linked trainings no longer ask for RPE.");
});

test("5c. Align that changes nothing here (changed 0, notAllowed > 0): the sentence, and no Align until the event's revision moves; the row stays drawn but off during another write", async () => {
  const items = defaultItems();
  items[0] = { ...items[0], alignment: { pending: 1 } };
  const fake = server({ items });
  const calls = installFetchMock((call) => {
    if (call.url.endsWith("/align")) {
      fake.live[0].revision += 1;
      return { status: 200, body: { alignment: { direction: "rpe_on", changed: 0, unchanged: 0, notAllowed: 1, switchOff: 0 } } };
    }
    return fake(call);
  });
  await loadCentralCalendar({ render });
  await tick();
  await openEvent();
  // During another write the Align row is drawn, its button off (review M3).
  state.centralCalendar.linkWrite = { act: "link-session", plannedKey: "planned:p1" };
  render();
  assert.ok(linkButton('[data-act="align"]').disabled, "drawn, off");
  state.centralCalendar.linkWrite = null;
  render();
  await press(linkButton('[data-act="align"]'));
  await press(linkButton('[data-act="align-confirm"]'));
  await tick();
  assert.equal(said(), "Some linked trainings can't be changed from here. Their plan's coach can change them in the Builder.");
  assert.equal(linkButton('[data-act="align"]'), null, "not offered again");
  assert.match(section().querySelector(".cc-link-align").textContent, /Some linked trainings can't be changed from here\. Their plan's coach can change them in the Builder\./);
  fake.live[0].revision += 1;
  await act({ action: "central-calendar-retry" });
  await tick();
  assert.ok(linkButton('[data-act="align"]'), "offered again once the event moved");
  assert.equal(writesOf(calls).length, 1);
});

// --- 6. Refusals -----------------------------------------------------------------------------------

test("6. every refusal code reads as one sentence with no code or id; nothing changes; the next press sends a new key", async () => {
  const cases = [
    ["event_changed", 409, "This event was changed meanwhile. The calendar was read again: try again."],
    ["session_outside_event", 409, "This training is not on the event's day. Nothing was saved."],
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
  assert.equal(links.centralCalendarLinkRefusalText({ status: 409, code: "session_already_attached" }), "This training is already linked to another event you can't open here. Ask that event's organiser to unlink it. Nothing was saved.");
  assert.equal(links.centralCalendarLinkRefusalText({ status: 409, code: "activity_already_attached" }), "This activity is already linked to another event you can't open here. Ask that event's organiser to unlink it. Nothing was saved.");
  assert.equal(links.centralCalendarLinkRefusalText({ status: 400, code: "session_not_available" }), "This training can't be linked to this event: it may have changed in the Builder, or its plan belongs to another club or team. Nothing was saved.");
  for (const code of ["link_not_available", "nothing_to_align", "activity_superseded", "activity_outside_event", "activity_not_targeted", "request_key_reused", "athlete_not_targeted"]) {
    assert.doesNotMatch(links.centralCalendarLinkRefusalText({ status: 409, code }), CODES);
  }
  assert.equal(links.centralCalendarLinkRefusalText({ status: 401, code: "x" }), "Please sign in again. Nothing was saved.");
  // The event's RPE channel (FE-FOLLOWUPS 1): one plain sentence with its next step, never the generic one, and a
  // Check result answered with one of them settles the write (the replay comes first on the server).
  assert.equal(links.centralCalendarLinkRefusalText({ status: 409, code: "rpe_already_linked" }), "This event already collects RPE through another schedule; remove it first. Nothing was saved.");
  for (const code of ["rpe_already_linked", "rpe_already_answered", "rpe_from_question"]) {
    const text = links.centralCalendarLinkRefusalText({ status: 409, code });
    assert.notEqual(text, "Nothing was saved. Try again.", code);
    assert.match(text, /Nothing was saved\.$/, code);
    assert.doesNotMatch(text, CODES, code);
    assert.doesNotMatch(text, /rpe_/, code);
    assert.equal(links.centralCalendarLinkCheckSettles({ status: 409, code }), true, `${code}: settles a check`);
  }
  assert.equal(links.centralCalendarLinkCheckSettles({ status: 409, code: "try_again" }), false);
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
  assert.match(said(), /^Linked “Morning session”\./);
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
  assert.equal(section().querySelector(".cc-link-message").textContent, links.centralCalendarLinkRefusalText({ status: 409, code: "session_already_attached" }));
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
  // Review M1: the page's own leave and the final leave cover a link in flight.
  assert.equal(handleCentralCalendarBeforeUnload({ isTrusted: true, preventDefault() {}, returnValue: "" }), true, "beforeunload");
  confirmAnswer = false;
  assert.equal(centralCalendarMayBeLeft({ final: "sign-out" }), false, "the final leave asks");
  assert.match(questions.at(-1), /^A link is still being saved\. Sign out anyway\?/);
  confirmAnswer = true;
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
  assert.match(s.textContent, /Linked trainings and activities could not be loaded\./);
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

test("11. the refusals the read cannot predict (and the two 'not targeted' ones, review M2): refused once, then the row keeps a short reason and no Link, on both sides", async () => {
  const cases = [
    ["session_not_available", "planned", 400, "Can't be linked here."],
    ["session_already_attached", "planned", 409, "Already linked to another event."],
    ["athlete_not_targeted", "planned", 409, "Some athletes are not in this event."],
    ["activity_not_available", "activity", 400, "Can't be linked here."],
    ["activity_already_attached", "activity", 409, "Already linked to another event."],
    ["activity_not_targeted", "activity", 409, "Some athletes are not in this event."],
  ];
  for (const [code, kind, status, reason] of cases) {
    clearAllViewCache();
    resetCentralCalendarForWorkspaceChange();
    const refuse = (call) => ((kind === "planned" ? call.url.endsWith("/sessions") : call.url.endsWith("/activities")) ? { status, body: { error: code, message: "x" } } : null);
    const { calls } = await start({ refuse });
    await openEvent();
    const selector = kind === "planned" ? '[data-planned-key="planned:p1"]' : `[data-activity-key="activity:${ACT1}"]`;
    const reads = calls.filter((c) => c.url.startsWith("/api/calendar?")).length;
    await press(linkButton(selector));
    await tick();
    assert.ok(calls.filter((c) => c.url.startsWith("/api/calendar?")).length > reads, `${code}: read again`);
    assert.equal(linkButton(selector), null, `${code}: no stale Link`);
    assert.equal(section().querySelector(".cc-link-refused").textContent, reason, code);
    assert.equal(section().querySelector(".cc-link-message").textContent, links.centralCalendarLinkRefusalText({ status, code }));
    if (kind === "planned") {
      await openPlanned();
      assert.equal(dom().querySelector('.cc-panel-links [data-act="link-to-event"]'), null, `${code}: not from the planned card either`);
      assert.equal(section().querySelector(".cc-link-refused").textContent, reason);
    }
    assert.equal(writesOf(calls).length, 1, `${code}: refused once, never sent again`);
  }
});

test("11b. two activities, one refused: the other keeps its Link", async () => {
  const ACT2 = "a0000000-0000-4000-8000-000000000002";
  const items = [...defaultItems(), baseItem({ key: `activity:${ACT2}`, kind: "activity", title: "Second GPS", origin: "api_import", athleteIds: [A1], athleteCount: 1, links: { activityIds: [ACT2] } })];
  const refuse = (call) => (call.url.endsWith("/activities") && call.body.activityId === ACT1 ? { status: 409, body: { error: "activity_already_attached", message: "x" } } : null);
  await start({ items, refuse });
  await openEvent();
  await press(linkButton(`[data-activity-key="activity:${ACT1}"]`));
  await tick();
  assert.equal(linkButton(`[data-activity-key="activity:${ACT1}"]`), null);
  assert.ok(linkButton(`[data-activity-key="activity:${ACT2}"]`), "the other keeps Link");
});

// --- Review round (K2c-1 1.2): M1, M4, M5, LOWs --------------------------------------------------------

function gated(fake, { lose = false } = {}) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = installFetchMock(async (call) => {
    if (call.method === "POST") {
      await gate;
      if (lose) return { throwNetworkError: true };
    }
    return fake(call);
  });
  return { calls, release: () => release() };
}

test("7c. a workspace switch while a link is in flight: asked, kept to check with the same key (mode link), still there after a lost answer; a confirmed answer on the replaced slice ends the wait", async () => {
  for (const lose of [true, false]) {
    clearAllViewCache();
    resetCentralCalendarForWorkspaceChange();
    clearCentralCalendarUncertainWrites();
    questions.length = 0;
    const fake = server();
    const { calls, release } = gated(fake, { lose });
    await loadCentralCalendar({ render });
    await tick();
    await openEvent();
    await tick();
    const sending = press(linkButton('[data-planned-key="planned:p1"]'));
    await tick();
    confirmAnswer = false;
    assert.equal(centralCalendarMayBeLeft(), false, "No keeps the user here");
    assert.equal(questions.at(-1), "A link is still being saved. Leave anyway? You can check it later under the event.");
    assert.equal(centralCalendarUncertainWrites().length, 0, "nothing kept on No");
    confirmAnswer = true;
    assert.equal(centralCalendarMayBeLeft(), true);
    const kept = centralCalendarUncertainWrites();
    assert.equal(kept.length, 1);
    assert.equal(kept[0].mode, "link");
    assert.equal(kept[0].requestKey, writesOf(calls)[0].body.requestKey, "the same key");
    // The workspace switch replaces the slice before the answer comes.
    resetCentralCalendarForWorkspaceChange();
    release();
    await sending;
    await tick();
    assert.equal(centralCalendarUncertainWrites().length, lose ? 1 : 0, lose ? "a lost answer: still to check" : "confirmed: the wait ended");
  }
});

test("7d. Check linking… from the calendar line opens that write's panel first and shows its result there; the planned card's Link to the same event is off meanwhile", async () => {
  const { calls } = await start({ lose: 1 });
  await openPlanned();
  await press(linkButton(`[data-event-key="event:${E1}:${D}"]`));
  await tick();
  // The planned card's own panel is locked by its unconfirmed link (review LOW).
  assert.ok(linkButton(`[data-event-key="event:${E1}:${D}"]`).disabled, "own panel locked");
  // Another planned card of the day offers the same event, off while the event's link waits (8b).
  await act({ action: "central-calendar-close-panel" });
  assert.equal(state.centralCalendar.panel.open, false);
  const line = dom().querySelector('.cc-uncertain-line [data-action="central-calendar-event-pending"]');
  assert.match(line.textContent, /Check linking for “Team training”/);
  await act({ ...line.dataset });
  await tick();
  assert.equal(state.centralCalendar.panel.open, true, "the panel opened (review M5)");
  assert.equal(writesOf(calls).length, 2);
  assert.deepEqual(writesOf(calls)[1].body, writesOf(calls)[0].body);
  assert.match(said(), /^Linked to “Team training”\./);
  assert.equal(state.centralCalendar.notice, "");
});

test("8b. a planned card's Link to “X” is off while a link of event X waits to be checked", async () => {
  const items = [...defaultItems(), plannedItem("planned:p5", "Evening", [A3], ["10000000-0000-4000-8000-000000000005"], [PLAN2], { slot: { amPm: "PM", bta: "A", order: 1 } })];
  await start({ items, lose: 1 });
  await openEvent();
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  assert.equal(centralCalendarUncertainWrites().length, 1);
  await openPlanned("planned:p5");
  assert.ok(linkButton(`[data-event-key="event:${E1}:${D}"]`).disabled, "off while event X waits");
});

test("M4. sentences whose section disappears go to the screen's line: event_cancelled, and a 404 that closes the panel", async () => {
  for (const [status, code, after] of [[409, "event_cancelled", (fake) => Object.assign(fake.live[0], { cancelled: true, status: "cancelled" })], [404, "notFound", (fake) => fake.live.splice(0, 1)]]) {
    clearAllViewCache();
    resetCentralCalendarForWorkspaceChange();
    let fakeRef = null;
    const refuse = (call) => (call.url.endsWith("/sessions") ? (after(fakeRef), { status, body: { error: code, message: "x" } }) : null);
    const fake = server({ refuse });
    fakeRef = fake;
    installFetchMock(fake);
    await loadCentralCalendar({ render });
    await tick();
    await openEvent();
    await press(linkButton('[data-planned-key="planned:p1"]'));
    await tick();
    assert.equal(section()?.querySelector(".cc-link-message") ?? null, null, `${code}: not in a panel that is gone`);
    assert.equal(state.centralCalendar.notice, links.centralCalendarLinkRefusalText({ status, code }), code);
  }
});

test("MC/MD/ME. the D panel lists and unlinks only D's links; the manager view's newer revision goes in the body", async () => {
  const D1 = DAY(2);
  const mk = (id, day, athleteId) => ({ id, planId: PLAN1, day, amPm: "AM", bta: "T", order: 1, state: "linked", sessionName: "Morning session", sessionNameAtLink: "Morning session", logicalSessionId: L1, athleteId, asksRpe: false, aligned: true });
  const linkD = ["f0000000-0000-4000-8000-0000000000d1", "f0000000-0000-4000-8000-0000000000d2"];
  const linkNext = "f0000000-0000-4000-8000-0000000000e1";
  const items = defaultItems();
  items[0] = { ...items[0], span: { from: D, to: D1 } };
  const managerView = { id: E1, title: "Team training", revision: 5, expects: ["rpe"], canManage: true, status: "planned", fields: [],
    sessionLinks: [mk(linkD[1], D, A2), mk(linkD[0], D, A1), mk(linkNext, D1, A1)], activityLinks: [], alignment: { pending: 0 } };
  const refuse = (call) => (call.url.endsWith("/sessions/detach") ? { status: 200, body: { detached: 2 } } : null);
  const { calls } = await start({ items, refuse, eventStatus: () => ({ status: 200, body: { event: managerView } }) });
  await openEvent();
  await tick();
  assert.equal(section().querySelectorAll(".cc-row-more").length, 1, "one row: D's");
  const rows = [await unlinkButton('[data-act="unlink-sessions"]')];
  assert.match(section().textContent, /2 athletes/, "D's two links only");
  await press(rows[0]);
  await tick();
  const detach = writesOf(calls).find((c) => c.url.endsWith("/sessions/detach"));
  assert.deepEqual(detach.body.linkIds, [...linkD].sort(), "only D's links");
  assert.equal(detach.body.expectedRevision, 5, "the manager view's newer revision (ME)");
});

test("F5 (as built). two same-named trainings in one slot with different orders stay two rows", () => {
  const view = { sessionLinks: [
    { id: "1", day: D, amPm: "AM", bta: "T", order: 1, state: "linked", sessionName: "Run", athleteId: A1 },
    { id: "2", day: D, amPm: "AM", bta: "T", order: 2, state: "linked", sessionName: "Run", athleteId: A2 },
  ] };
  assert.equal(links.centralCalendarSessionLinkGroups(view, D).groups.length, 2);
});

test("7e. a planned card's own unconfirmed link locks its whole panel: Link to another event of the day is off too", async () => {
  const items = [...defaultItems(), eventItem(E2, { title: "Extra", athleteIds: [A1, A2], athleteCount: 2 })];
  await start({ items, lose: 1 });
  await openPlanned();
  await press(linkButton(`[data-event-key="event:${E1}:${D}"]`));
  await tick();
  assert.ok(linkButton(`[data-event-key="event:${E2}:${D}"]`).disabled, "the other event's Link is off");
  assert.ok(section().querySelector('[data-action="central-calendar-link-check"]'), "Check result in this panel");
});


// --- The last round (1.2.2): N1, N2, LOWs ---------------------------------------------------------------

test("11c. a 'not targeted' refusal holds only for the event's revision: once the event moves (the athletes added), Link is offered again", async () => {
  let refuseNow = true;
  const refuse = (call) => (call.url.endsWith("/sessions") && refuseNow ? { status: 409, body: { error: "athlete_not_targeted", message: "x" } } : null);
  const fake = server({ refuse });
  const calls = installFetchMock(fake);
  await loadCentralCalendar({ render });
  await tick();
  await openEvent();
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  assert.equal(linkButton('[data-planned-key="planned:p1"]'), null);
  assert.equal(section().querySelector(".cc-link-refused").textContent, "Some athletes are not in this event.");
  // The coach adds the athletes to the event: its revision moves.
  fake.live[0].revision += 1;
  refuseNow = false;
  await act({ action: "central-calendar-retry" });
  await tick();
  assert.ok(linkButton('[data-planned-key="planned:p1"]'), "offered again");
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  assert.equal(writesOf(calls).length, 2);
  assert.equal(writesOf(calls)[1].body.expectedRevision, 2);
  // An "already attached" refusal stays whatever the revision.
  assert.equal(links.centralCalendarLinkSuggestions({ days: [{ date: D, items: [{ ...defaultItems()[0], revision: 9 }, P1()] }] }, { ...defaultItems()[0], revision: 9 },
    new Map([[links.centralCalendarRefusedPairKey(E1, P1()), { code: "session_already_attached", revision: 1 }]])).trainings[0].refused, "Already linked to another event.");
});

test("5c'. a partial Align (changed 1, notAllowed 1): 'the linked trainings you manage', and the row says the rest without offering Align again", async () => {
  const items = defaultItems();
  items[0] = { ...items[0], alignment: { pending: 2 } };
  const fake = server({ items });
  installFetchMock((call) => {
    if (call.url.endsWith("/align")) {
      Object.assign(fake.live[0], { revision: fake.live[0].revision + 1, alignment: { pending: 1 } });
      return { status: 200, body: { alignment: { direction: "rpe_on", changed: 1, unchanged: 0, notAllowed: 1, switchOff: 0 } } };
    }
    return fake(call);
  });
  await loadCentralCalendar({ render });
  await tick();
  await openEvent();
  await press(linkButton('[data-act="align"]'));
  await press(linkButton('[data-act="align-confirm"]'));
  await tick();
  assert.equal(said(), "The linked trainings you manage now ask for RPE.");
  assert.equal(linkButton('[data-act="align"]'), null, "not offered again");
  assert.equal(section().querySelector(".cc-link-align").textContent.trim(), "Some linked trainings can't be changed from here. Their plan's coach can change them in the Builder.");
});

test("5d. an Align step does not survive a re-read that moved the event: the step is gone and the first-step label follows the new expects", async () => {
  const items = defaultItems();
  items[0] = { ...items[0], expects: [], alignment: { pending: 1 } };
  const refuse = (call) => (call.url.endsWith("/align") ? { status: 409, body: { error: "has_existing_results", message: "x", resultCount: 2 } } : null);
  const fake = server({ items, refuse });
  installFetchMock(fake);
  await loadCentralCalendar({ render });
  await tick();
  await openEvent();
  await press(linkButton('[data-act="align"]'));
  await press(linkButton('[data-act="align-confirm"]'));
  await tick();
  assert.ok(linkButton('[data-act="align-results"]'), "the results step");
  Object.assign(fake.live[0], { revision: fake.live[0].revision + 1, expects: ["rpe"] });
  await act({ action: "central-calendar-retry" });
  await tick();
  assert.equal(linkButton('[data-act="align-results"]'), null, "the step is gone");
  assert.equal(linkButton('[data-act="align"]').textContent, "Ask for RPE in the linked trainings");
});

test("8c. while a link is being saved: New event and the line's checks are off; closing a form never asks the link question", async () => {
  await start({ lose: 1 });
  await openEvent();
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  const cal = state.centralCalendar;
  cal.linkWrite = { act: "link-session", plannedKey: "planned:p1" };
  render();
  assert.ok(dom().querySelector('[data-action="central-calendar-new-event"]').disabled, "New event off");
  assert.ok(dom().querySelector('.cc-uncertain-line [data-action="central-calendar-event-pending"]').disabled, "the line's check off");
  await act({ action: "central-calendar-new-event" });
  assert.equal(cal.form, null, "the handler refuses too");
  // A form open while a link is in flight (forced): closing it asks nothing about the link.
  cal.form = { mode: "create", draft: {}, dirty: false };
  questions.length = 0;
  await act({ action: "central-calendar-event-form-close" });
  assert.equal(cal.form, null);
  assert.equal(questions.length, 0, "no link question on a form close");
  cal.linkWrite = null;
});

// --- 20. The event panel's layout (the owner's redesign of 2026-11-23) --------------------------------------------
// The sections fold; their headers and the "In this event" chips open them; a linked row's Unlink is in its "⋯" menu;
// Edit · Cancel event · Delete sit together at the bottom. None of it sends anything.

const sectionEl = (id, doc = dom()) => doc.querySelector(`.cc-psec[data-section="${id}"]`);
const toggleOf = (id, doc = dom()) => doc.querySelector(`.cc-psec-toggle[data-key="${id}"]`);
// The real action with the header's own aria-expanded (what a click on it carries).
const pressToggle = (id) => {
  const button = toggleOf(id);
  return handleCentralCalendarAction(fakeAction({ ...button.dataset }, { getAttribute: (name) => button.getAttribute(name) }), { render });
};

test("20a. a manager's event: the summary row counts each kind; linked lists, athletes and details are folded; the day's offer opens Trainings", async () => {
  unfold = false;
  const { calls, fake } = await start();
  await openEvent();
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  let doc = dom();
  const chips = [...doc.querySelectorAll(".cc-panel-summary .cc-sum-chip")];
  assert.deepEqual(chips.map((chip) => [chip.dataset.key, chip.querySelector(".cc-sum-count").textContent]), [["trainings", "1"], ["activities", "0"]]);
  assert.equal(chips[0].getAttribute("aria-label"), "Trainings: 1. Show");
  // Align asks a decision about the linked training: Trainings is open by default; the activity's offer opens its own.
  assert.equal(toggleOf("trainings", doc).getAttribute("aria-expanded"), "true");
  assert.ok(doc.querySelector('#ccSec-trainings [data-act="align"]'));
  assert.equal(toggleOf("trainings", doc).getAttribute("aria-controls"), "ccSec-trainings");
  // Folded once the coach closes it: the body holds no controls.
  await pressToggle("trainings");
  doc = dom();
  assert.equal(toggleOf("trainings", doc).getAttribute("aria-expanded"), "false");
  assert.equal(doc.querySelector("#ccSec-trainings").hasAttribute("hidden"), true);
  assert.equal(doc.querySelector("#ccSec-trainings").children.length, 0, "a folded body holds no controls");
  assert.equal(toggleOf("activities", doc).getAttribute("aria-expanded"), "true", "an offer to link: open by default");
  assert.ok(linkButton(`[data-activity-key="activity:${ACT1}"]`));
  assert.equal(toggleOf("athletes", doc).getAttribute("aria-expanded"), "false", "Athletes folded with its count");
  assert.match(toggleOf("athletes", doc).textContent, /Athletes\s*3/, "the event's three athletes");
  assert.equal(doc.querySelector(".cc-athletes"), null);
  // The result line of the link stays in view while Trainings is folded.
  assert.equal(doc.querySelector('.cc-panel-links > .cc-link-message[role="status"]').textContent, said());
  assert.equal(writesOf(calls).length, 1, "only the Link sent anything");
  assert.ok(fake);
});

test("20b. a header opens and closes its section; a summary chip opens it; nothing is sent; another panel starts folded again", async () => {
  unfold = false;
  const { calls } = await start();
  await openEvent();
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  const before = calls.length;
  await pressToggle("trainings");
  assert.equal(toggleOf("trainings").getAttribute("aria-expanded"), "false", "open by default (Align): the header closes it");
  await pressToggle("trainings");
  let doc = dom();
  assert.equal(toggleOf("trainings", doc).getAttribute("aria-expanded"), "true");
  assert.equal(doc.querySelector("#ccSec-trainings").hasAttribute("hidden"), false);
  assert.match(sectionEl("trainings", doc).textContent, /Morning session/);
  assert.equal(doc.querySelectorAll('.cc-psec[data-section="trainings"] .cc-link-hint').length, 1, "one explanation for the section");
  await pressToggle("trainings");
  assert.equal(toggleOf("trainings").getAttribute("aria-expanded"), "false");
  // The chip only opens (a second press keeps it open).
  await act({ action: "central-calendar-panel-reveal", key: "athletes" });
  await act({ action: "central-calendar-panel-reveal", key: "trainings" });
  await act({ action: "central-calendar-panel-reveal", key: "trainings" });
  assert.equal(toggleOf("trainings").getAttribute("aria-expanded"), "true");
  assert.equal(calls.length, before, "opening and closing sends nothing");
  // A repaint (the calendar read again) keeps what the coach opened.
  await act({ action: "central-calendar-retry" });
  await tick();
  assert.equal(toggleOf("trainings").getAttribute("aria-expanded"), "true");
  await pressToggle("athletes");
  assert.equal(toggleOf("athletes").getAttribute("aria-expanded"), "false");
  // Another item: its sections start from their defaults (Athletes folded again after the coach opened it).
  await act({ action: "central-calendar-panel-reveal", key: "athletes" });
  await openPlanned();
  await openEvent();
  assert.equal(toggleOf("athletes").getAttribute("aria-expanded"), "false");
});

test("20c. a linked row's '⋯' opens a menu with the same Unlink; one menu at a time; Escape closes it first and the panel stays", async () => {
  unfold = false;
  const { calls, fake } = await start();
  await openEvent();
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  await press(linkButton(`[data-activity-key="activity:${ACT1}"]`));
  await tick();
  await act({ action: "central-calendar-panel-reveal", key: "trainings" });
  await act({ action: "central-calendar-panel-reveal", key: "activities" });
  let doc = dom();
  assert.equal(doc.querySelectorAll('[data-act^="unlink"]').length, 0, "no Unlink until its menu opens");
  const mores = [...doc.querySelectorAll(".cc-row-more")];
  assert.equal(mores.length, 2);
  assert.deepEqual(mores.map((b) => b.getAttribute("aria-label")), ["More for Morning session", "More for GPS session"]);
  assert.ok(mores.every((b) => b.getAttribute("aria-expanded") === "false"));
  await act({ ...mores[0].dataset });
  doc = dom();
  assert.equal(doc.querySelectorAll(".cc-row-menu").length, 1);
  const unlink = doc.querySelector('.cc-row-menu [data-act="unlink-sessions"]');
  assert.equal(unlink.getAttribute("aria-label"), "Unlink Morning session");
  assert.equal(doc.querySelector(".cc-row-more").getAttribute("aria-expanded"), "true");
  assert.equal(doc.querySelectorAll(".cc-row-more")[1].hasAttribute("aria-controls"), false, "a closed menu names no element");
  assert.equal(doc.querySelector(".cc-row-menu").id, doc.querySelector(".cc-row-more").getAttribute("aria-controls"));
  // The other row's menu replaces it.
  await act({ ...dom().querySelectorAll(".cc-row-more")[1].dataset });
  doc = dom();
  assert.equal(doc.querySelectorAll(".cc-row-menu").length, 1);
  assert.ok(doc.querySelector(`.cc-row-menu [data-act="unlink-activity"][data-activity-id="${ACT1}"]`));
  // Escape closes the menu, not the panel (the real page holds the drawn menu).
  const fakeDocument = globalThis.document;
  globalThis.document = dom();
  try {
    assert.equal(closeCentralCalendarPanel(render), true);
  } finally {
    globalThis.document = fakeDocument;
  }
  assert.equal(state.centralCalendar.panel.open, true);
  assert.equal(dom().querySelectorAll(".cc-row-menu").length, 0);
  // The Unlink in the menu sends what it sent before.
  await act({ ...dom().querySelectorAll(".cc-row-more")[0].dataset });
  const linkIds = fake.linked.get(E1).sessions[0].links.map((l) => l.id).sort();
  await press(dom().querySelector('.cc-row-menu [data-act="unlink-sessions"]'));
  await tick();
  const detach = writesOf(calls).at(-1);
  assert.equal(detach.url, `/api/calendar/events/${E1}/sessions/detach`);
  assert.deepEqual(detach.body.linkIds, linkIds);
});

test("20d. Edit · Cancel event · Delete sit together at the bottom, after every section", async () => {
  unfold = false;
  await start();
  await openEvent();
  const panel = dom().querySelector(".cc-panel");
  const bottom = panel.querySelector(".cc-panel-bottom");
  assert.ok(bottom);
  assert.deepEqual([...bottom.querySelectorAll("button")].map((b) => b.dataset.action).slice(0, 2), ["central-calendar-edit-event", "central-calendar-cancel-event"]);
  const sections = [...panel.querySelectorAll(".cc-psec")];
  assert.ok(sections.length >= 3);
  assert.ok(sections.every((sec) => sec.compareDocumentPosition(bottom) & 4), "the actions come after the sections");
  assert.equal(panel.querySelectorAll(".cc-panel-actions").length, 1, "one place for the event's acts");
});

test("20e. a menu whose row left the screen (its section folded) does not take Escape: the panel closes at once", async () => {
  unfold = false;
  await start();
  await openEvent();
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  await act({ ...dom().querySelector(".cc-psec[data-section='trainings'] .cc-row-more").dataset });
  assert.equal(dom().querySelectorAll(".cc-row-menu").length, 1);
  await pressToggle("trainings");
  assert.equal(state.centralCalendar.panelView.menu, "", "folding the section forgets its menu");
  // Even a menu remembered but not drawn: Escape goes on to close the panel.
  state.centralCalendar.panelView = { ...state.centralCalendar.panelView, menu: "session:gone" };
  const fake = globalThis.document;
  globalThis.document = dom();
  try {
    assert.equal(closeCentralCalendarPanel(render), true);
  } finally {
    globalThis.document = fake;
  }
  assert.equal(state.centralCalendar.panel.open, false);
});

test("20f. the section the coach acts in stays open after the answer: linking the last offer does not fold Trainings", async () => {
  unfold = false;
  await start();
  await openEvent();
  // Open by default for its offer; the coach links it - no offer is left and Align is answered "Not now".
  assert.equal(toggleOf("trainings").getAttribute("aria-expanded"), "true");
  await press(linkButton('[data-planned-key="planned:p1"]'));
  await tick();
  assert.equal(linkButton('[data-planned-key="planned:p1"]'), null, "no offer left");
  assert.equal(toggleOf("trainings").getAttribute("aria-expanded"), "true", "the new linked row stays in view");
  assert.match(sectionEl("trainings").textContent, /Morning session/);
  // The activity: its offer opened GPS and activities; once linked nothing else keeps it open - the act does.
  assert.equal(toggleOf("activities").getAttribute("aria-expanded"), "true");
  await press(linkButton(`[data-activity-key="activity:${ACT1}"]`));
  await tick();
  assert.equal(linkButton(`[data-activity-key="activity:${ACT1}"]`), null, "no activity offer left");
  assert.equal(toggleOf("activities").getAttribute("aria-expanded"), "true", "the linked activity stays in view");
  assert.match(sectionEl("activities").textContent, /GPS session/);
});

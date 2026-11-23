// Central calendar v93 (docs/runbooks/calendar-event-delete-v93.md): Delete in an event's panel, through the real
// handlers, loaders and templates with a fake fetch and JSDOM. The fake keeps the route's contract
// (calendarEventService.js deleteEvent: requestKey replay, expectedRevision, the attached-class 409s) and the manager
// read's `deletable`.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => { throw new Error("no native confirm"); } };

const { state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const {
  centralCalendarCanCreateEvents, centralCalendarEventRoster, centralCalendarRosterIndex, centralCalendarUncertainWrites,
  clearCentralCalendarUncertainWrites, handleCentralCalendarAction,
} = await import("../central-calendar-actions.js");
const { loadCentralCalendar, resetCentralCalendarForWorkspaceChange } = await import("../central-calendar-data.js");
const view = await import("../central-calendar-view.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const D = addDaysIso(weekMondayIso(TODAY), 1);
const CLUB = "c1c1c1c1-0000-4000-8000-000000000001";
const U19 = "11111111-1111-4111-8111-111111111111";
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const A1 = "aaaaaaaa-0000-4000-8000-000000000001";
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function eventItem(id, overrides = {}) {
  return {
    key: `event:${id}:${D}`, kind: "event", date: D, title: "Team training", slot: null, startTime: "10:00", startsAt: null,
    teamIds: [U19], athleteIds: [A1], athleteCount: 1, expects: [], status: "planned", rpe: null, attendance: null, results: null,
    cancelled: false, projected: false, eventId: id, eventKind: "training", eventTypeLabel: "Training", eventTypeId: null, endTime: null,
    location: null, span: { from: D, to: D }, gaps: [], scheduleFold: { external: null, test: null }, revision: 3, canManage: true, notes: null,
    details: { selected: 0, filled: 0, required: 0, filledRequired: 0 }, alignment: { pending: 0 },
    links: { eventId: id, planIds: [], logicalSessionIds: [], activityIds: [], externalScheduleId: null, testScheduleId: null },
    ...overrides,
  };
}

function server({ items = [eventItem(E1)], deletable = new Set([E1]), refuse = null, lose = 0 } = {}) {
  const live = items.map((item) => ({ ...item }));
  const keys = new Map();
  let losing = lose;
  const eventOf = (id) => live.find((item) => item.kind === "event" && item.eventId === id);
  const responder = (call) => {
    const path = call.url.split("?")[0];
    if (path === "/api/calendar" && call.method === "GET") {
      const params = new URL(call.url, "http://localhost").searchParams;
      const days = [];
      for (let cursor = params.get("from"); cursor <= params.get("to"); cursor = addDaysIso(cursor, 1)) {
        days.push({ date: cursor, items: live.filter((item) => item.date === cursor).map((item) => (params.get("include") === "athletes" ? { ...item, athletes: [] } : { ...item })) });
      }
      return { status: 200, body: { from: params.get("from"), to: params.get("to"), today: params.get("today"), workspace: { type: "club", scopeId: CLUB }, teams: [{ teamId: U19, name: "U19", athleteCount: 1 }], days } };
    }
    if (path === "/api/calendar/events/types") return { status: 200, body: { types: [] } };
    const del = path.match(/^\/api\/calendar\/events\/([^/]+)\/delete$/);
    if (del && call.method === "POST") {
      const { requestKey, ...rest } = call.body || {};
      assert.deepEqual(Object.keys(rest), ["expectedRevision"], "the body is the key and the revision only");
      const saved = keys.get(requestKey);
      if (saved) return saved.hash === JSON.stringify(rest) ? { status: 200, body: { ...saved.body, replayed: true } } : { status: 409, body: { error: "request_key_reused" } };
      const refusal = refuse?.(call);
      if (refusal) return refusal;
      const e = eventOf(del[1]);
      if (!e) return { status: 404, body: { error: "notFound", message: "Not found." } };
      if (rest.expectedRevision !== e.revision) return { status: 409, body: { error: "event_changed", message: "x" } };
      live.splice(live.indexOf(e), 1);
      const body = { deleted: true, eventId: e.eventId };
      keys.set(requestKey, { hash: JSON.stringify(rest), body });
      if (losing > 0) {
        losing -= 1;
        return { throwNetworkError: true };
      }
      return { status: 200, body };
    }
    if (path.startsWith("/api/calendar/events/") && call.method === "GET") {
      const e = eventOf(path.split("/").pop());
      if (!e) return { status: 404, body: { error: "notFound" } };
      return { status: 200, body: { event: { id: e.eventId, title: e.title, revision: e.revision, expects: [], canManage: true, status: "planned", fields: [], sessionLinks: [], activityLinks: [], alignment: { pending: 0 }, deletable: deletable.has(e.eventId) } } };
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const deletes = (calls) => calls.filter((call) => /\/delete$/.test(call.url));
const open = async (id = E1) => { await act({ action: "central-calendar-open-item", key: `event:${id}:${D}`, date: D }); await tick(); };
const deleteButton = () => dom().querySelector('[data-action="central-calendar-delete-open"]');
const sendButton = () => dom().querySelector('.cc-panel-delete [data-action="central-calendar-link"][data-act="delete-event"]');
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

test("1. an empty event: Delete opens a step naming the event (nothing sent); Keep closes it; Delete event sends one POST and the panel closes with Deleted", async () => {
  const { calls, fake } = await start();
  await open();
  assert.ok(deleteButton(), "Delete is offered");
  await press(deleteButton());
  assert.equal(deletes(calls).length, 0, "the first press only opens the step");
  assert.match(dom().querySelector(".cc-panel-delete").textContent, /Delete “Team training” for good\? It can't be undone\./);
  await act({ action: "central-calendar-delete-keep" });
  assert.equal(sendButton(), null);
  assert.ok(deleteButton());
  await press(deleteButton());
  await press(sendButton());
  await tick();
  const sent = deletes(calls);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `/api/calendar/events/${E1}/delete`);
  assert.equal(sent[0].body.expectedRevision, 3);
  assert.ok(sent[0].body.requestKey);
  assert.equal(fake.live.length, 0);
  assert.equal(state.centralCalendar.panel.open, false, "the panel closed");
  assert.equal(state.centralCalendar.notice, "Deleted “Team training”.");
});

test("2. not offered: an event that holds something (the manager read), a reader's event, a cancelled event with a schedule", async () => {
  await start({ deletable: new Set() });
  await open();
  assert.equal(deleteButton(), null, "deletable false");
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  await start({ items: [eventItem(E1, { canManage: false, details: undefined, alignment: undefined, links: { eventId: E1, activityIds: [] } })] });
  await open();
  assert.equal(deleteButton(), null, "a reader");
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  await start({ items: [eventItem(E1, { cancelled: true, status: "cancelled", links: { ...eventItem(E1).links, externalScheduleId: "b0000000-0000-4000-8000-000000000001" } })] });
  await open();
  assert.equal(deleteButton(), null, "a cancelled event that refers to a schedule");
});

test("3. a cancelled event without a schedule: Delete is offered without a manager read, and deletes", async () => {
  const { calls } = await start({ items: [eventItem(E1, { cancelled: true, status: "cancelled" })] });
  await open();
  assert.equal(calls.filter((c) => c.url === `/api/calendar/events/${E1}`).length, 0, "no manager read for a cancelled event");
  await press(deleteButton());
  await press(sendButton());
  await tick();
  assert.equal(deletes(calls).length, 1);
  assert.equal(state.centralCalendar.notice, "Deleted “Team training”.");
});

test("4. a refusal: one plain sentence, nothing deleted, Delete no longer offered for that event", async () => {
  const { calls, fake } = await start({ refuse: () => ({ status: 409, body: { error: "event_has_trainings", message: "server words" } }) });
  await open();
  await press(deleteButton());
  await press(sendButton());
  await tick();
  assert.equal(deletes(calls).length, 1);
  const text = state.centralCalendar.linkMessage?.text || state.centralCalendar.notice;
  assert.equal(text, "This event has linked trainings, so it can't be deleted. Nothing was deleted.");
  assert.doesNotMatch(text, UUID_ANYWHERE);
  assert.equal(fake.live.length, 1);
  assert.equal(deleteButton(), null, "not offered again");
});

test("5. a lost answer: Result not confirmed, Delete off; Check result sends the same request and settles it", async () => {
  const { calls } = await start({ items: [eventItem(E1, { cancelled: true, status: "cancelled" })], lose: 1 });
  await open();
  await press(deleteButton());
  await press(sendButton());
  await tick();
  assert.equal(centralCalendarUncertainWrites().length, 1);
  assert.match(dom().querySelector(".cc-panel-delete").textContent, /The result is not confirmed\./);
  const check = dom().querySelector('.cc-panel-delete [data-action="central-calendar-link-check"]');
  assert.ok(check, "Check result is shown for a cancelled event too");
  await act({ ...check.dataset });
  await tick();
  const sent = deletes(calls);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].body, sent[0].body, "the same key and body");
  assert.equal(centralCalendarUncertainWrites().length, 0);
  assert.equal(state.centralCalendar.notice, "Deleted “Team training”.");
});

test("6. a press without its step, or for another event's step, sends nothing", async () => {
  const { calls } = await start({ items: [eventItem(E1), eventItem(E2, { key: `event:${E2}:${D}`, title: "Other" })], deletable: new Set([E1, E2]) });
  await open(E1);
  await act({ action: "central-calendar-link", act: "delete-event", eventKey: `event:${E1}:${D}` });
  await tick();
  assert.equal(deletes(calls).length, 0, "no step open");
  await press(deleteButton());
  await open(E2);
  await act({ action: "central-calendar-link", act: "delete-event", eventKey: `event:${E2}:${D}` });
  await tick();
  assert.equal(deletes(calls).length, 0, "the step belonged to another panel");
});

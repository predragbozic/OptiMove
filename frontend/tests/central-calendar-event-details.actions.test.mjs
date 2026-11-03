// Central calendar K2b-1d (docs/ai/central-calendar-k2b-plan.md section 21):
// an event's place and its details in the event form, the panel and the
// cards, and "Enter details" - through the real handlers, loaders and
// templates with a fake fetch (tests/support/fetch-mock.mjs) and JSDOM for the
// markup. The fake keeps K2b-1b's contracts (18.3, 18.8): the card's `place`,
// `eventTypeId` and `details` (a manager's card only), GET /events/types with
// `{ types, fields, locations, teamDefaults }`, the manager's GET /events/:id
// with `locationId`, `place` and `fields`, and POST /events/:id/fields with
// its refusals and its requestKey replay.
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
  centralCalendarCanCreateEvents,
  centralCalendarEventRoster,
  centralCalendarRosterIndex,
  centralCalendarUncertainWrites,
  clearCentralCalendarUncertainWrites,
  handleCentralCalendarAction,
  handleCentralCalendarInput,
  submitCentralCalendarEventForm,
} = await import("../central-calendar-actions.js");
const { centralCalendarCatalogChanged, loadCentralCalendar, resetCentralCalendarForWorkspaceChange } = await import("../central-calendar-data.js");
const view = await import("../central-calendar-view.js");
const { renderCentralCalendarEventDetailsHtml } = await import("../central-calendar-event-details.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
const DAY = (offset) => addDaysIso(MONDAY, offset);
const CLUB = "c1c1c1c1-0000-4000-8000-000000000001";
const U19 = "11111111-1111-4111-8111-111111111111";
const U17 = "22222222-2222-4222-8222-222222222222";
const TEAMS = [{ teamId: U19, name: "U19", athleteCount: 20 }, { teamId: U17, name: "U17", athleteCount: 18 }];
const E_MATCH = "e0000000-0000-4000-8000-000000000001";
const E_READ = "e0000000-0000-4000-8000-000000000002";
const E_NEW = "e0000000-0000-4000-8000-0000000000aa";
const T_TRAINING = "70000000-0000-4000-8000-000000000001";
const T_MATCH = "70000000-0000-4000-8000-000000000002";
const T_MEETING = "70000000-0000-4000-8000-000000000003";
const F_WEATHER = "f0000000-0000-4000-8000-000000000001";
const F_SCORE = "f0000000-0000-4000-8000-000000000002";
const F_OPP = "f0000000-0000-4000-8000-000000000003";
const F_GOOD = "f0000000-0000-4000-8000-000000000004";
const F_FEEL = "f0000000-0000-4000-8000-000000000005";
const F_OLD = "f0000000-0000-4000-8000-000000000006";
const O_SUN = "0a000000-0000-4000-8000-000000000001";
const O_RAIN = "0a000000-0000-4000-8000-000000000002";
const O_SNOW = "0a000000-0000-4000-8000-000000000003";
const L_STADIUM = "1c000000-0000-4000-8000-000000000001";
const L_HALL = "1c000000-0000-4000-8000-000000000002";
const L_OLD = "1c000000-0000-4000-8000-000000000003";

const TYPES = [
  { id: T_TRAINING, kind: "training", key: "training", label: "Training", defaultExpects: ["rpe"], defaultFieldIds: [F_WEATHER], iconKey: "run", colorKey: "rust", sortOrder: 10, ownerScope: "club" },
  { id: T_MATCH, kind: "match", key: "match", label: "Match", defaultExpects: ["rpe"], defaultFieldIds: [F_SCORE, F_OPP, F_OLD], iconKey: "football", colorKey: "indigo", sortOrder: 20, ownerScope: "club" },
  { id: T_MEETING, kind: "meeting", key: "meeting", label: "Meeting", defaultExpects: [], defaultFieldIds: [], iconKey: null, colorKey: null, sortOrder: 40, ownerScope: "club" },
];
// The workspace's live details (F_OLD is archived: not in the catalog).
const FIELDS = [
  { id: F_WEATHER, label: "Weather", valueKind: "choice", unit: null, minValue: null, maxValue: null, required: false, options: [{ id: O_SUN, label: "Sunny" }, { id: O_RAIN, label: "Rain" }] },
  { id: F_SCORE, label: "Our score", valueKind: "number", unit: "goals", minValue: 0, maxValue: 99, required: true, options: [] },
  { id: F_OPP, label: "Opponent", valueKind: "short_text", unit: null, minValue: null, maxValue: null, required: false, options: [] },
  { id: F_GOOD, label: "Pitch was good", valueKind: "yes_no", unit: null, minValue: null, maxValue: null, required: false, options: [] },
  { id: F_FEEL, label: "Team mood", valueKind: "scale_1_5", unit: null, minValue: null, maxValue: null, required: false, options: [] },
];
const LOCATIONS = [
  { id: L_STADIUM, name: "City stadium", address: "Main street 1, Novi Sad", note: "Gate B" },
  { id: L_HALL, name: "Hall", address: null, note: null },
];
const CATALOG = { types: TYPES, fields: FIELDS, locations: LOCATIONS, teamDefaults: { [U19]: L_HALL } };

function eventItem(id, date, overrides = {}) {
  return {
    key: `event:${id}:${date}`, kind: "event", date, eventId: id, eventKind: "match", eventTypeLabel: "Match", eventTypeId: T_MATCH,
    title: "Cup match", slot: null, startTime: "15:00", endTime: "17:00", startsAt: null, location: "City stadium",
    place: { source: "library", locationId: L_STADIUM, name: "City stadium", address: "Main street 1, Novi Sad", note: "Gate B" },
    teamIds: [U17], athleteIds: [], athleteCount: 18, expects: [], status: "planned", rpe: null, attendance: null, results: null,
    cancelled: false, projected: false, span: { from: date, to: date }, gaps: [], scheduleFold: { external: null, test: null }, revision: 2,
    canManage: true, notes: null, details: { selected: 3, filled: 1, required: 1, filledRequired: 0 },
    links: { eventId: id, planIds: [], logicalSessionIds: [], activityIds: [], externalScheduleId: null, testScheduleId: null },
    ...overrides,
  };
}
// Another coach's card (T7): the place only - no type id, no details.
function readerItem(date) {
  const { eventTypeId, details, ...rest } = eventItem(E_READ, date, {
    title: "Club meeting", eventKind: "meeting", eventTypeLabel: "Meeting", canManage: false, location: "Room 4",
    place: { source: "one_off", text: "Room 4" }, startTime: null, endTime: null,
  });
  return rest;
}
const ITEMS = [eventItem(E_MATCH, DAY(1)), readerItem(DAY(2))];

// The manager's view of E_MATCH (viewOf in calendarEventService.js).
function eventView(overrides = {}) {
  return {
    id: E_MATCH, ownerScope: "club", ownerClubId: CLUB, ownerTeamId: null, ownerUserId: null,
    eventTypeId: T_MATCH, eventKind: "match", eventTypeLabel: "Match", title: "Cup match", day: DAY(1), endDay: null,
    startTime: "15:00", endTime: "17:00", timezone: "Europe/Belgrade", location: null, locationId: L_STADIUM,
    place: { source: "library", locationId: L_STADIUM, name: "City stadium", address: "Main street 1, Novi Sad", note: "Gate B" },
    fields: [
      { fieldId: F_WEATHER, label: "Weather", description: null, valueKind: "choice", unit: null, minValue: null, maxValue: null, required: false, archived: false,
        options: [{ id: O_SUN, label: "Sunny" }, { id: O_RAIN, label: "Rain" }, { id: O_SNOW, label: "Snow", hidden: true }], value: O_SNOW },
      { fieldId: F_SCORE, label: "Our score", description: "Goals we scored", valueKind: "number", unit: "goals", minValue: 0, maxValue: 99, required: true, archived: false, options: [], value: null },
      { fieldId: F_OLD, label: "Old note", description: null, valueKind: "short_text", unit: null, minValue: null, maxValue: null, required: false, archived: true, options: [], value: null },
    ],
    status: "planned", cancelledAt: null, cancelReason: null, expects: [], externalScheduleId: null, testScheduleId: null, revision: 2,
    targets: [{ kind: "team", id: U17, name: "U17" }], links: { planIds: [], activityIds: [] }, canManage: true, notes: null,
    ...overrides,
  };
}

const NOT_FOUND = { status: 404, body: { error: "notFound", message: "Not found." } };

function rangeAnswer(url, items, workspace) {
  const params = new URL(url, "http://localhost").searchParams;
  const from = params.get("from");
  const to = params.get("to");
  const days = [];
  for (let cursor = from; cursor <= to; cursor = addDaysIso(cursor, 1)) days.push({ date: cursor, items: items.filter((item) => item.date === cursor).map((item) => (params.get("include") === "athletes" ? { ...item, athletes: [] } : { ...item })) });
  return { from, to, today: params.get("today"), workspace, teams: workspace.type === "private_coach" ? [] : TEAMS, days };
}

// The fake server. `fields` decides the values command per call (default:
// the service's contract - the same key with the same body replays, another
// body is request_key_reused; a value is written and the card's counts move).
function server({ items = ITEMS, workspace = { type: "club", scopeId: CLUB }, catalog = CATALOG, event = eventView(), fields = null, loseFirstAnswer = false } = {}) {
  const live = items.map((item) => ({ ...item }));
  let current = event;
  const keys = new Map();
  let lose = loseFirstAnswer;
  const responder = (call) => {
    const path = call.url.split("?")[0];
    if (path === "/api/calendar" && call.method === "GET") return { status: 200, body: rangeAnswer(call.url, live, workspace) };
    if (path === "/api/calendar/events/types" && call.method === "GET") return typeof catalog === "function" ? catalog(call) : { status: 200, body: catalog };
    if (path.startsWith("/api/calendar/events/") && call.method === "GET") {
      if (typeof current === "function") return current(call);
      return path.endsWith(`/${current.id}`) ? { status: 200, body: { event: current } } : NOT_FOUND;
    }
    if (path.endsWith("/fields") && call.method === "POST") {
      if (fields) return fields(call);
      const { requestKey, ...rest } = call.body || {};
      const hash = JSON.stringify(rest);
      const saved = keys.get(requestKey);
      if (saved) return saved.hash === hash ? { status: 200, body: { ...saved.body, replayed: true } } : { status: 409, body: { error: "request_key_reused", message: "?" } };
      if (rest.expectedRevision !== current.revision) return { status: 409, body: { error: "event_changed", message: "?", current: { revision: current.revision } } };
      const byId = new Map(rest.values.map((v) => [v.fieldId, v.value]));
      current = { ...current, revision: current.revision + 1, fields: current.fields.map((f) => (byId.has(f.fieldId) ? { ...f, value: byId.get(f.fieldId) } : f)) };
      const filled = current.fields.filter((f) => f.value !== null).length;
      const filledRequired = current.fields.filter((f) => f.required && !f.archived && f.value !== null).length;
      for (const item of live) if (item.eventId === current.id) Object.assign(item, { details: { ...item.details, filled, filledRequired }, revision: current.revision });
      const answer = { status: 200, body: { event: current } };
      keys.set(requestKey, { hash, ...answer });
      if (lose) {
        lose = false;
        return { throwNetworkError: true };
      }
      return answer;
    }
    if (path === "/api/calendar/events" && call.method === "POST") {
      live.push(eventItem(E_NEW, call.body.day, { title: call.body.title, details: { selected: 0, filled: 0, required: 0, filledRequired: 0 } }));
      return { status: 201, body: { event: eventView({ id: E_NEW, title: call.body.title, day: call.body.day, fields: [], revision: 1 }) } };
    }
    if (call.method === "PATCH") return { status: 200, body: { event: { ...current, revision: current.revision + 1 } } };
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
const dom = (html = rendered) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
const act = (dataset) => handleCentralCalendarAction(fakeAction(dataset), { render });
function input(dataset, { value = "", checked = false, type = "" } = {}) {
  return handleCentralCalendarInput({ dataset, value, checked, type, closest: (selector) => (selector === "[data-cc-event-form]" ? {} : null) }, { render });
}
const writesOf = (calls) => calls.filter((call) => call.url.startsWith("/api/calendar/events") && call.method !== "GET");
const eventReads = (calls, id = E_MATCH) => calls.filter((call) => call.method === "GET" && call.url === `/api/calendar/events/${id}`);
const typesReads = (calls) => calls.filter((call) => call.url === "/api/calendar/events/types");
const rangeReads = (calls) => calls.filter((call) => call.url.startsWith("/api/calendar?") && !call.url.includes("include=athletes"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
});

async function openCreate(options = {}) {
  const calls = installFetchMock(server(options));
  await loadCentralCalendar({ render });
  await tick();
  await act({ action: "central-calendar-new-event" });
  return calls;
}
async function openPanel(options = {}, key = `event:${E_MATCH}:${DAY(1)}`, date = DAY(1)) {
  const calls = installFetchMock(server(options));
  await loadCentralCalendar({ render });
  await tick();
  await act({ action: "central-calendar-open-item", key, date });
  return calls;
}
async function submitBody(calls) {
  await submitCentralCalendarEventForm({ render });
  const write = writesOf(calls).at(-1);
  const { requestKey, ...body } = write.body;
  return { write, requestKey, body };
}

// --- 1. The place in the event form ---------------------------------------------

test("D1. a club's places: the select names each with its address; a library place sends locationId only, Another place its text only - never both", async () => {
  const calls = await openCreate();
  let doc = dom();
  const select = doc.querySelector("[data-cc-event-place]");
  assert.deepEqual([...select.options].map((o) => o.textContent), ["No place", "City stadium — Main street 1, Novi Sad", "Hall", "Another place…"]);
  assert.equal(doc.querySelector('[data-cc-event-field="location"]'), null, "the text only for Another place");
  input({ ccEventPlace: "" }, { value: "other" });
  doc = dom();
  assert.ok(doc.querySelector('[data-cc-event-field="location"]'), "Another place shows its text");
  input({ ccEventField: "location" }, { value: "  Beach   court " });
  input({ ccEventPlace: "" }, { value: L_STADIUM });
  assert.match(dom().querySelector("[data-cc-event-place] ~ .cc-field-hint").textContent, /Address: Main street 1, Novi Sad/);
  input({ ccEventTarget: "team", targetId: U17, targetName: "U17" }, { checked: true });
  input({ ccEventField: "title" }, { value: "Sparring" });
  let { body } = await submitBody(calls);
  assert.equal(body.locationId, L_STADIUM);
  assert.equal("location" in body, false, "the text typed before is not sent with a library place");

  // Another place: its text only.
  await act({ action: "central-calendar-new-event" });
  input({ ccEventPlace: "" }, { value: "other" });
  input({ ccEventField: "location" }, { value: "  Beach   court " });
  input({ ccEventTarget: "team", targetId: U17, targetName: "U17" }, { checked: true });
  ({ body } = await submitBody(calls));
  assert.equal(body.location, "Beach court");
  assert.equal("locationId" in body, false);
});

test("D2. a new event starts at its team's default place until the place is touched; the hint says where it came from", async () => {
  // A club event for exactly one team: that team's default place.
  await openCreate();
  const form = state.centralCalendar.form;
  assert.equal(form.draft.placeChoice, "", "no team yet: no place");
  input({ ccEventTarget: "team", targetId: U19, targetName: "U19" }, { checked: true });
  assert.equal(form.draft.placeChoice, L_HALL, "U19's default place");
  assert.match(dom().querySelector("[data-cc-event-place] ~ .cc-field-hint").textContent, /^The team's default place\. No address\./);
  input({ ccEventTarget: "team", targetId: U17, targetName: "U17" }, { checked: true });
  assert.equal(form.draft.placeChoice, "", "two teams: no default");
  input({ ccEventTarget: "team", targetId: U17, targetName: "U17" }, { checked: false });
  assert.equal(form.draft.placeChoice, L_HALL);
  input({ ccEventTarget: "club", targetId: CLUB, targetName: "First Club" }, { checked: true });
  assert.equal(form.draft.placeChoice, "", "the whole club too: no default");
  input({ ccEventTarget: "club", targetId: CLUB, targetName: "First Club" }, { checked: false });
  input({ ccEventPlace: "" }, { value: L_STADIUM });
  input({ ccEventTarget: "team", targetId: U17, targetName: "U17" }, { checked: true });
  input({ ccEventTarget: "team", targetId: U17, targetName: "U17" }, { checked: false });
  assert.equal(form.draft.placeChoice, L_STADIUM, "touched: the coach's choice stays");
  assert.doesNotMatch(dom().querySelector("[data-cc-event-place] ~ .cc-field-hint").textContent, /default/);

  // A team workspace: its own team's default at once.
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  state.currentUser.activeWorkspace = { type: "team", scopeId: U19, label: "U19" };
  await openCreate({ workspace: { type: "team", scopeId: U19 } });
  assert.equal(state.centralCalendar.form.draft.placeChoice, L_HALL);
});

test("D3. a private coach (no places): the place is a text alone, sent as location", async () => {
  state.currentUser.activeWorkspace = { type: "private_coach", scopeId: null, label: "Private coaching" };
  state.athletes = [{ athlete_uuid: "aaaaaaaa-0000-4000-8000-000000000001", athlete_id: "1", athlete: "Ana Test" }];
  const calls = await openCreate({ workspace: { type: "private_coach", scopeId: null }, catalog: { types: TYPES, fields: FIELDS, locations: [], teamDefaults: {} } });
  const doc = dom();
  assert.equal(doc.querySelector("[data-cc-event-place]"), null, "no select without places");
  assert.ok(doc.querySelector('[data-cc-event-field="location"]'));
  input({ ccEventField: "location" }, { value: "Park" });
  input({ ccEventTarget: "athlete", targetId: "aaaaaaaa-0000-4000-8000-000000000001", targetName: "Ana Test" }, { checked: true });
  const { body } = await submitBody(calls);
  assert.equal(body.location, "Park");
  assert.equal("locationId" in body, false);
});

// --- 2. The details list --------------------------------------------------------

test("D4. a new event's details: the type's live defaults, again on a type change until touched; untouched sends no fieldIds; the words of the form", async () => {
  const calls = await openCreate();
  const form = state.centralCalendar.form;
  assert.deepEqual(form.draft.fieldIds, [F_WEATHER], "Training's default");
  input({ ccEventField: "eventTypeId" }, { value: T_MATCH });
  assert.deepEqual(form.draft.fieldIds, [F_SCORE, F_OPP], "Match's live defaults (its archived one is not offered)");
  const doc = dom();
  const fieldsets = [...doc.querySelectorAll(".cc-fieldset legend")].map((legend) => legend.textContent);
  assert.ok(fieldsets.includes("Collected after it"), "the Settings screen's heading (1c), not another one");
  assert.ok(fieldsets.includes("Details to fill in after the event"));
  assert.match(doc.body.textContent, /RPE, GPS and test results are under Collected after it\./);
  assert.deepEqual([...doc.querySelectorAll(".cc-detail-row .cc-detail-kind")].map((el) => el.textContent), ["Number · Required", "Short text"]);
  input({ ccEventTarget: "team", targetId: U17, targetName: "U17" }, { checked: true });
  const { body } = await submitBody(calls);
  assert.equal("fieldIds" in body, false, "untouched: the server copies the type's live defaults");
});

test("D5. add, move and remove: the list is sent in its order once touched, and the type no longer re-chooses it", async () => {
  const calls = await openCreate();
  const form = state.centralCalendar.form;
  input({ ccEventField: "eventTypeId" }, { value: T_MATCH });
  let doc = dom();
  assert.deepEqual([...doc.querySelectorAll("[data-cc-event-add-field] option")].map((o) => o.textContent), ["Add a detail…", "Weather", "Pitch was good", "Team mood"]);
  await act({ action: "central-calendar-event-field-add" });
  assert.deepEqual(form.draft.fieldIds, [F_SCORE, F_OPP], "nothing chosen: nothing added");
  input({ ccEventAddField: "" }, { value: F_FEEL });
  await act({ action: "central-calendar-event-field-add" });
  await act({ action: "central-calendar-event-field-move", fieldId: F_FEEL, direction: "up" });
  assert.deepEqual(form.draft.fieldIds, [F_SCORE, F_FEEL, F_OPP]);
  await act({ action: "central-calendar-event-field-move", fieldId: F_FEEL, direction: "up" });
  await act({ action: "central-calendar-event-field-move", fieldId: F_FEEL, direction: "up" });
  assert.deepEqual(form.draft.fieldIds, [F_FEEL, F_SCORE, F_OPP], "the first stays first");
  await act({ action: "central-calendar-event-field-remove", fieldId: F_OPP });
  assert.deepEqual(form.draft.fieldIds, [F_FEEL, F_SCORE]);
  doc = dom();
  assert.equal(doc.querySelector(`[data-action="central-calendar-event-field-move"][data-field-id="${F_FEEL}"][data-direction="up"]`).disabled, true, "the first cannot go up");
  assert.equal(doc.querySelector(`[data-action="central-calendar-event-field-move"][data-field-id="${F_SCORE}"][data-direction="down"]`).disabled, true, "the last cannot go down");
  assert.equal(doc.querySelector(`[data-action="central-calendar-event-field-remove"][data-field-id="${F_SCORE}"]`).getAttribute("aria-label"), "Remove “Our score”");
  input({ ccEventField: "eventTypeId" }, { value: T_TRAINING });
  assert.deepEqual(form.draft.fieldIds, [F_FEEL, F_SCORE], "touched: a type change keeps the list");
  input({ ccEventTarget: "team", targetId: U17, targetName: "U17" }, { checked: true });
  const { body } = await submitBody(calls);
  assert.deepEqual(body.fieldIds, [F_FEEL, F_SCORE]);
});

test("D6. Edit: the event's place and details as they are; an archived place and detail stay marked and are not sent unless changed", async () => {
  const calls = await openPanel({ event: eventView({ locationId: L_OLD, place: { source: "library", locationId: L_OLD, name: "Old ground", address: "Lake road 3", note: null } }) });
  await act({ action: "central-calendar-edit-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  const form = state.centralCalendar.form;
  assert.equal(form.mode, "edit");
  let doc = dom();
  const select = doc.querySelector("[data-cc-event-place]");
  assert.equal(select.value, L_OLD);
  assert.equal(select.selectedOptions[0].textContent, "Old ground — Lake road 3 (archived)");
  assert.deepEqual([...doc.querySelectorAll(".cc-detail-row .cc-detail-name")].map((el) => el.textContent), ["Weather", "Our score", "Old note"]);
  assert.match(doc.querySelectorAll(".cc-detail-row .cc-detail-kind")[2].textContent, /Archived/);
  input({ ccEventField: "title" }, { value: "Cup final" });
  let { body } = await submitBody(calls);
  assert.deepEqual(body, { expectedRevision: 2, title: "Cup final" }, "the archived place and detail are not sent");

  // Changing the place: to none, to another library place, to a text.
  for (const [choice, text, expected] of [["", "", { locationId: null }], [L_HALL, "", { locationId: L_HALL }], ["other", "Away ground", { location: "Away ground" }]]) {
    await act({ action: "central-calendar-edit-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
    input({ ccEventPlace: "" }, { value: choice });
    if (text) input({ ccEventField: "location" }, { value: text });
    ({ body } = await submitBody(calls));
    const { expectedRevision, ...rest } = body;
    assert.deepEqual(rest, expected, `place → ${choice || "none"}`);
  }
  assert.ok(eventReads(calls).length >= 4);
});

test("D7. Edit: a type change keeps the list and offers Replace with the new type's details; a type change alone sends no fieldIds", async () => {
  const calls = await openPanel();
  await act({ action: "central-calendar-edit-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  const form = state.centralCalendar.form;
  assert.equal(dom().querySelector('[data-action="central-calendar-event-fields-replace"]'), null, "same type: nothing to replace");
  input({ ccEventField: "eventTypeId" }, { value: T_TRAINING });
  assert.deepEqual(form.draft.fieldIds, [F_WEATHER, F_SCORE, F_OLD], "18.7: the type alone never changes the list");
  assert.ok(dom().querySelector('[data-action="central-calendar-event-fields-replace"]'));
  let { body } = await submitBody(calls);
  assert.deepEqual(body, { expectedRevision: 2, eventTypeId: T_TRAINING });

  await act({ action: "central-calendar-edit-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  input({ ccEventField: "eventTypeId" }, { value: T_TRAINING });
  await act({ action: "central-calendar-event-fields-replace" });
  assert.deepEqual(state.centralCalendar.form.draft.fieldIds, [F_WEATHER]);
  assert.equal(dom().querySelector('[data-action="central-calendar-event-fields-replace"]'), null);
  ({ body } = await submitBody(calls));
  assert.deepEqual(body, { expectedRevision: 2, eventTypeId: T_TRAINING, fieldIds: [F_WEATHER] });
});

test("D8. an event with no type (a moved team's, D41): the card and the form read the kind's word, the type starts at Choose a type and is not sent unless chosen", async () => {
  const untyped = eventItem(E_MATCH, DAY(1), { eventTypeId: null, eventTypeLabel: null, details: { selected: 0, filled: 0, required: 0, filledRequired: 0 } });
  const calls = await openPanel({ items: [untyped], event: eventView({ eventTypeId: null, eventTypeLabel: null, fields: [] }) });
  assert.match(dom().querySelector(".cc-panel-kind").textContent, /Event · Match · 18 athletes/, "the kind's word");
  await act({ action: "central-calendar-edit-event", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  const doc = dom();
  const select = doc.querySelector('[data-cc-event-field="eventTypeId"]');
  assert.ok(select, "a type can be chosen");
  assert.equal(select.selectedOptions[0].textContent, "Choose a type");
  input({ ccEventField: "title" }, { value: "Cup final" });
  const { body } = await submitBody(calls);
  assert.deepEqual(body, { expectedRevision: 2, title: "Cup final" }, "no eventTypeId: the server keeps the stored one");
});

// --- 3. The panel ----------------------------------------------------------------

test("D9. the panel's place, for everyone who sees the card: a library place with its address, note and Open in maps; a one-off text; no read for it", async () => {
  const calls = await openPanel();
  let doc = dom();
  assert.equal(doc.querySelector(".cc-panel-place-name").textContent, "City stadium");
  assert.match(doc.querySelector(".cc-panel-place-address").textContent, /^Main street 1, Novi Sad/);
  assert.equal(doc.querySelector(".cc-panel-place-note").textContent, "Gate B");
  const maps = doc.querySelector(".cc-panel a.cc-maps");
  assert.equal(maps.getAttribute("href"), "https://www.google.com/maps/search/?api=1&query=Main%20street%201%2C%20Novi%20Sad");
  assert.equal(maps.getAttribute("target"), "_blank");
  assert.equal(maps.getAttribute("rel"), "noopener noreferrer");
  // A reader's event: its place, nothing of the details, no event read.
  const before = calls.length;
  await act({ action: "central-calendar-open-item", key: `event:${E_READ}:${DAY(2)}`, date: DAY(2) });
  doc = dom();
  assert.equal(doc.querySelector(".cc-panel-place").textContent.trim(), "Room 4");
  assert.equal(doc.querySelector(".cc-panel a.cc-maps"), null, "no address, no link");
  assert.equal(doc.querySelector(".cc-panel-details"), null);
  assert.equal(doc.querySelector('[data-action="central-calendar-enter-details"]'), null);
  assert.equal(eventReads(calls.slice(before), E_READ).length, 0, "T7: a reader never reads the event");
  // A library place without an address: no link.
  assert.equal(new JSDOM(view.renderCentralCalendarCardHtml(eventItem(E_MATCH, DAY(1), { place: { source: "library", locationId: L_HALL, name: "Hall", address: null, note: null } }), { teams: TEAMS })).window.document.querySelector(".cc-card-place").textContent, "Hall");
});

test("D10. a manager's event with details: one read on open, each value in words, the count in words; none for a manager's event without details", async () => {
  const calls = await openPanel();
  assert.equal(eventReads(calls).length, 1, "T: one GET /:id");
  const doc = dom();
  assert.equal(doc.querySelector(".cc-panel-details .cc-panel-note").textContent, "1 of 3 filled in · 1 required is still empty.");
  assert.deepEqual([...doc.querySelectorAll(".cc-detail-value")].map((row) => `${row.querySelector("dt").textContent}=${row.querySelector("dd").textContent}`), [
    "Weather=Snow", "Our score (required)=Not filled in", "Old note=Not filled in",
  ]);
  assert.ok(doc.querySelector(`[data-action="central-calendar-enter-details"][data-key="event:${E_MATCH}:${DAY(1)}"]`));
  // A manager's event without chosen details: no read.
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  const plain = await openPanel({ items: [eventItem(E_MATCH, DAY(1), { details: { selected: 0, filled: 0, required: 0, filledRequired: 0 } })] });
  assert.equal(eventReads(plain).length, 0);
  assert.equal(dom().querySelector(".cc-panel-details"), null);
});

test("D11. the panel's read fails: a sentence and Try again, which reads once more", async () => {
  let fail = true;
  const calls = await openPanel({ event: (call) => (fail ? { status: 503, body: { error: "database_busy", message: "?" } } : { status: 200, body: { event: eventView() } }) });
  let doc = dom();
  assert.equal(doc.querySelector('.cc-panel-details [role="alert"]').textContent, "The details could not be read.");
  fail = false;
  await act({ action: "central-calendar-details-retry" });
  doc = dom();
  assert.equal(eventReads(calls).length, 2);
  assert.match(doc.querySelector(".cc-panel-details").textContent, /1 of 3 filled in/);
});

// --- 4. Enter details ------------------------------------------------------------

async function openValues(options = {}) {
  const calls = await openPanel(options);
  await act({ action: "central-calendar-enter-details", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  return calls;
}

test("D12. Enter details: one input per detail by its kind; a hidden option the value names stays offered; numbers with a comma, bounds and three decimals", async () => {
  const calls = await openValues({ event: eventView({ fields: [...eventView().fields.slice(0, 2),
    { fieldId: F_GOOD, label: "Pitch was good", description: null, valueKind: "yes_no", unit: null, minValue: null, maxValue: null, required: false, archived: false, options: [], value: true },
    { fieldId: F_FEEL, label: "Team mood", description: null, valueKind: "scale_1_5", unit: null, minValue: null, maxValue: null, required: false, archived: false, options: [], value: 4 },
    { fieldId: F_OPP, label: "Opponent", description: null, valueKind: "short_text", unit: null, minValue: null, maxValue: null, required: false, archived: false, options: [], value: "Borac" },
  ] }) });
  assert.equal(eventReads(calls).length, 2, "the panel's read, then the form's own (the latest values)");
  const form = state.centralCalendar.form;
  assert.equal(form.mode, "values");
  const doc = dom();
  const weather = doc.querySelector(`select[data-cc-event-value="${F_WEATHER}"]`);
  assert.deepEqual([...weather.options].map((o) => o.textContent), ["Not filled in", "Sunny", "Rain", "Snow (hidden)"]);
  assert.equal(weather.value, O_SNOW);
  const score = doc.querySelector(`input[data-cc-event-value="${F_SCORE}"]`);
  assert.equal(score.getAttribute("inputmode"), "decimal");
  assert.match(score.closest(".cc-field").textContent, /Goals we scored From 0 to 99 goals\./);
  assert.deepEqual([...doc.querySelectorAll(`input[data-cc-event-value="${F_GOOD}"]`)].map((r) => `${r.value}:${r.checked}`), ["yes:true", "no:false", ":false"]);
  assert.deepEqual([...doc.querySelectorAll(`input[data-cc-event-value="${F_FEEL}"]`)].map((r) => r.value), ["1", "2", "3", "4", "5", ""]);
  assert.equal(doc.querySelector(`input[data-cc-event-value="${F_OPP}"]`).value, "Borac");
  // A radio counts only when it is the chosen one.
  input({ ccEventValue: F_GOOD }, { value: "no", type: "radio", checked: false });
  assert.equal(form.draft.values[F_GOOD], "yes");
  for (const [raw, error] of [["abc", "Use a number with at most three decimals."], ["1,2345", "Use a number with at most three decimals."], ["100", "Use a number from 0 to 99 goals."]]) {
    input({ ccEventValue: F_SCORE }, { value: raw });
    await submitCentralCalendarEventForm({ render });
    assert.equal(form.errors[`value:${F_SCORE}`], error, raw);
    assert.equal(dom().querySelector(`input[data-cc-event-value="${F_SCORE}"]`).getAttribute("aria-invalid"), "true");
  }
  assert.equal(writesOf(calls).length, 0, "nothing is sent while a value is wrong");
  // Nothing changed: nothing is sent.
  input({ ccEventValue: F_SCORE }, { value: "" });
  await submitCentralCalendarEventForm({ render });
  assert.equal(form.error, "Nothing changed: change a field, or Close.");
  assert.equal(writesOf(calls).length, 0);
});

test("D13. Save details: only the changed values, an emptied one as null, with a fresh requestKey and the revision; the calendar and the panel are read again", async () => {
  const calls = await openValues();
  const ranges = rangeReads(calls).length;
  input({ ccEventValue: F_WEATHER }, { value: "" });
  input({ ccEventValue: F_SCORE }, { value: " 2,5 " });
  input({ ccEventValue: F_OLD }, { value: "   " });
  const { write, requestKey, body } = await submitBody(calls);
  assert.equal(write.url, `/api/calendar/events/${E_MATCH}/fields`);
  assert.equal(write.method, "POST");
  assert.match(requestKey, UUID);
  assert.deepEqual(body, { expectedRevision: 2, values: [{ fieldId: F_WEATHER, value: null }, { fieldId: F_SCORE, value: 2.5 }] }, "Snow kept as it was is never sent; spaces alone are no change");
  const cal = state.centralCalendar;
  assert.equal(cal.form, null);
  assert.equal(cal.notice, "The details of “Cup match” were saved.");
  assert.equal(rangeReads(calls).length, ranges + 1, "the calendar is read again (its status and counts)");
  assert.equal(eventReads(calls).length, 3, "and the panel's details");
  const doc = dom();
  assert.equal(doc.querySelector(".cc-panel-details .cc-panel-note").textContent, "1 of 3 filled in.");
  assert.match(doc.querySelector(`.cc-card[data-key="event:${E_MATCH}:${DAY(1)}"] .cc-card-count`).textContent, /Details 1\/3/);
});

test("D14. a lost answer: Result not confirmed, nothing sent by itself; Check result sends the SAME key and body; leaving it leaves a line for this event", async () => {
  const calls = await openValues({ loseFirstAnswer: true });
  input({ ccEventValue: F_SCORE }, { value: "3" });
  await submitCentralCalendarEventForm({ render });
  const form = state.centralCalendar.form;
  assert.ok(form.unconfirmed, "Result not confirmed");
  assert.match(dom().querySelector(".cc-unconfirmed").textContent, /Result not confirmed/);
  assert.equal(writesOf(calls).length, 1);
  await tick();
  assert.equal(writesOf(calls).length, 1, "never sent again by itself");
  await act({ action: "central-calendar-event-form-close" });
  assert.match(dom().querySelector(".cc-uncertain-line").textContent, /Check the details of “Cup match”/);
  // Enter details again: the earlier result is checked first.
  await act({ action: "central-calendar-enter-details", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  assert.equal(state.centralCalendar.form.pending, true);
  assert.match(dom().querySelector(".cc-panel").textContent, /The details of “Cup match” were sent, but the answer was lost/);
  await act({ action: "central-calendar-event-check-result" });
  const writes = writesOf(calls);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].body, writes[0].body, "the same key and body");
  assert.equal(state.centralCalendar.form, null);
  assert.match(state.centralCalendar.notice, /were saved/);
  assert.equal(centralCalendarUncertainWrites().length, 0);
});

test("D15. the refusals: invalid_value marks its detail; field_not_available and event_changed read the event again with their sentence", async () => {
  let answer = { status: 400, body: { error: "invalid_value", message: "server text", fieldId: F_SCORE } };
  let calls = await openValues({ fields: () => answer });
  input({ ccEventValue: F_SCORE }, { value: "7" });
  await submitCentralCalendarEventForm({ render });
  const form = state.centralCalendar.form;
  assert.equal(form.errors[`value:${F_SCORE}`], "This value is not accepted for this detail. Check it.");
  assert.equal(form.error, "Check the marked fields. Nothing was saved.");
  assert.doesNotMatch(dom().body.textContent, /server text/);

  answer = { status: 400, body: { error: "field_not_available", message: "?" } };
  await submitCentralCalendarEventForm({ render });
  assert.equal(state.centralCalendar.form, null);
  assert.match(state.centralCalendar.notice, /^Nothing was saved: one of these details is no longer on the event/);
  assert.equal(state.centralCalendar.panel.key, `event:${E_MATCH}:${DAY(1)}`, "the event's panel stays open");

  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  answer = { status: 409, body: { error: "event_changed", message: "?", current: { revision: 3 } } };
  calls = await openValues({ fields: () => answer });
  input({ ccEventValue: F_SCORE }, { value: "7" });
  await submitCentralCalendarEventForm({ render });
  assert.equal(state.centralCalendar.form, null);
  assert.ok(state.centralCalendar.notice, "event_changed has its sentence");
  assert.ok(rangeReads(calls).length >= 2);
});

test("D16. a Check result settles only on an answer given after the request record: invalid_value does, a 503 does not", async () => {
  let answer = { throwNetworkError: true };
  const calls = await openValues({ fields: () => answer });
  input({ ccEventValue: F_SCORE }, { value: "7" });
  await submitCentralCalendarEventForm({ render });
  assert.ok(state.centralCalendar.form.unconfirmed);
  answer = { status: 503, body: { error: "database_busy", message: "?" } };
  await act({ action: "central-calendar-event-check-result" });
  assert.ok(state.centralCalendar.form.unconfirmed, "a 503 says nothing about the write");
  answer = { status: 400, body: { error: "invalid_value", message: "?", fieldId: F_SCORE } };
  await act({ action: "central-calendar-event-check-result" });
  const form = state.centralCalendar.form;
  assert.ok(!form.unconfirmed, "invalid_value is given after the request record: nothing was saved");
  assert.equal(form.errors[`value:${F_SCORE}`], "This value is not accepted for this detail. Check it.");
  const bodies = writesOf(calls).map((call) => JSON.stringify(call.body));
  assert.equal(new Set(bodies).size, 1, "every check sends the same key and body");
});

test("D17. Enter details on an event cancelled meanwhile, or not the coach's any more: the form closes with a sentence, nothing is sent", async () => {
  let calls = await openPanel({ event: eventView({ status: "cancelled" }) });
  await act({ action: "central-calendar-enter-details", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  assert.equal(state.centralCalendar.form, null);
  assert.equal(state.centralCalendar.notice, "This event was cancelled; its details can no longer be entered.");
  assert.equal(writesOf(calls).length, 0);
  // The event is no longer the coach's (the identical 404): the same neutral sentence as Edit.
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  await openPanel();
  calls = installFetchMock(server({ event: () => NOT_FOUND }));
  await act({ action: "central-calendar-enter-details", key: `event:${E_MATCH}:${DAY(1)}`, date: DAY(1) });
  assert.equal(state.centralCalendar.form, null);
  assert.equal(state.centralCalendar.notice, "This event is no longer available in this workspace.");
  assert.equal(writesOf(calls).length, 0);
  // A cancelled event's panel shows its details without Enter details.
  const cancelled = eventItem(E_MATCH, DAY(1), { status: "cancelled", cancelled: true });
  const html = renderCentralCalendarEventDetailsHtml(cancelled, { key: cancelled.key, loading: false, error: "", event: eventView() });
  assert.match(html, /1 of 3 filled in/);
  assert.equal(html.includes("central-calendar-enter-details"), false);
});

// --- 5. The cards ----------------------------------------------------------------

test("D18. a manager's card wears its type's icon and colour from the catalog; a reader's keeps its kind's icon; the catalog is read once, and only when a card needs it", async () => {
  const calls = installFetchMock(server());
  await loadCentralCalendar({ render });
  await tick();
  assert.equal(typesReads(calls).length, 1, "a manager's card names its type: one catalog read");
  const doc = dom();
  const card = doc.querySelector(`.cc-card[data-key="event:${E_MATCH}:${DAY(1)}"]`);
  const icon = card.querySelector("svg.cc-card-icon");
  assert.ok(icon.classList.contains("has-type-color"));
  assert.equal(icon.closest(".cc-type-tint").getAttribute("style"), "--cc-type-color: var(--cc-team-2)", "indigo is the third colour");
  assert.equal(view.centralCalendarItemIconKey(eventItem(E_MATCH, DAY(1))), "football", "Match's own icon");
  const reader = doc.querySelector(`.cc-card[data-key="event:${E_READ}:${DAY(2)}"] svg.cc-card-icon`);
  assert.equal(reader.classList.contains("has-type-color"), false);
  assert.equal(view.centralCalendarItemIconKey(readerItem(DAY(2))), "team", "a reader's card: the kind's icon (meeting)");
  assert.equal(view.centralCalendarItemIconKey({ ...eventItem(E_MATCH, DAY(1)), canManage: false }), "trophy", "a type id without the manager's right is not trusted");
  // The new event form uses the same read.
  await act({ action: "central-calendar-new-event" });
  assert.equal(typesReads(calls).length, 1);
  // Only readers' cards: no catalog read at all.
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  const none = installFetchMock(server({ items: [readerItem(DAY(2))] }));
  await loadCentralCalendar({ render });
  await tick();
  assert.equal(typesReads(none).length, 0);
});

test("D19. a Settings → Calendar change drops the catalog: the next calendar read reads it again", async () => {
  const calls = installFetchMock(server());
  await loadCentralCalendar({ render });
  await tick();
  assert.equal(typesReads(calls).length, 1);
  centralCalendarCatalogChanged();
  assert.equal(state.centralCalendar.eventTypes, null);
  assert.equal(state.centralCalendar.eventCatalog, null);
  await loadCentralCalendar({ render });
  await tick();
  assert.equal(typesReads(calls).length, 2);
});

test("D20. Awaiting details: after RPE, a result and attendance, before device data; its sentence; Details x/y beside RPE", () => {
  const card = (overrides) => eventItem(E_MATCH, DAY(1), { status: "awaiting_entry", ...overrides });
  const missing = { selected: 3, filled: 1, required: 2, filledRequired: 1 };
  assert.deepEqual(view.centralCalendarStatusBadge(card({ details: missing, expects: ["device_data"] })), { label: "Awaiting details", tone: "awaiting" }, "before device data");
  assert.equal(view.centralCalendarStatusBadge(card({ details: missing, expects: ["rpe"], rpe: { asked: 10, submitted: 3 } })).label, "Awaiting RPE", "after RPE");
  assert.equal(view.centralCalendarStatusBadge(card({ details: missing, attendance: { present: 1, roster: 3, needsState: 2 } })).label, "Awaiting attendance");
  assert.equal(view.centralCalendarStatusBadge(card({ details: { ...missing, filledRequired: 2 }, expects: ["device_data"] })).label, "Awaiting device data", "every required one is filled");
  assert.equal(view.centralCalendarStatusSentence(card({ details: missing })), "The event has ended and 1 required detail is still empty.");
  assert.equal(view.centralCalendarStatusSentence(card({ details: { ...missing, required: 3 } })), "The event has ended and 2 required details are still empty.");
  assert.equal(view.centralCalendarCountLabel(card({ details: missing })), "Details 1/3", "Q4: whenever the event has chosen details");
  assert.equal(view.centralCalendarCountLabel(card({ details: missing, rpe: { asked: 10, submitted: 3 } })), "RPE 3/10 · Details 1/3");
  assert.equal(view.centralCalendarCountLabel(card({ details: { selected: 0, filled: 0, required: 0, filledRequired: 0 } })), "");
  assert.equal(view.centralCalendarCountLabel(readerItem(DAY(2))), "", "a reader's card has no details");
});

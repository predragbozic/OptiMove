// K2c-2-F (docs/ai/central-calendar-k2c-plan.md 2.1, with the manager's GO in
// 2.2): "Make an event" from a Builder session, through the real handlers,
// data module and templates with a fake fetch. The fake keeps the routes'
// contracts: GET /api/calendar answers the day's cards (a session linked to
// an event folds under it, D16b), GET /events/types the catalog, and POST
// /api/calendar/events with `sessions` (K2c-2-B) replays the same key and
// body, answers request_key_reused for the same key with another body, and
// changes nothing on a refusal.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";
import { escapeHtml } from "../utils.js";

const questions = [];
let confirmAnswer = true;
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: (question) => { questions.push(question); return confirmAnswer; } };
globalThis.confirm = globalThis.window.confirm;

const { state, emptyBuilderState, emptyCentralCalendarState } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const actions = await import("../builder-calendar-event-actions.js");
const pure = await import("../builder-calendar-event.js");
const eventView = await import("../builder-calendar-event-view.js");
const helpers = await import("../builder-helpers.js");
const { renderBuilderBlock } = await import("../builder-structure.js");
const { centralCalendarMayBeLeft, centralCalendarUncertainWrites, clearCentralCalendarUncertainWrites, handleCentralCalendarBeforeUnload, openCentralCalendarAt } = await import("../central-calendar-actions.js");
const { addDaysIso, localDateIso } = await import("../utils.js");

const D = addDaysIso(localDateIso(), 2);
const PLAN_LIVE = "50000000-0000-4000-8000-000000000001";
const PLAN_DRAFT = "50000000-0000-4000-8000-0000000000d1";
const PLAN_OTHER = "50000000-0000-4000-8000-000000000002";
const A1 = "aaaaaaaa-0000-4000-8000-000000000001";
const A2 = "aaaaaaaa-0000-4000-8000-000000000002";
const L1 = "10000000-0000-4000-8000-000000000001";
const L2 = "10000000-0000-4000-8000-000000000002";
const T_TRAINING = "70000000-0000-4000-8000-000000000001";
const T_TRAINING2 = "70000000-0000-4000-8000-000000000002";
const T_MATCH = "70000000-0000-4000-8000-000000000003";
const E_NEW = "e0000000-0000-4000-8000-0000000000aa";
const E_OLD = "e0000000-0000-4000-8000-0000000000bb";
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CODES = /\b(session_already_attached|session_not_available|session_outside_event|athlete_not_targeted|target_not_available|type_not_available|invalid_\w+|try_again|request_key_reused|outcome_unknown|rpe_from_sessions|logicalSessionIds)\b/;

const TYPES = [
  { id: T_MATCH, kind: "match", label: "Match", defaultExpects: ["rpe"] },
  { id: T_TRAINING, kind: "training", label: "Training", defaultExpects: ["rpe", "device_data"] },
];

function plannedCard(overrides = {}) {
  return {
    key: "planned:x", kind: "planned", date: D, title: "Morning session", slot: { amPm: "AM", bta: "T", order: 1 }, startTime: "09:30",
    athleteIds: [A1, A2], athleteCount: 2, athletes: [{ athleteId: A1, name: "Ana Example" }, { athleteId: A2, name: "Ben Example" }],
    expects: ["rpe"], rpe: { asked: 2, submitted: 0 }, links: { activityIds: [], planIds: [PLAN_LIVE, PLAN_OTHER], logicalSessionIds: [L1, L2] },
    ...overrides,
  };
}
function eventCard(id, title, planIds) {
  return { key: `event:${id}:${D}`, kind: "event", eventId: id, date: D, title, cancelled: false, links: { eventId: id, planIds, logicalSessionIds: [L1, L2] } };
}

// The fake server. `refuse(body, call)` may answer a create first; `lose`
// loses the answer of the next creates ("saved": saved, answer lost; "notSaved":
// lost before anything was saved).
function server({ items = () => [plannedCard()], types = TYPES, refuse = null, lose = [], readFails = 0 } = {}) {
  let cards = items();
  const keys = new Map();
  const losing = [...lose];
  let failing = readFails;
  const fake = (call) => {
    const url = call.url;
    if (url.startsWith("/api/calendar/events/types")) return { status: 200, body: { types, fields: [], locations: [], teamDefaults: {} } };
    if (url.startsWith("/api/calendar?")) {
      if (failing > 0) {
        failing -= 1;
        return { status: 500, body: { error: "internal_error" } };
      }
      return { status: 200, body: { workspace: { type: "team" }, days: [{ date: D, items: cards }] } };
    }
    if (url === "/api/calendar/events" && call.method === "POST") {
      const body = call.body;
      const prior = keys.get(body.requestKey);
      if (prior) {
        if (prior.raw !== JSON.stringify(body)) return { status: 409, body: { error: "request_key_reused", message: "x" } };
        return { status: 201, body: { ...prior.answer, replayed: true } };
      }
      const refused = refuse?.(body, call);
      const loss = losing.shift();
      if (loss === "notSaved") return { throwNetworkError: true };
      if (refused) return refused;
      const answer = { event: { id: E_NEW, title: body.title, day: body.day }, attached: body.sessions.logicalSessionIds.length, alreadyAttached: 0, alignment: null };
      keys.set(body.requestKey, { raw: JSON.stringify(body), answer });
      cards = cards.filter((card) => !(card.kind === "planned" && card.links.logicalSessionIds.some((id) => body.sessions.logicalSessionIds.includes(id))));
      cards.push(eventCard(E_NEW, body.title, [PLAN_LIVE, PLAN_OTHER]));
      if (loss === "saved") return { status: 503, body: { error: "outcome_unknown", message: "x" } };
      return { status: 201, body: answer };
    }
    return { status: 404, body: { error: "notFound" } };
  };
  fake.cards = () => cards;
  return fake;
}

let renders = 0;
const render = () => { renders += 1; };
const posts = (calls) => calls.filter((call) => call.method === "POST");

function draftWith({ isEditDraft = true, status = "draft", planType = "weekly", isTemplate = false, session = {} } = {}) {
  return {
    plan: { id: isEditDraft ? PLAN_DRAFT : PLAN_LIVE, isEditDraft, editSourcePlanId: isEditDraft ? PLAN_LIVE : "", planType, status, isTemplate, name: "Week" },
    blocks: [{ id: "b1", index: 1, date: D, name: "", sessions: [{ id: "s1", amPm: "AM", bta: "T", time: "09:30", name: "Morning session", nodes: [], ...session }] }],
    batch: { plans: [] },
  };
}

const act = (name, extra = {}) => fakeAction({ action: `builder-calendar-event-${name}`, sessionId: "s1", ...extra });
const handlers = { renderBuilder: render, openCalendarAt: (target) => { opened.push(target); } };
let opened = [];
async function press(name, extra) {
  return actions.handleBuilderCalendarEventAction(act(name, extra), handlers);
}
function panelHtml() {
  const block = state.builder.draft.blocks[0];
  return eventView.renderBuilderCalendarEventPanel({ session: block.sessions[0], block, panel: state.builder.calendarEvent, types: state.builder.calendarEvent?.types || [] });
}
function rowHtml(workspaceType = state.currentUser.activeWorkspace.type) {
  const block = state.builder.draft.blocks[0];
  const context = {
    ...helpers, clipboard: null, selectedSessionId: "", inlineAddOpen: false, inlineAddType: "", inlineAddSessionId: "", inlineAddParentId: "",
    previewSectionId: "", editNodeOpen: "", builderNodePresets: [], blockAddOpen: false, sessionQuickAdd: { blockId: "", amPm: "", bta: "", time: "" },
    findBuilderSession: (id) => helpers.findBuilderSession(state.builder.draft, id),
    renderCalendarEventButton: (b, s) => eventView.renderBuilderCalendarEventButton({ draft: state.builder.draft, block: b, session: s, workspaceType, panel: state.builder.calendarEvent, made: state.builder.calendarEventsMade }),
    renderCalendarEventPanel: (b, s) => eventView.renderBuilderCalendarEventPanel({ session: s, block: b, panel: state.builder.calendarEvent, types: state.builder.calendarEvent?.types || [] }),
  };
  return renderBuilderBlock(block, "", "", true, context);
}
function noIdsOrCodes(html) {
  const text = html.replace(/<[^>]*>/g, " ");
  assert.doesNotMatch(text, UUID_ANYWHERE, "no id in the panel's text");
  assert.doesNotMatch(text, CODES, "no code in the panel's text");
}
async function open(fakeOptions, draftOptions) {
  const fake = server(fakeOptions);
  const calls = installFetchMock(fake);
  state.builder.draft = draftWith(draftOptions);
  await press("open");
  return { fake, calls };
}

beforeEach(() => {
  clearAllViewCache();
  clearCentralCalendarUncertainWrites();
  actions.resetBuilderCalendarEventForTests();
  state.builder = emptyBuilderState();
  state.centralCalendar = emptyCentralCalendarState();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "team", scopeId: "t1", label: "U19" } };
  state.deliberateNavigation = false;
  confirmAnswer = true;
  questions.length = 0;
  opened = [];
  renders = 0;
});

// --- 1. Who sees the button --------------------------------------------------------------
test("1. the button: a saved plan's edit draft and a saved plan in a club, team and private-coach workspace; never a template, a program, the platform or athlete workspace; a never-saved plan is off with its line", () => {
  for (const type of ["club", "team", "private_coach"]) {
    state.builder.draft = draftWith();
    assert.match(rowHtml(type), /data-action="builder-calendar-event-open"/, `${type}: offered on an edit draft`);
    state.builder.draft = draftWith({ isEditDraft: false, status: "active" });
    assert.match(rowHtml(type), /data-action="builder-calendar-event-open"/, `${type}: offered on a saved plan`);
  }
  for (const type of ["platform", "athlete", ""]) {
    state.builder.draft = draftWith();
    assert.doesNotMatch(rowHtml(type), /builder-calendar-event-open/, `${type || "none"}: not offered`);
  }
  state.builder.draft = draftWith({ isTemplate: true });
  assert.doesNotMatch(rowHtml("team"), /builder-calendar-event-open/, "a template");
  state.builder.draft = draftWith({ planType: "program" });
  assert.doesNotMatch(rowHtml("team"), /builder-calendar-event-open/, "a program");
  state.builder.draft = draftWith({ isEditDraft: false, status: "draft" });
  const html = rowHtml("team");
  assert.match(html, /data-action="builder-calendar-event-open"[^>]*disabled/);
  assert.match(html, /Save the plan first, then make the event\./);
});

// --- 2. The match on the day read -----------------------------------------------------------
test("2. one planned card of the live plan, slot and name: the form with the group's title, time, athletes and RPE; the read asks for that one day with the athletes' names", async () => {
  const { calls } = await open();
  const rec = state.builder.calendarEvent;
  assert.equal(rec.phase, "ready");
  assert.equal(rec.match.kind, "planned");
  const read = calls.find((call) => call.url.startsWith("/api/calendar?"));
  const params = new URL(read.url, "http://x").searchParams;
  assert.equal(params.get("from"), D);
  assert.equal(params.get("to"), D);
  assert.equal(params.get("include"), "athletes");
  assert.deepEqual(rec.form, { title: "Morning session", typeId: T_TRAINING, startTime: "09:30", endTime: "" });
  const html = panelHtml();
  assert.match(html, /Make the event/);
  assert.match(html, /2 athletes/);
  assert.match(html, /Ana Example, Ben Example/);
  assert.match(html, /Type: Training/, "one training type: no select");
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /Asks for RPE \(same as this training\)\./);
  assert.match(html, /For \d+ athletes?/);
  // The form has its own Cancel: no second Close in its header.
  assert.doesNotMatch(html, /cc-builder-event-close/);
  assert.doesNotMatch(html, /type="checkbox"/, "no RPE checkbox (decision 5)");
  noIdsOrCodes(html);
});

test("2b. no guess: another plan's card, another slot, another name, two fitting cards, an edit draft with unapplied changes, an event that holds the session", async () => {
  const cases = [
    { label: "another plan", items: () => [plannedCard({ links: { activityIds: [], planIds: [PLAN_OTHER], logicalSessionIds: [L2] } })], sentence: pure.MATCH_SENTENCES.apply },
    { label: "another slot", items: () => [plannedCard({ slot: { amPm: "PM", bta: "T", order: 1 } })], sentence: pure.MATCH_SENTENCES.apply },
    { label: "another name", items: () => [plannedCard({ title: "Evening session" })], sentence: pure.MATCH_SENTENCES.apply },
    { label: "a saved plan, absent", items: () => [], draft: { isEditDraft: false, status: "active" }, sentence: pure.MATCH_SENTENCES.absent },
    { label: "two fitting cards", items: () => [plannedCard({ key: "a" }), plannedCard({ key: "b" })], sentence: pure.MATCH_SENTENCES.ambiguous },
    { label: "linked", items: () => [eventCard(E_OLD, "Team training", [PLAN_LIVE])], sentence: "This training is in the calendar as “Team training”." },
  ];
  for (const c of cases) {
    state.builder = emptyBuilderState();
    const { calls } = await open({ items: c.items }, c.draft);
    const rec = state.builder.calendarEvent;
    assert.notEqual(rec.match.kind, "planned", c.label);
    const html = panelHtml();
    assert.ok(html.includes(escapeHtml(c.sentence)) || html.includes(c.sentence), `${c.label}: ${html}`);
    // A sentence without a form always has a next step (ux review MEDIUM-2).
    if (c.sentence === pure.MATCH_SENTENCES.apply || c.sentence === pure.MATCH_SENTENCES.absent) {
      assert.match(html, /builder-calendar-event-open-calendar/, `${c.label}: Open in calendar`);
    }
    if (c.label === "linked") assert.match(html, /In the calendar<\/h4>/);
    assert.doesNotMatch(html, /builder-calendar-event-send/, `${c.label}: nothing to make`);
    assert.equal(posts(calls).length, 0);
    noIdsOrCodes(html);
  }
  // The linked event: Open in calendar opens that event's card.
  await press("open-calendar");
  assert.deepEqual(opened.at(-1), { date: D, key: `event:${E_OLD}:${D}` });
});

test("2c. a matching name is trimmed and case-insensitive (D16b's key); no training type gives one sentence and no form", async () => {
  await open({ items: () => [plannedCard({ title: "  morning SESSION " })] });
  assert.equal(state.builder.calendarEvent.match.kind, "planned");
  // The workspace's types are read once per workspace (the calendar's
  // catalog): a new world starts with a fresh calendar slice.
  state.builder = emptyBuilderState();
  state.centralCalendar = emptyCentralCalendarState();
  await open({ types: [TYPES[0]] });
  const html = panelHtml();
  assert.match(html, /no Training event type/);
  assert.doesNotMatch(html, /builder-calendar-event-send/);
  state.builder = emptyBuilderState();
  state.centralCalendar = emptyCentralCalendarState();
  await open({ types: [...TYPES, { id: T_TRAINING2, kind: "training", label: "Gym", defaultExpects: [] }] });
  assert.match(panelHtml(), /<select data-builder-event-field="typeId"/, "two training types: a select");
});

test("3. the read: a failure offers Try again (nothing sent); a slower earlier answer never replaces a newer one", async () => {
  const { calls } = await open({ readFails: 1 });
  assert.equal(state.builder.calendarEvent.phase, "read_error");
  assert.match(panelHtml(), /The calendar could not be read\./);
  await press("retry");
  assert.equal(state.builder.calendarEvent.phase, "ready");
  assert.equal(posts(calls).length, 0);

  // Two presses on two sessions: the first answer arrives last and is dropped.
  state.builder = emptyBuilderState();
  state.builder.draft = draftWith();
  state.builder.draft.blocks[0].sessions.push({ id: "s2", amPm: "PM", bta: "T", time: "", name: "Gym", nodes: [] });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const fake = server();
  let n = 0;
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/calendar?") && n++ === 0) await firstGate;
    return fake(call);
  });
  const first = actions.handleBuilderCalendarEventAction(act("open"), handlers);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await actions.handleBuilderCalendarEventAction(act("open", { sessionId: "s2" }), handlers);
  assert.equal(state.builder.calendarEvent.sessionId, "s2");
  const s2Kind = state.builder.calendarEvent.match.kind;
  releaseFirst();
  await first;
  assert.equal(state.builder.calendarEvent.sessionId, "s2", "the older answer did not take over the panel");
  assert.equal(state.builder.calendarEvent.match.kind, s2Kind);
});

// --- 4. The request ------------------------------------------------------------------------
test("4. one POST with the exact body: the group's athletes as targets, the group's sessions, alignSessions false, expects following the training, the time zone, a fresh key", async () => {
  const { calls } = await open();
  actions.handleBuilderCalendarEventInput({ dataset: { builderEventField: "title" }, value: "  Morning   session " });
  actions.handleBuilderCalendarEventInput({ dataset: { builderEventField: "endTime" }, value: "11:00" });
  await press("send");
  const sent = posts(calls);
  assert.equal(sent.length, 1);
  const body = sent[0].body;
  assert.equal(sent[0].url, "/api/calendar/events");
  assert.match(body.requestKey, UUID_ANYWHERE);
  assert.deepEqual(
    { ...body, requestKey: "k", timezone: "tz" },
    {
      requestKey: "k", eventTypeId: T_TRAINING, title: "Morning session", day: D, startTime: "09:30", endTime: "11:00", timezone: "tz",
      expects: ["rpe", "device_data"], targets: [{ kind: "athlete", id: A1 }, { kind: "athlete", id: A2 }],
      sessions: { logicalSessionIds: [L1, L2], alignSessions: false },
    },
  );
  assert.equal(typeof body.timezone, "string");
  assert.ok(body.timezone.length > 0);
});

test("4b. a training that does not ask for RPE makes an event without RPE; the local checks send nothing", async () => {
  const { calls } = await open({ items: () => [plannedCard({ rpe: null, expects: [] })] });
  assert.match(panelHtml(), /No RPE request \(same as this training\)\./);
  actions.handleBuilderCalendarEventInput({ dataset: { builderEventField: "title" }, value: "   " });
  await press("send");
  assert.equal(posts(calls).length, 0);
  assert.equal(state.builder.calendarEvent.message, "Give the event a title.");
  actions.handleBuilderCalendarEventInput({ dataset: { builderEventField: "title" }, value: "Morning" });
  actions.handleBuilderCalendarEventInput({ dataset: { builderEventField: "endTime" }, value: "09:00" });
  await press("send");
  assert.equal(posts(calls).length, 0);
  assert.equal(state.builder.calendarEvent.message, "The end time must be after the start time.");
  actions.handleBuilderCalendarEventInput({ dataset: { builderEventField: "endTime" }, value: "" });
  await press("send");
  assert.deepEqual(posts(calls)[0].body.expects, ["device_data"]);
});

// --- 5. Success ---------------------------------------------------------------------------
test("5. success: the notice with Open in calendar (the new event's card), the In calendar badge, the calendar cache dropped; pressing again shows the linked line", async () => {
  await open();
  await press("send");
  const rec = state.builder.calendarEvent;
  assert.equal(rec.phase, "done");
  const html = panelHtml();
  assert.match(html, new RegExp(`Event made: .Morning session., ${pure.formatDay(D).replace(/\./g, "\\.")}\\.`));
  assert.match(html, /Open in calendar/);
  noIdsOrCodes(html);
  await press("open-calendar");
  assert.deepEqual(opened.at(-1), { date: D, key: `event:${E_NEW}:${D}` });
  assert.match(rowHtml(), /In calendar/);
  assert.equal(centralCalendarUncertainWrites().length, 0);
  // The same session again: the day read now shows it folded under the event.
  state.builder.calendarEvent = null;
  await press("open");
  assert.equal(state.builder.calendarEvent.match.kind, "linked");
  assert.match(panelHtml(), /This training is in the calendar as/);
});

test("5b. the alignment notes of the answer", () => {
  assert.deepEqual(pure.builderCalendarEventDoneNotes({ notAllowed: 1, switchOff: 2 }), [
    "Some of these trainings belong to another coach's plan and were left as they are.",
    "RPE requests are switched off in Training Load, so athletes will not be asked until they are switched on.",
  ]);
  assert.deepEqual(pure.builderCalendarEventDoneNotes(null), []);
});

// --- 6. Refusals ------------------------------------------------------------------------
test("6. every refusal: one sentence, nothing else changed, the day read again where it matters, a new key on the next press", async () => {
  const cases = [
    ["session_already_attached", 409, "This training is already in another event. Open the calendar to see it.", true],
    ["session_not_available", 400, "This training can't be added to an event from this workspace. Nothing was saved.", true],
    ["session_outside_event", 409, "This training is not on the event's day any more. Nothing was saved.", true],
    ["athlete_not_targeted", 409, "Some athletes of this training can't be part of an event of this workspace. Nothing was saved.", true],
    ["target_not_available", 400, "Some athletes of this training are not in this workspace on that day. Nothing was saved.", true],
    ["type_not_available", 400, "This event type is no longer available. Choose another one.", true],
    ["invalid_align", 400, "This could not be sent. Nothing was saved; try again.", false],
    ["try_again", 409, "The calendar is busy. Nothing was saved; try again in a moment.", false],
    ["request_key_reused", 409, "This could not be sent. Nothing was saved; try again.", false],
    ["internal_error", 500, "Nothing was saved. Try again.", false],
  ];
  for (const [code, status, sentence, reread] of cases) {
    state.builder = emptyBuilderState();
    let refuseOnce = true;
    const { calls } = await open({ refuse: () => (refuseOnce ? ((refuseOnce = false), { status, body: { error: code, message: `server ${code}` } }) : null) });
    const readsBefore = calls.filter((call) => call.url.startsWith("/api/calendar?")).length;
    await press("send");
    const rec = state.builder.calendarEvent;
    assert.equal(rec.phase, "ready", code);
    assert.equal(rec.message, sentence, code);
    const html = panelHtml();
    assert.match(html, /role="alert"/, code);
    noIdsOrCodes(html);
    assert.equal(calls.filter((call) => call.url.startsWith("/api/calendar?")).length > readsBefore, reread, `${code}: read again`);
    assert.equal(centralCalendarUncertainWrites().length, 0, `${code}: nothing kept to check`);
    const firstKey = posts(calls)[0].body.requestKey;
    await press("send");
    const second = posts(calls)[1];
    assert.ok(second, `${code}: sent again`);
    assert.notEqual(second.body.requestKey, firstKey, `${code}: a new key`);
  }
});

// --- 7. A lost answer -----------------------------------------------------------------
test("7. a lost answer: Result not confirmed, kept in the calendar's memory; Check result sends the same path, body and key; a saved one settles as made, never a second event", async () => {
  const { calls, fake } = await open({ lose: ["saved"] });
  await press("send");
  const rec = state.builder.calendarEvent;
  assert.equal(rec.phase, "unconfirmed");
  assert.ok(panelHtml().includes(escapeHtml(pure.RESULT_NOT_CONFIRMED)));
  assert.ok(panelHtml().includes(escapeHtml(pure.CHECK_NEVER_TWICE)));
  assert.match(panelHtml(), /Check result/);
  assert.doesNotMatch(panelHtml(), /builder-calendar-event-send/, "no second create from the form");
  assert.match(rowHtml(), /data-action="builder-calendar-event-close"[^>]*disabled/);
  const kept = centralCalendarUncertainWrites();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].mode, "create");
  assert.equal(kept[0].requestKey, posts(calls)[0].body.requestKey);
  assert.deepEqual(kept[0].sentBody, posts(calls)[0].body);
  await press("check");
  const [first, second] = posts(calls);
  assert.equal(second.url, first.url);
  assert.deepEqual(second.body, first.body, "the same body and key");
  assert.equal(state.builder.calendarEvent.phase, "done");
  assert.equal(centralCalendarUncertainWrites().length, 0, "settled: forgotten");
  assert.equal(fake.cards().filter((card) => card.kind === "event").length, 1, "one event");
});

test("7b. a check answered by the server's busy pool or another lost answer stays not confirmed; a settling refusal ends it as nothing saved", async () => {
  let mode = "busy";
  const fake = server({ lose: ["notSaved"] });
  const calls = installFetchMock((call) => {
    if (call.method === "POST" && posts(calls).length >= 2) {
      if (mode === "busy") return { status: 409, body: { error: "try_again" } };
      if (mode === "lost") return { throwNetworkError: true };
      if (mode === "settle") return { status: 409, body: { error: "session_already_attached" } };
    }
    return fake(call);
  });
  state.builder.draft = draftWith();
  await press("open");
  await press("send");
  assert.equal(state.builder.calendarEvent.phase, "unconfirmed");
  for (mode of ["busy", "lost"]) {
    await press("check");
    assert.equal(state.builder.calendarEvent.phase, "unconfirmed", mode);
    assert.match(panelHtml(), /Still not confirmed/);
    assert.equal(centralCalendarUncertainWrites().length, 1, `${mode}: still kept`);
  }
  mode = "settle";
  await press("check");
  assert.equal(state.builder.calendarEvent.phase, "ready");
  assert.equal(state.builder.calendarEvent.message, "This training is already in another event. Open the calendar to see it.");
  assert.equal(centralCalendarUncertainWrites().length, 0);
  const keys = new Set(posts(calls).map((call) => call.body.requestKey));
  assert.equal(keys.size, 1, "every check used the first key");
});

// --- 8. One control at a time ----------------------------------------------------------------
test("8. one control at a time: a double click sends one POST; while a write is in flight or not confirmed the other sessions' buttons are off and the panel cannot close", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fake = server();
  const calls = installFetchMock(async (call) => {
    if (call.method === "POST") await gate;
    return fake(call);
  });
  state.builder.draft = draftWith();
  state.builder.draft.blocks[0].sessions.push({ id: "s2", amPm: "PM", bta: "T", time: "", name: "Gym", nodes: [] });
  await press("open");
  const one = press("send");
  const two = press("send");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(state.builder.calendarEvent.phase, "sending");
  const html = rowHtml();
  assert.match(html, /data-session-id="s2"[^>]*disabled/, "another session's button is off");
  assert.ok(html.includes(escapeHtml(pure.FINISH_FIRST)), "the reason is next to it");
  assert.match(html, /data-session-id="s1"[^>]*aria-controls="cc-builder-event-s1"/, "the open button names its panel");
  await press("close");
  assert.ok(state.builder.calendarEvent, "the panel stays while sending");
  await press("open", { sessionId: "s2" });
  assert.equal(state.builder.calendarEvent.sessionId, "s1");
  release();
  await Promise.all([one, two]);
  assert.equal(posts(calls).length, 1);
});

// --- 9. Leaving --------------------------------------------------------------------------
test("9. leaving: an event being made is in the calendar's memory from the send, so the calendar's own guards ask (sign-out, a reload, beforeunload) and a switch between workspaces keeps it to check; a settled answer forgets it", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fake = server();
  const calls = installFetchMock(async (call) => {
    if (call.method === "POST") await gate;
    return fake(call);
  });
  state.builder.draft = draftWith();
  await press("open");
  const sending = press("send");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const kept = centralCalendarUncertainWrites();
  assert.equal(kept.length, 1, "kept from the send");
  assert.equal(kept[0].mode, "create");
  assert.equal(kept[0].requestKey, posts(calls)[0].body.requestKey);
  assert.deepEqual(kept[0].sentBody, posts(calls)[0].body);
  // The calendar's guards, unchanged, count it.
  confirmAnswer = false;
  assert.equal(centralCalendarMayBeLeft({ final: "sign-out" }), false, "a sign-out asks");
  assert.match(questions.at(-1), /Sign out anyway\?/);
  assert.equal(centralCalendarMayBeLeft({ final: false }), true, "a switch between clubs keeps it, unasked");
  const unload = { preventDefault() { this.prevented = true; }, returnValue: undefined, isTrusted: true };
  assert.equal(handleCentralCalendarBeforeUnload(unload), true);
  assert.equal(unload.prevented, true);
  release();
  await sending;
  assert.equal(state.builder.calendarEvent.phase, "done");
  assert.equal(centralCalendarUncertainWrites().length, 0, "made: forgotten");
  questions.length = 0;
  assert.equal(centralCalendarMayBeLeft({ final: "sign-out" }), true);
  assert.equal(questions.length, 0, "nothing left to ask about");
});

test("9b. a write whose answer lands after the Builder was left still settles the calendar's memory; a lost one stays there to check", async () => {
  for (const outcome of ["made", "lost"]) {
    clearCentralCalendarUncertainWrites();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fake = server({ lose: outcome === "lost" ? ["notSaved"] : [] });
    installFetchMock(async (call) => {
      if (call.method === "POST") await gate;
      return fake(call);
    });
    state.builder = emptyBuilderState();
    state.builder.draft = draftWith();
    await press("open");
    const sending = press("send");
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.builder = emptyBuilderState();
    release();
    await sending;
    assert.equal(centralCalendarUncertainWrites().length, outcome === "made" ? 0 : 1, outcome);
  }
});

// --- 10. Open in calendar -----------------------------------------------------------------
test("10. openCentralCalendarAt sets the calendar's day and opens the event's panel, never over an open form", () => {
  openCentralCalendarAt({ date: D, key: `event:${E_NEW}:${D}` });
  assert.equal(state.centralCalendar.anchor, D);
  assert.equal(state.centralCalendar.selectedDate, D);
  assert.deepEqual({ open: state.centralCalendar.panel.open, key: state.centralCalendar.panel.key, date: state.centralCalendar.panel.date }, { open: true, key: `event:${E_NEW}:${D}`, date: D });
  state.centralCalendar = emptyCentralCalendarState();
  state.centralCalendar.form = { mode: "create" };
  openCentralCalendarAt({ date: D, key: `event:${E_NEW}:${D}` });
  assert.equal(state.centralCalendar.panel.open, false);
  assert.equal(state.centralCalendar.anchor, D);
});

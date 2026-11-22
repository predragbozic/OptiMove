// K3 and K2c-3 (docs/ai/central-calendar-k3-plan.md 2.1 - 2.6 and 6.2 - 6.4) through the real action modules with a
// fake fetch: which plan opens, the session memory (the manager's GO: ids and slot keys only, cleared on sign-out and on
// a workspace change), Save and link's attaches (each part of up to 200 its own key and outcome; never "linked" without
// a confirmed answer; a partial success said), Check result with the same key and body, and the Builder's Event: [▾].
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installFetchMock } from "./support/fetch-mock.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true };
const store = new Map();
globalThis.sessionStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { state, emptyBuilderState, emptyCentralCalendarState } = await import("../state.js");
const k3 = await import("../central-calendar-k3-actions.js");
const row = await import("../builder-events-row.js");
const { centralCalendarUncertainWrites, clearCentralCalendarUncertainWrites, openCentralCalendarAt } = await import("../central-calendar-actions.js");
const { weekMondayIso, addDaysIso } = await import("../utils.js");

const DAY = "2026-11-19";
const WEEK = weekMondayIso(DAY);
const A = ["a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002", "a0000000-0000-4000-8000-000000000003"];
const EVENT = {
  key: `event:e1:${DAY}`, kind: "event", eventId: "e1", date: DAY, title: "Team training", eventKind: "training", canManage: true,
  startTime: "10:00", endTime: "11:30", revision: 3, expects: [], athleteIds: A.slice(0, 2), links: { planIds: [] },
};

function draftOf({ status = "draft", isEditDraft = false, sessions = [{ id: "s1", amPm: "AM", bta: "T", name: "Main session", time: "", nodes: [{ id: "n1", name: "Warm-up", items: [] }] }] } = {}) {
  return {
    plan: { id: isEditDraft ? "d1" : "p1", status, isEditDraft, editSourcePlanId: isEditDraft ? "p1" : null, planType: "weekly", weekStart: WEEK, athleteId: "101" },
    batch: { plans: [{ id: "p1", athleteId: "101" }, { id: "p2", athleteId: "102" }] },
    blocks: [{ id: "b-day", date: DAY, sessions }, { id: "b-next", date: addDaysIso(DAY, 1), sessions: [] }],
  };
}

const planned = (ids, { name = "Main session", amPm = "AM", bta = "T" } = {}) => ({
  key: `planned:x:${DAY}`, kind: "planned", date: DAY, title: name, slot: { amPm, bta, order: 0 },
  athletes: ids.map((id, i) => ({ athleteId: A[i % 3], planId: i % 2 ? "p2" : "p1", logicalSessionId: id })),
});

function calendarAnswer(items) {
  return { days: [{ date: DAY, items }] };
}

beforeEach(() => {
  store.clear();
  clearCentralCalendarUncertainWrites();
  state.currentUser = { id: "u1", activeWorkspace: { type: "team", scopeId: "t1", label: "First team" } };
  state.athletes = [
    { athlete_id: "101", athlete_uuid: A[0], athlete: "Ana Example" },
    { athlete_id: "102", athlete_uuid: A[1], athlete: "Ben Example" },
  ];
  state.builder = emptyBuilderState();
  state.centralCalendar = emptyCentralCalendarState();
  state.activeTab = "central-calendar";
});

test("1. none has a plan (case b): one create for the event's athletes by their Builder ids, then the Builder with the band's context", async () => {
  const calls = installFetchMock((call) => {
    if (call.url.startsWith("/api/builder/weekly-plans")) return { status: 200, body: { athletes: A.slice(0, 2).map((athleteId) => ({ athleteId, plannable: true, plan: null })) } };
    if (call.url === "/api/builder/plans" && call.method === "POST") return { status: 201, body: draftOf() };
    return { status: 404, body: {} };
  });
  let opened = null;
  await k3.k3StartFromPanel(state.centralCalendar, EVENT, { openBuilder: (draft, context) => { opened = { draft, context }; } }, () => {});
  const read = new URL(calls[0].url, "http://x");
  assert.equal(read.searchParams.get("weekStart"), WEEK);
  assert.deepEqual(read.searchParams.get("athleteIds").split(","), A.slice(0, 2));
  assert.deepEqual(calls[1].body, { planType: "weekly", weekStart: WEEK, athleteIds: ["101", "102"], name: "Team training · Thu 19.11" });
  assert.ok(opened, "the Builder was opened");
  assert.equal(opened.context.eventId, "e1");
  assert.equal(opened.context.athleteCount, 2);
  assert.deepEqual(opened.context.planIds.sort(), ["p1", "p2"]);
});

test("2. the session memory (GO): ids and slot keys only - never a name or a title - and gone on clear", async () => {
  installFetchMock((call) => {
    if (call.url.startsWith("/api/builder/weekly-plans")) return { status: 200, body: { athletes: A.slice(0, 2).map((athleteId) => ({ athleteId, plannable: true, plan: null })) } };
    if (call.url === "/api/builder/plans") return { status: 201, body: draftOf() };
    return { status: 404, body: {} };
  });
  let context = null;
  await k3.k3StartFromPanel(state.centralCalendar, EVENT, { openBuilder: (_, c) => { context = c; } }, () => {});
  state.builder = emptyBuilderState({ draft: draftOf() });
  state.builder.k3 = context;
  k3.k3ToggleSession(`${DAY}|AM|T|main session`);
  const keys = [...store.keys()];
  assert.deepEqual(keys, ["optimove.k3.u1.p1"]);
  const entry = JSON.parse(store.get(keys[0]));
  assert.deepEqual(Object.keys(entry).sort(), ["date", "eventId", "eventKey", "outKeys", "planIds", "workspace"]);
  assert.deepEqual(entry.outKeys, [`${DAY}|AM|T|main session`]);
  const raw = store.get(keys[0]);
  for (const secret of ["Ana", "Ben", "Team training", "First team"]) assert.equal(raw.includes(secret), false, `the memory holds ${secret}`);
  k3.clearK3Memory();
  assert.equal(store.size, 0);
});

test("2b. sign-out and a workspace change clear the K3 memory and end the band (app.js)", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const signOut = app.slice(app.indexOf("async function signOut()"), app.indexOf("async function signOut()") + 2400);
  assert.match(signOut, /clearAllViewCache\(\);\s*\/\/ K3[^\n]*\n\s*clearK3Memory\(\);/, "sign-out clears it");
  assert.match(app, /builderEventsResetForWorkspaceChange\(\);\s*\/\/ K3[^\n]*\n\s*clearK3Memory\(\);\s*if \(state\.builder\) state\.builder\.k3 = null;/, "a workspace change clears it and ends the band");
});

test("3. some athletes have a plan (case c): the sheet counts, names only the ones the coach may open, counts the rest; nothing is created", async () => {
  const calls = installFetchMock((call) => {
    if (call.url.startsWith("/api/builder/weekly-plans")) {
      return { status: 200, body: { athletes: [
        { athleteId: A[0], plannable: true, plan: { planId: "pa", status: "active", batchId: null, mine: true, editable: true, openDraftId: null } },
        { athleteId: A[1], plannable: true, plan: null },
        { athleteId: A[2], plannable: false },
      ] } };
    }
    return { status: 404, body: {} };
  });
  const event = { ...EVENT, athleteIds: A };
  await k3.k3StartFromPanel(state.centralCalendar, event, { openBuilder: () => assert.fail("no Builder yet") }, () => {});
  const sheet = state.centralCalendar.k3.sheet;
  assert.equal(sheet.text, "1 athlete has no plan for this week. 1 already has one: Ana Example.");
  assert.equal(sheet.note, "1 athlete of this event isn't in your workspace; plan their training in their own workspace.");
  assert.deepEqual(sheet.buttons, ["planForRest", "openExisting", "cancel"]);
  assert.equal(calls.length, 1, "only the read");
});

test("3b. a create refused 409 (a plan made meanwhile) reads the plans again and asks again", async () => {
  let reads = 0;
  installFetchMock((call) => {
    if (call.url.startsWith("/api/builder/weekly-plans")) {
      reads += 1;
      return { status: 200, body: { athletes: A.slice(0, 2).map((athleteId, i) => ({ athleteId, plannable: true, plan: reads > 1 && i === 0 ? { planId: "pa", status: "active", batchId: null, mine: false, editable: true, openDraftId: null } : null })) } };
    }
    if (call.url === "/api/builder/plans") return { status: 409, body: { error: "Athlete X already has a weekly plan for that week." } };
    return { status: 404, body: {} };
  });
  await k3.k3StartFromPanel(state.centralCalendar, EVENT, { openBuilder: () => assert.fail("not opened") }, () => {});
  assert.equal(reads, 2);
  assert.match(state.centralCalendar.k3.sheet.text, /1 athlete has no plan for this week\. 1 already has one: Ana Example\./);
});

test("3c. a create answered 409 try_again (the plan is busy) is shown once and not sent again", async () => {
  let creates = 0;
  installFetchMock((call) => {
    if (call.url.startsWith("/api/builder/weekly-plans")) {
      return { status: 200, body: { athletes: A.slice(0, 2).map((athleteId) => ({ athleteId, plannable: true, plan: null })) } };
    }
    if (call.url === "/api/builder/plans") {
      creates += 1;
      if (creates > 3) throw new Error("the create was sent again and again");
      return { status: 409, body: { error: "The plan is busy. Nothing was saved. Try again.", code: "try_again" } };
    }
    return { status: 404, body: {} };
  });
  await k3.k3StartFromPanel(state.centralCalendar, EVENT, { openBuilder: () => assert.fail("not opened") }, () => {});
  assert.equal(creates, 1, "one create");
  assert.equal(state.centralCalendar.k3.busy, false);
  assert.ok(state.centralCalendar.k3.error, "one sentence is shown");
});

// The event as GET /api/calendar/events/:id gives it to its manager (its revision).
let eventRevision = 3;
const eventRead = (call) => (call.url === "/api/calendar/events/e1" && (call.method || "GET") === "GET" ? { status: 200, body: { event: { id: "e1", revision: eventRevision, status: "planned" } } } : null);

function k3Builder({ outKeys = [], expectsRpe = false } = {}) {
  eventRevision = 3;
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ draft: draftOf() });
  state.builder.k3 = {
    eventId: "e1", eventKey: EVENT.key, date: DAY, endDate: DAY, span: null, title: "Team training", eventKind: "training",
    startTime: "10:00", endTime: "11:30", placeName: "", expectsRpe, athleteIds: A.slice(0, 2), athleteCount: 2, clubPlan: false,
    workspace: "team:t1", anchorPlanId: "p1", planIds: ["p1", "p2"], outKeys, saving: false, blocker: null, timeMessage: null, saved: null,
  };
  return state.builder.k3;
}

test("4. Save and link: the save, one read of the day, one attach with the event's revision and a fresh key; 'linked' only on its 200", async () => {
  const context = k3Builder();
  const calls = installFetchMock((call) => {
    if (eventRead(call)) return eventRead(call);
    if (call.url.startsWith("/api/calendar?")) return { status: 200, body: calendarAnswer([EVENT, planned(["l1", "l2"])]) };
    if (call.url === "/api/calendar/events/e1/sessions") return { status: 200, body: { attached: 2, alreadyAttached: 0 } };
    return { status: 404, body: {} };
  });
  let submitted = 0;
  await k3.k3SaveAndLink({ submit: async () => { submitted += 1; return { plan: { id: "p1" } }; }, render: () => {} });
  assert.equal(submitted, 1);
  const read = calls.find((c) => c.url.startsWith("/api/calendar?"));
  assert.equal(new URL(read.url, "http://x").searchParams.get("kinds"), "planned", "read without events: nothing folds");
  const attach = calls.find((c) => c.url === "/api/calendar/events/e1/sessions");
  assert.deepEqual({ ...attach.body, requestKey: "k" }, { requestKey: "k", expectedRevision: 3, logicalSessionIds: ["l1", "l2"], alignSessions: false });
  assert.match(attach.body.requestKey, /^[0-9a-f-]{36}$/);
  assert.equal(context.outcome.state, "linked");
  assert.equal(context.outcome.text, "Saved. 1 session for 2 athletes is in Team training · Thu 19.11.");
  assert.equal(state.builder.draft, null, "the saved draft is gone: nothing of it may be sent again");
  assert.equal(centralCalendarUncertainWrites().length, 0);
});

test("4b. RPE expected: the attach aligns (Q4); a session taken out of the event is not linked", async () => {
  const context = k3Builder({ outKeys: [`${DAY}|AM|T|main session`], expectsRpe: true });
  state.builder.draft.blocks[0].sessions.push({ id: "s2", amPm: "AM", bta: "B", name: "Mobility", time: "", nodes: [] });
  const calls = installFetchMock((call) => {
    if (eventRead(call)) return eventRead(call);
    if (call.url.startsWith("/api/calendar?")) return { status: 200, body: calendarAnswer([EVENT, planned(["l1", "l2"]), planned(["m1", "m2"], { name: "Mobility", bta: "B" })]) };
    if (call.url === "/api/calendar/events/e1/sessions") return { status: 200, body: { attached: 2 } };
    return { status: 404, body: {} };
  });
  await k3.k3SaveAndLink({ submit: async () => ({ plan: { id: "p1" } }), render: () => {} });
  const attach = calls.find((c) => c.url === "/api/calendar/events/e1/sessions");
  assert.deepEqual(attach.body.logicalSessionIds, ["m1", "m2"]);
  assert.equal(attach.body.alignSessions, true);
  assert.equal(context.outcome.state, "linked");
});

test("5. a lost attach: not linked, kept in the calendar's memory; Check result sends the same key and body and settles it", async () => {
  const context = k3Builder();
  let lose = true;
  const calls = installFetchMock((call) => {
    if (eventRead(call)) return eventRead(call);
    if (call.url.startsWith("/api/calendar?")) return { status: 200, body: calendarAnswer([EVENT, planned(["l1", "l2"])]) };
    if (call.url === "/api/calendar/events/e1/sessions") return lose ? { throwNetworkError: true } : { status: 200, body: { attached: 0, alreadyAttached: 2 } };
    return { status: 404, body: {} };
  });
  await k3.k3SaveAndLink({ submit: async () => ({ plan: { id: "p1" } }), render: () => {} });
  assert.equal(context.outcome.text, "Saved. We couldn't confirm the link. Checking never links twice.");
  assert.deepEqual(context.outcome.actions, ["checkResult"]);
  const first = calls.filter((c) => c.url === "/api/calendar/events/e1/sessions")[0];
  assert.equal(centralCalendarUncertainWrites().filter((e) => e.requestKey === first.body.requestKey).length, 1, "the calendar's memory holds it");
  lose = false;
  await k3.k3CheckResult({ render: () => {} });
  const sends = calls.filter((c) => c.url === "/api/calendar/events/e1/sessions");
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[1].body, first.body, "the same key and body");
  assert.equal(context.outcome.state, "linked");
  assert.equal(centralCalendarUncertainWrites().length, 0, "settled, forgotten");
});

test("6. more than 200 sessions: parts of 200 with their own keys; a refused part is said, the confirmed one counted; Try linking again resends only it with a new key", async () => {
  const context = k3Builder();
  const ids = Array.from({ length: 250 }, (_, i) => `l${i}`);
  let refuse = true;
  const calls = installFetchMock((call) => {
    if (eventRead(call)) return eventRead(call);
    if (call.url.startsWith("/api/calendar?")) return { status: 200, body: calendarAnswer([EVENT, planned(ids)]) };
    if (call.url === "/api/calendar/events/e1/sessions") {
      if (call.body.logicalSessionIds.length === 50 && refuse) return { status: 409, body: { error: "athlete_not_targeted" } };
      return { status: 200, body: { attached: call.body.logicalSessionIds.length } };
    }
    return { status: 404, body: {} };
  });
  await k3.k3SaveAndLink({ submit: async () => ({ plan: { id: "p1" } }), render: () => {} });
  const sends = calls.filter((c) => c.url === "/api/calendar/events/e1/sessions");
  assert.deepEqual(sends.map((c) => c.body.logicalSessionIds.length), [200, 50]);
  assert.notEqual(sends[0].body.requestKey, sends[1].body.requestKey);
  assert.equal(context.outcome.state, "partial_refused");
  assert.match(context.outcome.text, /^Saved\. 200 of 250 links are confirmed\. The rest weren't linked\. Some athletes of this training are not part of this event/);
  refuse = false;
  await k3.k3TryLinking({ render: () => {} });
  const again = calls.filter((c) => c.url === "/api/calendar/events/e1/sessions").slice(2);
  assert.deepEqual(again.map((c) => c.body.logicalSessionIds.length), [50], "only the refused part");
  assert.notEqual(again[0].body.requestKey, sends[1].body.requestKey, "a new key");
  assert.equal(context.outcome.state, "linked");
});

test("7. nothing sent for an empty plan or a session whose own time is outside the event (O14)", async () => {
  const context = k3Builder();
  state.builder.draft.blocks[0].sessions[0].nodes = [];
  const calls = installFetchMock(() => ({ status: 500, body: {} }));
  let submitted = 0;
  await k3.k3SaveAndLink({ submit: async () => { submitted += 1; return {}; }, render: () => {} });
  assert.equal(context.outcome.text, "Add an exercise or a named section first: a plan without them isn't saved.");
  state.builder.draft.blocks[0].sessions[0].nodes = [{ id: "n1", name: "Warm-up", items: [] }];
  state.builder.draft.blocks[0].sessions[0].time = "08:00";
  await k3.k3SaveAndLink({ submit: async () => { submitted += 1; return {}; }, render: () => {} });
  assert.equal(context.blocker.text, "Main session is at 08:00, outside the event (10:00–11:30). Change its time first.");
  assert.equal(submitted, 0);
  assert.equal(calls.length, 0);
});

test("7b. a new session on the event's day starts in its half; a time outside the event is refused for a session in it", () => {
  k3Builder();
  assert.equal(k3.k3DefaultAmPm(state.builder.draft.blocks[0]), "AM");
  assert.equal(k3.k3DefaultAmPm(state.builder.draft.blocks[1]), "", "another day: the Builder's default");
  assert.equal(k3.k3TimeRefusal("s1", "12:00"), "Team training is 10:00–11:30, so this session's time must be in it.");
  assert.equal(k3.k3TimeRefusal("s1", "10:30"), "");
});

test("8. Event: [▾] on a saved plan: one attach with the session's ids for every athlete of the batch; No event detaches its links", async () => {
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ draft: draftOf({ isEditDraft: true }) });
  const linkedEvent = { ...EVENT, links: { planIds: ["p1", "p2"] } };
  let linked = false;
  const calls = installFetchMock((call) => {
    if (call.url.startsWith("/api/calendar?")) return { status: 200, body: calendarAnswer(linked ? [linkedEvent] : [EVENT, planned(["l1", "l2"])]) };
    if (call.url === "/api/calendar/events/e1") {
      return { status: 200, body: { event: { id: "e1", sessionLinks: [
        { id: "k1", planId: "p1", day: DAY, amPm: "AM", bta: "T", sessionName: "Main session", state: "linked" },
        { id: "k2", planId: "p2", day: DAY, amPm: "AM", bta: "T", sessionName: "Main session", state: "linked" },
      ] } } };
    }
    if (call.url === "/api/calendar/events/e1/sessions") { linked = true; return { status: 200, body: { attached: 2 } }; }
    if (call.url === "/api/calendar/events/e1/sessions/detach") { linked = false; return { status: 200, body: { detached: 2 } }; }
    return { status: 404, body: {} };
  });
  await row.loadBuilderEvents();
  assert.equal(row.builderSessionEvent(DAY, state.builder.draft.blocks[0].sessions[0]), "");
  await row.chooseSessionEvent(DAY, "s1", "e1");
  const attach = calls.find((c) => c.url === "/api/calendar/events/e1/sessions");
  assert.deepEqual(attach.body.logicalSessionIds, ["l1", "l2"]);
  assert.equal(attach.body.expectedRevision, 3);
  assert.equal(row.builderSessionEvent(DAY, state.builder.draft.blocks[0].sessions[0]), "e1");
  assert.equal(state.builder.events.message.text, "Main session is in Team training 10:00.");
  await row.chooseSessionEvent(DAY, "s1", "");
  const detach = calls.find((c) => c.url === "/api/calendar/events/e1/sessions/detach");
  assert.deepEqual(detach.body.linkIds, ["k1", "k2"]);
  assert.equal(state.builder.events.message.text, "Main session is out of Team training 10:00.");
});

test("8b. a plan never saved: the selector asks first and sends nothing; Cancel leaves everything as it was", async () => {
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ draft: draftOf() });
  const calls = installFetchMock((call) => (call.url.startsWith("/api/calendar?") ? { status: 200, body: calendarAnswer([EVENT]) } : { status: 500, body: {} }));
  await row.loadBuilderEvents();
  const before = calls.length;
  await row.chooseSessionEvent(DAY, "s1", "e1");
  assert.equal(state.builder.events.ask.kind, "session");
  assert.equal(calls.length, before, "nothing sent");
  await row.answerSaveFirst(false, { submit: () => assert.fail("not saved"), reopen: () => assert.fail("not reopened") });
  assert.equal(state.builder.events.ask, null);
});

test("8c. a session whose own time is outside the event cannot join it: the sentence and Use the event's time, nothing sent", async () => {
  state.activeTab = "builder";
  const draft = draftOf({ isEditDraft: true });
  draft.blocks[0].sessions[0].time = "08:00";
  state.builder = emptyBuilderState({ draft });
  const calls = installFetchMock((call) => (call.url.startsWith("/api/calendar?") ? { status: 200, body: calendarAnswer([EVENT, planned(["l1"])]) } : { status: 500, body: {} }));
  await row.loadBuilderEvents();
  const before = calls.length;
  await row.chooseSessionEvent(DAY, "s1", "e1");
  assert.equal(calls.length, before);
  assert.equal(state.builder.events.message.text, "Main session is at 08:00, outside the event (10:00–11:30). Change its time first.");
  assert.equal(state.builder.events.message.useEventTime, "s1");
});

test("8d. an event the coach does not manage is never written, whatever the select sends: one session and the whole day send nothing", async () => {
  // The selects list such an event disabled (6.4), but a handler never trusts
  // the page: a value naming it - a stale page, a crafted change - is dropped.
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ draft: draftOf({ isEditDraft: true }) });
  const clubEvent = { ...EVENT, key: `event:e2:${DAY}`, eventId: "e2", title: "Club training", canManage: false };
  const calls = installFetchMock((call) => (call.url.startsWith("/api/calendar?") ? { status: 200, body: calendarAnswer([clubEvent, planned(["l1", "l2"])]) } : { status: 500, body: {} }));
  await row.loadBuilderEvents();
  const before = calls.length;
  await row.chooseSessionEvent(DAY, "s1", "e2");
  assert.equal(calls.length, before, "one session: nothing sent");
  await row.chooseWholeDay(DAY, "e2");
  assert.equal(calls.length, before, "the whole day: nothing sent");
  assert.equal(row.builderEventsBusy(), false);
  assert.equal(row.builderSessionEvent(DAY, state.builder.draft.blocks[0].sessions[0]), "");
});

test("9. Q8: a team workspace's whole roster is the team target; otherwise the athletes", () => {
  state.builder = emptyBuilderState({ draft: draftOf() });
  assert.deepEqual(row.builderEventTargets(), [{ kind: "team", id: "t1", name: "First team" }]);
  state.athletes.push({ athlete_id: "103", athlete_uuid: A[2], athlete: "Cara Example" });
  assert.deepEqual(row.builderEventTargets().map((t) => t.kind), ["athlete", "athlete"]);
});

test("10. openCentralCalendarAt sets the calendar's day and opens the event's panel, never over an open form", () => {
  openCentralCalendarAt({ date: DAY, key: EVENT.key });
  assert.equal(state.centralCalendar.anchor, DAY);
  assert.equal(state.centralCalendar.selectedDate, DAY);
  assert.deepEqual({ open: state.centralCalendar.panel.open, key: state.centralCalendar.panel.key, date: state.centralCalendar.panel.date }, { open: true, key: EVENT.key, date: DAY });
  state.centralCalendar = emptyCentralCalendarState();
  state.centralCalendar.form = { mode: "create" };
  openCentralCalendarAt({ date: DAY, key: EVENT.key });
  assert.equal(state.centralCalendar.panel.open, false);
  assert.equal(state.centralCalendar.anchor, DAY);
});

test("11. a save whose answer was lost: Try again reads the plan back - an applied edit draft is never sent again nor called 'not saved'", async () => {
  const context = k3Builder();
  state.builder.draft = draftOf({ isEditDraft: true });
  const calls = installFetchMock((call) => {
    if (eventRead(call)) return eventRead(call);
    if (call.url === "/api/builder/plans/d1") return { status: 404, body: { error: "Plan not found." } };
    if (call.url.startsWith("/api/calendar?")) return { status: 200, body: calendarAnswer([planned(["l1", "l2"])]) };
    if (call.url === "/api/calendar/events/e1/sessions") return { status: 200, body: { attached: 2 } };
    return { status: 404, body: {} };
  });
  let submits = 0;
  const submit = async () => {
    submits += 1;
    if (submits === 1) throw new TypeError("Failed to fetch");
    throw Object.assign(new Error("Plan not found."), { status: 404 });
  };
  await k3.k3SaveAndLink({ submit, render: () => {} });
  assert.equal(context.outcome.state, "save_unconfirmed");
  await k3.k3SaveAndLink({ submit, render: () => {} });
  assert.equal(submits, 1, "the save is not sent again");
  assert.ok(calls.some((c) => c.url === "/api/builder/plans/d1"), "the draft was read back");
  assert.equal(context.outcome.state, "linked");
  assert.doesNotMatch(context.outcome.text, /wasn't saved/);
});

test("11b. a lost save that is still a draft is sent again; a 4xx on that resend is still 'not confirmed', never 'not saved'", async () => {
  const context = k3Builder();
  installFetchMock((call) => (call.url === "/api/builder/plans/p1" ? { status: 200, body: { plan: { id: "p1", status: "draft" } } } : { status: 404, body: {} }));
  let submits = 0;
  const submit = async () => {
    submits += 1;
    if (submits === 1) throw new TypeError("Failed to fetch");
    throw Object.assign(new Error("Conflict"), { status: 409 });
  };
  await k3.k3SaveAndLink({ submit, render: () => {} });
  await k3.k3SaveAndLink({ submit, render: () => {} });
  assert.equal(submits, 2);
  assert.equal(context.outcome.state, "save_unconfirmed");
});

test("12. three parts of 200: each part is sent with the revision the previous attach answered (no event_changed)", async () => {
  const context = k3Builder();
  const ids = Array.from({ length: 450 }, (_, i) => `l${i}`);
  const calls = installFetchMock((call) => {
    if (eventRead(call)) return eventRead(call);
    if (call.url.startsWith("/api/calendar?")) return { status: 200, body: calendarAnswer([planned(ids)]) };
    if (call.url === "/api/calendar/events/e1/sessions") {
      if (call.body.expectedRevision !== eventRevision) return { status: 409, body: { error: "event_changed" } };
      eventRevision += 1;
      return { status: 200, body: { event: { id: "e1", revision: eventRevision }, attached: call.body.logicalSessionIds.length } };
    }
    return { status: 404, body: {} };
  });
  await k3.k3SaveAndLink({ submit: async () => ({ plan: { id: "p1" } }), render: () => {} });
  const sends = calls.filter((c) => c.url === "/api/calendar/events/e1/sessions");
  assert.deepEqual(sends.map((c) => c.body.expectedRevision), [3, 4, 5]);
  assert.equal(context.outcome.state, "linked");
});

test("13. an unnamed linked session is placed in its event (its name is empty, not missing)", async () => {
  const { k3PlacedSessions, k3SessionKey } = await import("../central-calendar-k3.js");
  const view = { id: "e1", sessionLinks: [{ id: "k1", planId: "p1", day: DAY, amPm: "AM", bta: "T", sessionName: null, state: "linked" }] };
  const { placed } = k3PlacedSessions([{ event: { eventId: "e1" }, view }], ["p1"]);
  assert.ok(placed.has(k3SessionKey(DAY, { amPm: "AM", bta: "T", name: "" })));
});

test("14. Save and continue: the plan saved but not opened again releases the row and says it was saved", async () => {
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ draft: draftOf() });
  installFetchMock((call) => (call.url.startsWith("/api/calendar?") ? { status: 200, body: calendarAnswer([EVENT]) } : { status: 500, body: {} }));
  await row.loadBuilderEvents();
  await row.chooseSessionEvent(DAY, "s1", "e1");
  await row.answerSaveFirst(true, { submit: async () => ({ plan: { id: "p1" } }), reopen: async () => { throw new TypeError("Failed to fetch"); } });
  assert.equal(state.builder.events.ask, null);
  assert.equal(row.builderEventsBusy(), false);
  assert.match(state.builder.events.message.text, /^Saved\. The plan couldn't be opened again here/);
});

test("14b. a band restored after a reload never hides the events row's write in flight, its unconfirmed result or its question; an idle row gives way", async () => {
  installFetchMock((call) => {
    if (call.url === "/api/calendar/events/e1") {
      return { status: 200, body: { event: { id: "e1", title: "Team training", eventKind: "training", status: "scheduled", canManage: true, day: DAY, startTime: "10:00", endTime: "11:30", expects: [], targets: A.slice(0, 2).map((id) => ({ kind: "athlete", id })), athleteCount: 2 } } };
    }
    return { status: 404, body: {} };
  });
  const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const busy = { write: { write: { at: "session:s1" } }, pending: { pending: { at: "session:s1", spec: {}, done: "" } }, ask: { ask: { kind: "session", day: DAY, sessionId: "s1", value: "e1" } } };
  for (const [name, expectBand] of [["idle", true], ["write", false], ["pending", false], ["ask", false]]) {
    // The memory a band leaves behind, then a reload: the same plan opened without its band.
    k3Builder();
    k3.k3ToggleSession(`${DAY}|AM|T|main session`);
    assert.equal(store.size, 1);
    state.builder = emptyBuilderState({ draft: draftOf() });
    state.builder.events = { ...row.emptyBuilderEvents(), ...(busy[name] || {}) };
    k3.k3AdoptDraft(state.builder.draft);
    await settle();
    if (expectBand) {
      assert.equal(state.builder.k3?.eventId, "e1", `${name}: the band is back`);
    } else {
      assert.equal(state.builder.k3, null, `${name}: the band waits`);
      assert.equal(store.size, 1, `${name}: the memory stays for the next time`);
    }
    k3.clearK3Memory();
  }
});

test("15. another plan opened ends the band and drops its memory", () => {
  k3Builder();
  k3.k3ToggleSession(`${DAY}|AM|T|main session`);
  assert.equal(store.size, 1);
  k3.k3AdoptDraft({ plan: { id: "other", planType: "weekly", weekStart: WEEK }, batch: { plans: [] }, blocks: [] });
  assert.equal(state.builder.k3, null);
  assert.equal(store.size, 0);
});

test("16. Create event → from the Builder: the form's band names the day and never promises a session it does not link", async () => {
  const { renderK2c3FormBandHtml } = await import("../central-calendar-k3-view.js");
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const call = app.slice(app.indexOf("async function openCalendarCreateFromBuilder"), app.indexOf("async function openCalendarCreateFromBuilder") + 1200);
  assert.doesNotMatch(call, /sessionName/, "no session is named for a link the create does not make");
  const html = renderK2c3FormBandHtml({ returnTo: { tab: "builder", day: DAY, sessionName: "" }, busy: false });
  assert.match(html, /with this event in the day&#039;s row\./);
  assert.doesNotMatch(html, /chosen for/);
});

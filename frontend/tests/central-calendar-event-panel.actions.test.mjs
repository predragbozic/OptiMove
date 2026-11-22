// The central calendar's event panel package
// (docs/ai/central-calendar-event-panel-contract.md, section 5, P1-P8): in a
// manager's event panel, each athlete's RPE and duration, the summary
// "Answered 12/15 · average RPE 6.8" and a clearer athlete click - through the
// real handlers, loaders and templates with a fake fetch and JSDOM. The fake
// keeps the server's contracts: GET /api/calendar (the card, `athletes` on the
// day read), GET /api/training-load/weekly (planned rows with
// logicalSessionId / sessionOrder, RPE-request rows with scheduleId), and the
// manager's questions read with `lastChangedAt` (v83).
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
} = await import("../central-calendar-actions.js");
const { loadCentralCalendar, resetCentralCalendarForWorkspaceChange } = await import("../central-calendar-data.js");
const view = await import("../central-calendar-view.js");
const answers = await import("../central-calendar-answers.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
const DAY = (offset) => addDaysIso(MONDAY, offset);
const EV_DAY = DAY(1);
const CLUB = "c1c1c1c1-0000-4000-8000-000000000001";
const U17 = "22222222-2222-4222-8222-222222222222";
const TEAMS = [{ teamId: U17, name: "U17", athleteCount: 5 }];
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const L1 = "11111111-0000-4000-8000-000000000001";
const L2 = "11111111-0000-4000-8000-000000000002";
const L_OTHER = "11111111-0000-4000-8000-0000000000ff";
const S1 = "51515151-0000-4000-8000-000000000001";
const id = (n) => `a0000000-0000-4000-8000-00000000000${n}`;
const ANA = { athleteId: id(1), name: "Ana Example", teamIds: [U17] };
const BEN = { athleteId: id(2), name: "Ben Example", teamIds: [U17] };
const CYRA = { athleteId: id(3), name: "Cyra Example", teamIds: [U17] };
const DORA = { athleteId: id(4), name: "Dora Example", teamIds: [U17] };
const ELI = { athleteId: id(5), name: "Eli Example", teamIds: [U17] };

function eventItem(eventId = E1, overrides = {}) {
  const athletes = overrides.athletes || [];
  return {
    key: `event:${eventId}:${EV_DAY}`, kind: "event", date: EV_DAY, eventId, eventKind: "training", eventTypeLabel: "Training",
    eventTypeId: "70000000-0000-4000-8000-000000000001", eventTypeIconKey: null, eventTypeColorKey: null,
    title: "Team training", slot: null, startTime: "10:00", endTime: "11:30", startsAt: null, location: null, place: null,
    teamIds: [U17], athleteIds: athletes.map((a) => a.athleteId), athleteCount: athletes.length, expects: ["rpe"], status: "planned",
    rpe: null, attendance: null, results: null, cancelled: false, projected: false, span: { from: EV_DAY, to: EV_DAY }, gaps: [],
    scheduleFold: { external: null, test: null }, revision: 1, canManage: true, notes: null, details: null,
    links: { eventId, planIds: [], logicalSessionIds: [L1, L2], activityIds: [], externalScheduleId: null, testScheduleId: null },
    ...overrides,
  };
}
const card = (athlete, rpe, extra = {}) => ({ ...athlete, rpe, result: null, ...extra });

// A /weekly planned row and an RPE-request row, as the route answers them.
function plannedRow(athleteId, logicalSessionId, { name = "Training", order = 1, rpe = null, minutes = null, rpeEnabled = true, ws = true, amPm = "AM", bta = "T" } = {}) {
  return {
    sessionId: `s-${logicalSessionId}-${athleteId}`, logicalSessionId, sessionOrder: order, sessionName: name, amPm, bta, sessionTime: "",
    planId: "p1", planName: "Week", athleteId, athleteName: "", rated: rpe != null,
    feedback: rpe != null ? { rpe, durationMinutes: minutes, srpe: minutes != null ? rpe * minutes : null, note: null, submittedAt: "2026-01-01T00:00:00Z" } : null,
    historical: false, rpeEnabled, trainingLoadEnabled: true, workspacePlannedRpeEnabled: ws, actionable: true, status: "tracked_rpe_on",
    ownershipUnresolved: false, canResolveOwnership: false, source: "planned", externalAssignmentId: null, scheduleId: null,
  };
}
function requestRow(athleteId, scheduleId, { rpe = null, minutes = null, closesAt = "2999-01-01T00:00:00Z", assignmentStatus = "open" } = {}) {
  return {
    sessionId: null, sessionName: "Away match", amPm: "", bta: "", sessionTime: "", planId: null, planName: null, athleteId, athleteName: "",
    rated: rpe != null, feedback: rpe != null ? { rpe, durationMinutes: minutes, srpe: null, note: null, submittedAt: "2026-01-01T00:00:00Z" } : null,
    historical: false, rpeEnabled: true, trainingLoadEnabled: true, status: "tracked_rpe_on", source: "scheduled_external",
    externalAssignmentId: `x-${athleteId}`, scheduleId, opensAt: null, closesAt, scheduleStatus: "active", assignmentStatus, actionable: false,
  };
}
function weeklyOf(rowsByDate) {
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDaysIso(MONDAY, i);
    days.push({ date, sessions: rowsByDate[date] || [] });
  }
  return { weekStart: MONDAY, weekEnd: addDaysIso(MONDAY, 6), days };
}

function rangeAnswer(url, items) {
  const params = new URL(url, "http://localhost").searchParams;
  const from = params.get("from");
  const to = params.get("to");
  const days = [];
  for (let cursor = from; cursor <= to; cursor = addDaysIso(cursor, 1)) days.push({ date: cursor, items: items.filter((item) => item.date === cursor).map((item) => ({ ...item })) });
  return { from, to, today: params.get("today"), workspace: { type: "club", scopeId: CLUB }, teams: TEAMS, days };
}

// `weekly`: the /weekly answer (an object, or a function of the call that may
// return a promise); `questions`: the questions read's list, or a status.
function server({ items, weekly = weeklyOf({}), questions = null } = {}) {
  return (call) => {
    const path = call.url.split("?")[0];
    if (path === "/api/calendar" && call.method === "GET") return { status: 200, body: rangeAnswer(call.url, items()) };
    if (path === "/api/calendar/events/types") return { status: 200, body: { types: [], fields: [], locations: [], teamDefaults: {}, questions: { enabled: questions != null } } };
    if (/^\/api\/calendar\/events\/[^/]+\/questions$/.test(path)) {
      if (questions == null) return { status: 404, body: { error: "notFound" } };
      return typeof questions === "number" ? { status: questions, body: { error: "notFound" } } : { status: 200, body: { questions } };
    }
    if (/^\/api\/calendar\/events\/[^/]+$/.test(path)) return { status: 404, body: { error: "notFound" } };
    if (path === "/api/training-load/weekly") return typeof weekly === "function" ? weekly(call) : { status: 200, body: weekly };
    return { status: 404, body: { error: "unexpected", message: call.url } };
  };
}

let rendered = "";
function render() {
  rendered = view.renderCentralCalendarHtml(state.centralCalendar, {
    today: TODAY, layout: "wide", roster: centralCalendarRosterIndex(), canCreate: centralCalendarCanCreateEvents(), eventRoster: centralCalendarEventRoster(),
    uncertainWrites: centralCalendarUncertainWrites(),
  });
}
const dom = () => new JSDOM(`<!doctype html><body>${rendered}</body>`).window.document;
const act = (dataset, extra = {}) => handleCentralCalendarAction(fakeAction(dataset), { render, ...extra });
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const weeklyReads = (calls) => calls.filter((call) => call.url.startsWith("/api/training-load/weekly"));
const summary = () => dom().querySelector(".cc-answers-summary")?.textContent.replace(/\s+/g, " ").trim() ?? null;
const rows = () => [...dom().querySelectorAll(".cc-athletes > li > .cc-athlete")];
const rowOf = (name) => rows().find((row) => row.querySelector(".cc-athlete-name")?.textContent === name) || null;
const valuesOf = (name) => rowOf(name)?.querySelector(".cc-athlete-state")?.textContent ?? "";

beforeEach(() => {
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  clearCentralCalendarUncertainWrites();
  state.deliberateNavigation = false;
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: CLUB, label: "First Club" } };
  state.activeTab = "central-calendar";
  state.athletes = [ANA, BEN, CYRA, DORA, ELI].map((a, i) => ({ athlete_uuid: a.athleteId, athlete_id: `R-${i + 1}` }));
  rendered = "";
});

async function openPanel(options, key = `event:${E1}:${EV_DAY}`) {
  // A fresh calendar each time (a second open of the open item would fold it).
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  const holder = { items: options.items };
  const calls = installFetchMock(server({ ...options, items: () => holder.items }));
  await loadCentralCalendar({ render });
  await tick();
  await act({ action: "central-calendar-open-item", key, date: EV_DAY });
  await tick();
  return { calls, holder };
}

// The ordinary world: Ana answered two linked sessions of one slot, Ben one,
// Cyra none yet; Eli was linked but is no longer a target.
function ordinary(overrides = {}) {
  const athletes = [card(ANA, "submitted"), card(BEN, "submitted"), card(CYRA, "missing"), card(ELI, "submitted", { targeted: false })];
  return {
    items: [eventItem(E1, { athletes, ...overrides })],
    weekly: weeklyOf({
      [EV_DAY]: [
        plannedRow(ANA.athleteId, L1, { name: "Training", order: 1, rpe: 7, minutes: 60 }),
        plannedRow(ANA.athleteId, L2, { name: "After", order: 2, rpe: 4, minutes: 15 }),
        plannedRow(BEN.athleteId, L1, { name: "Training", order: 1, rpe: 8, minutes: 45 }),
        plannedRow(CYRA.athleteId, L1, { name: "Training", order: 1 }),
        plannedRow(ELI.athleteId, L1, { name: "Training", order: 1, rpe: 9, minutes: 60 }),
      ],
    }),
  };
}

// --- P1: the reads ------------------------------------------------------------

test("P1. a manager's panel issues ONE weekly read for the panel's day (its Monday, the card's athletes); a reader's panel issues none and keeps today's states", async () => {
  const world = ordinary();
  const { calls } = await openPanel(world);
  const reads = weeklyReads(calls);
  assert.equal(reads.length, 1, "one read");
  const params = new URL(reads[0].url, "http://localhost").searchParams;
  assert.equal(params.get("weekStart"), weekMondayIso(EV_DAY));
  assert.deepEqual(params.get("athleteIds").split(",").sort(), [ANA, BEN, CYRA, ELI].map((a) => a.athleteId).sort());
  assert.equal(valuesOf("Ben Example"), "RPE 8 · 45 min");

  const reader = ordinary({ canManage: false, links: { eventId: E1, activityIds: [] } });
  const second = await openPanel(reader);
  assert.equal(weeklyReads(second.calls).length, 0, "a reader reads no values");
  assert.equal(summary(), null, "no summary for a reader");
  assert.equal(valuesOf("Ben Example"), "RPE entered", "the state, as today");
  assert.equal(valuesOf("Cyra Example"), "RPE missing");
  assert.equal(dom().querySelector(".cc-athlete-go"), null, "a reader's row is today's: no Weekly plan ›");
  assert.match(rowOf("Ben Example").getAttribute("aria-label"), /^Ben Example, open the weekly plan on /, "a reader's label is today's");
});

test("P1c. no read without athletes (no athleteIds would mean the whole workspace) or without anything that can carry a value", async () => {
  const empty = await openPanel({ items: [eventItem(E1, { athletes: [] })], weekly: weeklyOf({}) });
  assert.equal(weeklyReads(empty.calls).length, 0, "an event with no athletes reads nothing");
  assert.equal(summary(), null);

  const meeting = eventItem(E1, { athletes: [card(BEN, null)], expects: [], links: { eventId: E1, planIds: [], logicalSessionIds: [], activityIds: [], externalScheduleId: null, testScheduleId: null } });
  const none = await openPanel({ items: [meeting], weekly: weeklyOf({}) });
  assert.equal(weeklyReads(none.calls).length, 0, "nothing linked or folded: no read");
  assert.equal(summary(), null, "no 'answers' line");
  assert.doesNotMatch(rendered, /Loading answers|Answers could not/);

  const separate = eventItem(E1, { athletes: [card(BEN, "submitted")], scheduleFold: { external: "separate", test: null }, links: { eventId: E1, planIds: [], logicalSessionIds: [], activityIds: [], externalScheduleId: S1, testScheduleId: null } });
  const apart = await openPanel({ items: [separate], weekly: weeklyOf({}) });
  assert.equal(weeklyReads(apart.calls).length, 0, "a separate request alone: no read");
  assert.equal(summary(), "Answered 1/1", "the summary from the card's states, with no average");
});

test("P1c. each guard on its own: no readable panel without athletes, and never a path without athleteIds", () => {
  const item = eventItem(E1, { athletes: [] });
  assert.equal(answers.ccAnswersReadable(item), false, "no athletes: not readable");
  assert.deepEqual(answers.ccAnswersPaths(item), [], "no athletes: no path at all");
  assert.equal(answers.ccAnswersReadable(eventItem(E1, { athletes: [card(BEN, "missing")] })), true);
});

test("P1d. a large event reads in chunks, each with its athletes, and the answers are put together", async () => {
  const many = Array.from({ length: 320 }, (_, i) => ({ athleteId: `b0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `Athlete ${String(i).padStart(3, "0")}`, teamIds: [U17] }));
  const athletes = many.map((a) => card(a, "missing"));
  athletes[0] = card(many[0], "submitted");
  athletes[319] = card(many[319], "submitted");
  const weekly = (call) => {
    const ids = new URL(call.url, "http://localhost").searchParams.get("athleteIds").split(",");
    const rows = [];
    if (ids.includes(many[0].athleteId)) rows.push(plannedRow(many[0].athleteId, L1, { rpe: 6, minutes: 60 }));
    if (ids.includes(many[319].athleteId)) rows.push(plannedRow(many[319].athleteId, L1, { rpe: 8, minutes: 60 }));
    for (const id of ids) if (id !== many[0].athleteId && id !== many[319].athleteId) rows.push(plannedRow(id, L1));
    return { status: 200, body: weeklyOf({ [EV_DAY]: rows }) };
  };
  const { calls } = await openPanel({ items: [eventItem(E1, { athletes })], weekly });
  const reads = weeklyReads(calls);
  assert.equal(reads.length, Math.ceil(320 / answers.CC_ANSWERS_CHUNK));
  assert.ok(reads.every((r) => r.url.length < 8000), "every request line stays short");
  const asked = reads.flatMap((r) => new URL(r.url, "http://localhost").searchParams.get("athleteIds").split(","));
  assert.deepEqual([...asked].sort(), many.map((a) => a.athleteId).sort(), "every athlete once");
  assert.equal(summary(), "Answered 2/320 · average RPE 7.0");
});

test("P1b. not cached: close the panel, the answer changes, reopen - a second read, the new value shows", async () => {
  const world = ordinary();
  let rpe = 8;
  const weekly = () => ({ status: 200, body: weeklyOf({ [EV_DAY]: [plannedRow(BEN.athleteId, L1, { rpe, minutes: 45 })] }) });
  const { calls } = await openPanel({ ...world, weekly });
  assert.equal(valuesOf("Ben Example"), "RPE 8 · 45 min");
  await act({ action: "central-calendar-close-panel" });
  rpe = 5;
  await act({ action: "central-calendar-open-item", key: `event:${E1}:${EV_DAY}`, date: EV_DAY });
  await tick();
  assert.equal(weeklyReads(calls).length, 2, "read again on the new open");
  assert.equal(valuesOf("Ben Example"), "RPE 5 · 45 min");
});

// --- P2: matching ---------------------------------------------------------------

test("P2. values match by logicalSessionId + athlete and by scheduleId + day + athlete (folded); two sessions of one slot keep their own; another day's or an unlinked row is not used", async () => {
  const athletes = [card(ANA, "submitted"), card(BEN, "submitted"), card(CYRA, "submitted")];
  const items = [eventItem(E1, { athletes, scheduleFold: { external: "folded", test: null }, links: { eventId: E1, planIds: [], logicalSessionIds: [L1, L2], activityIds: [], externalScheduleId: S1, testScheduleId: null } })];
  const weekly = weeklyOf({
    [EV_DAY]: [
      plannedRow(ANA.athleteId, L2, { name: "Training two", order: 2, rpe: 5, minutes: 30 }),
      plannedRow(ANA.athleteId, L1, { name: "Training one", order: 1, rpe: 7, minutes: 60 }),
      plannedRow(BEN.athleteId, L_OTHER, { name: "Not linked", rpe: 2, minutes: 10 }),
      requestRow(BEN.athleteId, S1, { rpe: 6, minutes: 90 }),
      requestRow(CYRA.athleteId, "51515151-0000-4000-8000-0000000000ff", { rpe: 3, minutes: 20 }),
    ],
    [DAY(2)]: [requestRow(CYRA.athleteId, S1, { rpe: 9, minutes: 50 })],
  });
  await openPanel({ items, weekly });
  assert.equal(valuesOf("Ana Example"), "Training one: RPE 7 · 60 min; Training two: RPE 5 · 30 min", "slot order, each its own value");
  assert.equal(valuesOf("Ben Example"), "RPE 6 · 90 min", "the folded request's row; the unlinked session is not used");
  assert.equal(valuesOf("Cyra Example"), "RPE entered", "another day's row and another schedule are not used");
  assert.equal(summary(), "Answered 3/3 · average RPE 6.0 (from 3 answers)");
});

test("P2b. a request that stays a separate card is not the event's: its submitted row shows no value and is not averaged", async () => {
  const athletes = [card(ANA, "submitted"), card(BEN, "submitted")];
  const links = { eventId: E1, planIds: [], logicalSessionIds: [L1], activityIds: [], externalScheduleId: S1, testScheduleId: null };
  const weekly = weeklyOf({ [EV_DAY]: [plannedRow(ANA.athleteId, L1, { rpe: 4, minutes: 60 }), requestRow(BEN.athleteId, S1, { rpe: 10, minutes: 60 })] });
  await openPanel({ items: [eventItem(E1, { athletes, links, scheduleFold: { external: "separate", test: null } })], weekly });
  assert.equal(valuesOf("Ben Example"), "RPE entered");
  assert.equal(summary(), "Answered 2/2 · average RPE 4.0 (from 1 answer)");
});

// --- P4: the summary --------------------------------------------------------------

test("P4. the summary counts targeted athletes once; targeted:false is left out; missed is in the denominator; Answered 0/N has no average; nobody counted means no line", async () => {
  await openPanel(ordinary());
  // Ana (7, 4) and Ben (8) answered, Cyra missing, Eli excluded: (7+4+8)/3 = 6.33 -> 6.3.
  assert.equal(summary(), "Answered 2/3 · average RPE 6.3");

  const missed = [card(ANA, "missed"), card(BEN, "missing"), card(CYRA, "not_asked"), card(DORA, null)];
  await openPanel({ items: [eventItem(E1, { athletes: missed })], weekly: weeklyOf({}) });
  assert.equal(summary(), "Answered 0/2", "missed and missing count; not asked and no state do not; no average");

  await openPanel({ items: [eventItem(E1, { athletes: [card(ANA, null), card(BEN, null)], expects: ["rpe"] })], weekly: weeklyOf({}) });
  assert.equal(summary(), null, "never Answered 0/0");
});

test("P4. the rounding: one decimal, half up on the value x 10, always with its decimal", () => {
  const avg = (values) => answers.ccRoundAverage(values.reduce((s, v) => s + v, 0), values.length).toFixed(1);
  assert.equal(avg([6, 7, 7, 7]), "6.8", "6.75 -> 6.8");
  assert.equal(avg([7]), "7.0");
  assert.equal(avg([...Array(17).fill(7), 6, 6, 6]), "6.9", "6.85 -> 6.9");
  assert.equal(avg([6, 7, 7]), "6.7", "6.67 -> 6.7");
});

test("P4b. a rated row whose RPE is now off reads 'Not asked (RPE 6)' and is not averaged", async () => {
  const athletes = [card(ANA, "submitted"), card(BEN, "submitted")];
  const weekly = weeklyOf({
    [EV_DAY]: [
      plannedRow(ANA.athleteId, L1, { name: "Training", rpe: 8, minutes: 60 }),
      plannedRow(ANA.athleteId, L2, { name: "After", order: 2, rpe: 6, minutes: 10, rpeEnabled: false }),
      plannedRow(BEN.athleteId, L1, { name: "Training", rpe: 6, minutes: 60, ws: false }),
    ],
  });
  await openPanel({ items: [eventItem(E1, { athletes })], weekly });
  assert.equal(valuesOf("Ana Example"), "Training: RPE 8 · 60 min; After: Not asked (RPE 6)");
  assert.equal(valuesOf("Ben Example"), "Not asked (RPE 6)", "the workspace switch off: not asked either");
  assert.equal(summary(), "Answered 2/2 · average RPE 8.0 (from 1 answer)");
});

test("P4c. an athlete with one entry submitted (8) and one missing is not answered, and 8 is in the average", async () => {
  const athletes = [card(ANA, "missing"), card(BEN, "submitted")];
  const weekly = weeklyOf({
    [EV_DAY]: [
      plannedRow(ANA.athleteId, L1, { name: "Training", rpe: 8, minutes: 60 }),
      plannedRow(ANA.athleteId, L2, { name: "After", order: 2 }),
      plannedRow(BEN.athleteId, L1, { name: "Training", rpe: 5, minutes: 60 }),
    ],
  });
  await openPanel({ items: [eventItem(E1, { athletes })], weekly });
  assert.equal(valuesOf("Ana Example"), "Training: RPE 8 · 60 min; After: RPE missing");
  assert.equal(summary(), "Answered 1/2 · average RPE 6.5");
});

test("P4d. a counted, answered athlete with no value read (no longer a member) keeps 'RPE entered'; the line names the answers it averages, or has no average when none was read", async () => {
  const athletes = [card(ANA, "submitted"), card(BEN, "submitted"), card(CYRA, "missing")];
  await openPanel({ items: [eventItem(E1, { athletes })], weekly: weeklyOf({ [EV_DAY]: [plannedRow(ANA.athleteId, L1, { rpe: 7, minutes: 60 }), plannedRow(CYRA.athleteId, L1)] }) });
  assert.equal(valuesOf("Ben Example"), "RPE entered");
  assert.equal(summary(), "Answered 2/3 · average RPE 7.0 (from 1 answer)");

  await openPanel({ items: [eventItem(E1, { athletes })], weekly: weeklyOf({}) });
  assert.equal(summary(), "Answered 2/3", "no value read: no average");
});

test("P4e. the card's own status sets: an excused or cancelled request is not asked, a missed one or one whose window passed is missed", async () => {
  const links = { eventId: E1, planIds: [], logicalSessionIds: [], activityIds: [], externalScheduleId: S1, testScheduleId: null };
  const athletes = [card(ANA, "not_asked"), card(BEN, "not_asked"), card(CYRA, "missed"), card(DORA, "missed"), card(ELI, "missing")];
  const weekly = weeklyOf({
    [EV_DAY]: [
      requestRow(ANA.athleteId, S1, { assignmentStatus: "excused" }),
      requestRow(BEN.athleteId, S1, { assignmentStatus: "cancelled" }),
      requestRow(CYRA.athleteId, S1, { assignmentStatus: "missed" }),
      requestRow(DORA.athleteId, S1, { assignmentStatus: "open", closesAt: "2000-01-01T00:00:00Z" }),
      requestRow(ELI.athleteId, S1, { assignmentStatus: "open" }),
    ],
  });
  await openPanel({ items: [eventItem(E1, { athletes, links, scheduleFold: { external: "folded", test: null } })], weekly });
  assert.equal(valuesOf("Ana Example"), "Not asked", "excused: the card's word, never RPE missing");
  assert.equal(valuesOf("Ben Example"), "Not asked");
  assert.equal(valuesOf("Cyra Example"), "RPE missed");
  assert.equal(valuesOf("Dora Example"), "RPE missed");
  assert.equal(valuesOf("Eli Example"), "RPE missing");
});

test("P4f. a counted athlete the read returned nothing for (a former member, partly answered) makes the line say how many answers it averages", async () => {
  const athletes = [card(ANA, "submitted"), card(BEN, "missing")];
  await openPanel({ items: [eventItem(E1, { athletes })], weekly: weeklyOf({ [EV_DAY]: [plannedRow(ANA.athleteId, L1, { rpe: 7, minutes: 60 })] }) });
  assert.equal(summary(), "Answered 1/2 · average RPE 7.0 (from 1 answer)");
});

test("P4g. the summary is announced: role status in every state, a spoken label ('2 of 3'), and its parts read apart", async () => {
  await openPanel(ordinary());
  const line = dom().querySelector(".cc-answers-summary");
  assert.equal(line.getAttribute("role"), "status");
  assert.equal(line.getAttribute("aria-label"), "Answered 2 of 3, average RPE 6.3");
  const clone = line.cloneNode(true);
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  assert.equal(clone.textContent.replace(/\s+/g, " ").trim(), "Answered 2/3 average RPE 6.3", "a space between the parts outside the hidden dot");
});

// --- P5: a changed answer --------------------------------------------------------

test("P5. a changed answer shows its current value and 'Changed HH:MM' from the questions read; P5b with the questions read answering 404, the value and no mark, no error", async () => {
  const at = "2026-11-19T20:40:00Z";
  const local = new Date(at);
  const hhmm = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
  const questions = [{ id: "q1", kind: "rpe", status: "live", window: { kind: "after_event", date: EV_DAY, from: "17:00", to: "23:59" }, counts: { asked: 2, answered: 2, later: 0, notAnswered: 0 },
    answered: [{ athleteId: BEN.athleteId, name: BEN.name, changed: true, lastChangedAt: at }, { athleteId: ANA.athleteId, name: ANA.name, changed: false, lastChangedAt: null }], later: [], notAnswered: [] }];
  const world = { ...ordinary(), questions };
  world.weekly.days.find((d) => d.date === EV_DAY).sessions.find((r) => r.athleteId === BEN.athleteId).feedback.rpe = 3;
  await openPanel(world);
  await tick();
  assert.equal(valuesOf("Ben Example"), "RPE 3 · 45 min", "the current value");
  assert.equal(rowOf("Ben Example").querySelector(".cc-athlete-changed")?.textContent, `Changed ${hhmm}`);
  assert.equal(rowOf("Ana Example").querySelector(".cc-athlete-changed"), null, "not changed: no mark");

  await openPanel({ ...ordinary(), questions: 404 });
  await tick();
  assert.equal(valuesOf("Ben Example"), "RPE 8 · 45 min");
  assert.equal(dom().querySelector(".cc-athlete-changed"), null);
  assert.doesNotMatch(rendered, /Answers could not|questions could not/i);
});

// --- P6: late and failed reads -----------------------------------------------------

test("P6. a late weekly answer for a panel that closed or moved is dropped", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let first = true;
  const second = weeklyOf({ [EV_DAY]: [plannedRow(BEN.athleteId, L1, { rpe: 2, minutes: 30 })] });
  const weekly = async () => {
    if (first) {
      first = false;
      await gate;
      return { status: 200, body: weeklyOf({ [EV_DAY]: [plannedRow(BEN.athleteId, L1, { rpe: 9, minutes: 99 })] }) };
    }
    return { status: 200, body: second };
  };
  const athletes = [card(BEN, "submitted")];
  const items = [eventItem(E1, { athletes }), eventItem(E2, { athletes, key: `event:${E2}:${EV_DAY}` })];
  const holder = { items };
  installFetchMock(server({ items: () => holder.items, weekly }));
  await loadCentralCalendar({ render });
  await tick();
  const opening = act({ action: "central-calendar-open-item", key: `event:${E1}:${EV_DAY}`, date: EV_DAY });
  await tick();
  assert.equal(summary(), "Loading answers…");
  await act({ action: "central-calendar-open-item", key: `event:${E2}:${EV_DAY}`, date: EV_DAY });
  await tick();
  assert.equal(valuesOf("Ben Example"), "RPE 2 · 30 min", "the moved panel's own read");
  release();
  await opening;
  await tick();
  assert.equal(valuesOf("Ben Example"), "RPE 2 · 30 min", "the late answer of the earlier panel is dropped");
  assert.doesNotMatch(rendered, /RPE 9/);
});

test("P6. a failed weekly read keeps today's states and says 'Answers could not be loaded.' with Try again, never a number; Try again reads again", async () => {
  let fail = true;
  const world = ordinary();
  const weekly = () => (fail ? { status: 503, body: { error: "database_busy" } } : { status: 200, body: world.weekly });
  const { calls } = await openPanel({ ...world, weekly });
  assert.equal(summary(), "Answers could not be loaded.");
  assert.equal(valuesOf("Ben Example"), "RPE entered");
  assert.doesNotMatch(rendered, /average RPE/);
  const retry = dom().querySelector('[data-action="central-calendar-answers-retry"]');
  assert.ok(retry, "Try again");
  fail = false;
  await act({ action: "central-calendar-answers-retry" });
  await tick();
  assert.equal(weeklyReads(calls).length, 2);
  assert.equal(valuesOf("Ben Example"), "RPE 8 · 45 min");
  assert.equal(summary(), "Answered 2/3 · average RPE 6.3");
});

// --- P7: the click -------------------------------------------------------------------

test("P7. the row opens the athlete's Weekly plan on the day; 'Weekly plan ›' only on a roster row; the aria-label carries the values; excluded athletes last, marked", async () => {
  state.athletes = state.athletes.filter((a) => a.athlete_uuid !== CYRA.athleteId);
  await openPanel(ordinary());
  const names = rows().map((row) => row.querySelector(".cc-athlete-name").textContent);
  assert.deepEqual(names, ["Ana Example", "Ben Example", "Cyra Example", "Eli Example"], "the targeted by name, then the excluded");
  assert.match(rowOf("Eli Example").textContent, /No longer in this event/);
  const ben = rowOf("Ben Example");
  assert.equal(ben.tagName, "BUTTON");
  assert.equal(ben.querySelector(".cc-athlete-go")?.textContent, "Weekly plan ›");
  assert.match(ben.getAttribute("aria-label"), /^Ben Example, RPE 8, 45 minutes, open the weekly plan on /);
  const cyra = rowOf("Cyra Example");
  assert.equal(cyra.tagName, "DIV");
  assert.equal(cyra.querySelector(".cc-athlete-go"), null, "no Weekly plan › outside the roster");
  assert.match(cyra.textContent, /Not in this workspace's roster/);
  const opened = [];
  await act({ action: ben.dataset.action, athleteId: ben.dataset.athleteId, date: ben.dataset.date }, { openWeeklyPlanForAthleteOnDate: async (...args) => opened.push(args) });
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].slice(0, 2), ["R-2", EV_DAY]);
  assert.equal(opened[0][2].flow.currentKey, ben.dataset.athleteId, "K6-2: the plan opens with the athlete switcher's flow");
});

// --- P8: nothing of it outside a manager's event -----------------------------------

test("P8. no weekly read and no values outside a manager's event panel: a reader, a planned item", async () => {
  const planned = {
    key: "planned:p1", kind: "planned", date: EV_DAY, title: "Weekly plan", teamIds: [U17], athleteIds: [BEN.athleteId], athleteCount: 1,
    athletes: [card(BEN, "submitted")], expects: ["rpe"], status: "done", rpe: { asked: 1, submitted: 1 }, links: { planIds: ["p1"] },
  };
  const { calls } = await openPanel({ items: [planned], weekly: ordinary().weekly }, "planned:p1");
  assert.equal(weeklyReads(calls).length, 0);
  assert.equal(summary(), null);
  assert.equal(valuesOf("Ben Example"), "RPE entered");
  assert.equal(dom().querySelector(".cc-athlete-go"), null, "no Weekly plan › outside a manager's event");
});

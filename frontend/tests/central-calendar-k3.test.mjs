// K3 / K2c-3 pure parts (frontend/central-calendar-k3.js): the plan cases over
// GET /api/builder/weekly-plans (#650), the half-of-day and time-window checks
// (O14, O15, Q12, Q14), the session <-> event matching from the manager view's
// links, and the Save-and-link outcome model (parts of 200, own keys, never
// "linked" without a confirmed answer). Contract: docs/ai/central-calendar-k3-plan.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  K3_ATTACH_MAX, K3_CASE_A_SENTENCE, k3EventHalf, k3EventWindow, k3HalfFits, k3InOtherEvent, k3LinkRun, k3LogicalIdsFor,
  k3OutsideMark, k3PartRetriesOnStale, k3PlacedSessions, k3PlanCase, k3PlanCaseSheet, k3RetryRun, k3SaveAndLinkOutcome,
  k3SelectorEvents, k3SessionFit, k3SessionKey, k3SessionTimeText, k3SettlePart, k3TimeFits,
} from "../central-calendar-k3.js";

const DAY = "2026-10-12";
const editable = (planId, { batchId = null, status = "active", openDraftId = null } = {}) => ({ planId, status, batchId, mine: true, editable: true, openDraftId });
const names = { a1: "Ana K.", a2: "Ben D.", a3: "Cara M.", a4: "Dan P.", a5: "Eva S." };
const nameOf = (id) => names[id] || "";

// ---------------------------------------------------------------------------
// 1. Plan cases
// ---------------------------------------------------------------------------
test("1a. (b) nobody has a plan: a new batch for the plannable athletes; outside ones are counted, never planned", () => {
  const c = k3PlanCase({ athletes: [
    { athleteId: "a1", plannable: true, plan: null }, { athleteId: "a2", plannable: true, plan: null }, { athleteId: "x", plannable: false },
  ] }, { nameOf });
  assert.deepEqual(c, { kind: "new", outside: 1, blocked: 0, athleteIds: ["a1", "a2"] });
  const sheet = k3PlanCaseSheet(c);
  assert.equal(sheet.text, "1 athlete of this event isn't in your workspace; plan their training in their own workspace.");
  assert.equal(k3PlanCaseSheet(k3PlanCase({ athletes: [{ athleteId: "a1", plannable: true, plan: null }] })), null, "no question when every athlete can be planned");
});

test("1b. (a) one shared published batch: open it (the coach's open edit first), with the one-athlete-at-a-time sentence; (a') a shared draft opens without a question", () => {
  const shared = k3PlanCase({ athletes: [
    { athleteId: "a1", plannable: true, plan: editable("p1", { batchId: "b", openDraftId: "d1" }) },
    { athleteId: "a2", plannable: true, plan: editable("p2", { batchId: "b" }) },
  ] }, { nameOf });
  assert.equal(shared.kind, "shared");
  assert.equal(shared.openPlanId, "d1");
  assert.equal(k3PlanCaseSheet(shared).text, `2 athletes already have this week's plan. ${K3_CASE_A_SENTENCE}`);
  assert.equal(K3_CASE_A_SENTENCE, "Changes go to the athlete on screen only.");
  const draft = k3PlanCase({ athletes: [
    { athleteId: "a1", plannable: true, plan: editable("p1", { batchId: "b", status: "draft" }) },
    { athleteId: "a2", plannable: true, plan: editable("p2", { batchId: "b", status: "draft" }) },
  ] });
  assert.equal(draft.kind, "openDraft");
  assert.equal(draft.openPlanId, "p1");
  assert.equal(k3PlanCaseSheet(draft), null);
  // One athlete with one plan and no batch is one shared plan too.
  assert.equal(k3PlanCase({ athletes: [{ athleteId: "a1", plannable: true, plan: editable("p1") }] }).kind, "shared");
});

test("1c. (c) mixed: two batches, some without a plan, a plan the coach can't open; names shortened, never an outside or blocked athlete's", () => {
  const c = k3PlanCase({ athletes: [
    { athleteId: "a1", plannable: true, plan: editable("p1", { batchId: "b1" }) },
    { athleteId: "a2", plannable: true, plan: editable("p2", { batchId: "b2" }) },
    { athleteId: "a3", plannable: true, plan: editable("p3", { batchId: "b2" }) },
    { athleteId: "a4", plannable: true, plan: editable("p4", { batchId: "b2" }) },
    { athleteId: "a5", plannable: true, plan: null },
    { athleteId: "a6", plannable: true, plan: { editable: false } },
    { athleteId: "x", plannable: false },
  ] }, { nameOf });
  assert.equal(c.kind, "mixed");
  assert.deepEqual(c.athleteIds, ["a5"]);
  assert.equal(c.blocked, 1);
  const sheet = k3PlanCaseSheet(c);
  assert.equal(sheet.text, "1 athlete has no plan for this week. 4 already have one: Ana K., Ben D., Cara M. (and 1 more). 1 athlete has a plan you can't open.");
  assert.deepEqual(sheet.buttons, ["planForRest", "openExisting", "cancel"]);
  assert.equal(sheet.planForCount, 1);
  assert.ok(!sheet.text.includes("Eva"), "an athlete without a plan is counted, not named");
  // Everyone already has one plan, but of two batches: mixed, no "Plan for".
  const two = k3PlanCase({ athletes: [
    { athleteId: "a1", plannable: true, plan: editable("p1", { batchId: "b1" }) },
    { athleteId: "a2", plannable: true, plan: editable("p2", { batchId: "b2" }) },
  ] }, { nameOf });
  assert.deepEqual(k3PlanCaseSheet(two).buttons, ["openExisting", "cancel"]);
});

test("1d. nobody plannable, and only blocked plans", () => {
  const none = k3PlanCase({ athletes: [{ athleteId: "x", plannable: false }] });
  assert.equal(none.kind, "nobody");
  assert.equal(k3PlanCaseSheet(none).text, "None of this event's athletes can be planned from this workspace.");
  const blocked = k3PlanCase({ athletes: [{ athleteId: "a1", plannable: true, plan: { editable: false } }] });
  assert.equal(blocked.kind, "mixed");
  assert.deepEqual(k3PlanCaseSheet(blocked).buttons, ["cancel"]);
  assert.equal(k3PlanCase(null).kind, "nobody");
});

// ---------------------------------------------------------------------------
// 2. Half of the day (O15, Q14) and the time window (O14, Q12)
// ---------------------------------------------------------------------------
const ev = (startTime, endTime, extra = {}) => ({ day: DAY, span: { from: DAY, to: extra.to || DAY }, startTime, endTime, canManage: true, ...extra });

test("2a. the half: before 12:00 AM, from 12:00 PM, across 12:00 both, no time no limit; a session without AM/PM fits any", () => {
  assert.equal(k3EventHalf(ev("10:00", "11:30"), DAY), "AM");
  assert.equal(k3EventHalf(ev("10:00", "12:00"), DAY), "AM", "ending exactly at 12:00 stays in the morning");
  assert.equal(k3EventHalf(ev("11:00", "12:30"), DAY), "both");
  assert.equal(k3EventHalf(ev("12:00", null), DAY), "PM");
  assert.equal(k3EventHalf(ev("17:30", "19:00"), DAY), "PM");
  assert.equal(k3EventHalf(ev(null, null), DAY), null);
  assert.equal(k3HalfFits("PM", "AM"), false);
  assert.equal(k3HalfFits("AM", "AM"), true);
  assert.equal(k3HalfFits("", "AM"), true);
  assert.equal(k3HalfFits("PM", "both"), true);
  assert.equal(k3HalfFits("PM", null), true);
});

test("2b. Q14: a multi-day event is judged on its first day by its start, the other days both", () => {
  const camp = ev("14:00", "12:00", { to: "2026-10-14" });
  assert.equal(k3EventHalf(camp, DAY), "PM");
  assert.equal(k3EventHalf(camp, "2026-10-13"), "both");
  assert.equal(k3EventHalf(camp, "2026-10-14"), "both");
  assert.equal(k3EventHalf(ev("09:00", "16:00", { to: "2026-10-14" }), DAY), "both");
});

test("2c. the window (O14): inside start-end inclusive; no end = not before the start (Q12); multi-day first/last day; no start = no window", () => {
  const w = k3EventWindow(ev("10:00", "11:30"), DAY);
  assert.deepEqual(w, { from: "10:00", to: "11:30" });
  assert.equal(k3TimeFits("10:00", w), true);
  assert.equal(k3TimeFits("11:30", w), true);
  assert.equal(k3TimeFits("09:59", w), false);
  assert.equal(k3TimeFits("11:31", w), false);
  assert.equal(k3TimeFits("", w), true, "no own time follows the event");
  const open = k3EventWindow(ev("10:00", null), DAY);
  assert.deepEqual(open, { from: "10:00", to: null });
  assert.equal(k3TimeFits("16:00", open), true);
  assert.equal(k3TimeFits("09:00", open), false);
  const camp = ev("09:00", "16:00", { to: "2026-10-14" });
  assert.deepEqual(k3EventWindow(camp, DAY), { from: "09:00", to: null });
  assert.equal(k3EventWindow(camp, "2026-10-13"), null);
  assert.deepEqual(k3EventWindow(camp, "2026-10-14"), { from: null, to: "16:00" });
  assert.equal(k3EventWindow(ev(null, null), DAY), null);
});

test("2d. k3SessionFit: the day, the half, the time, each with its one sentence; the outside mark offers one action", () => {
  const training = ev("10:00", "11:30");
  assert.deepEqual(k3SessionFit({ name: "Main session", amPm: "AM", time: "10:30" }, training, DAY), { fits: true, reason: "", text: "" });
  const early = k3SessionFit({ name: "Main session", amPm: "AM", time: "08:00" }, training, DAY);
  assert.equal(early.reason, "time");
  assert.equal(early.text, "Main session is at 08:00, outside the event (10:00–11:30). Change its time first.");
  const pm = k3SessionFit({ name: "Recovery", amPm: "PM", time: "" }, training, DAY);
  assert.equal(pm.reason, "half");
  assert.equal(pm.text, "Recovery (PM) stays out: the event is in the morning.");
  assert.equal(k3SessionFit({ name: "Main", amPm: "AM" }, training, "2026-10-13").reason, "day");
  assert.deepEqual(k3OutsideMark(early, training, DAY), { text: "Outside the event's time (10:00–11:30)", action: "useEventTime" });
  assert.deepEqual(k3OutsideMark(pm, training, DAY), { text: "Outside the event's half of the day", action: "moveToAm" });
  assert.equal(k3OutsideMark({ fits: true }, training, DAY), null);
  // A session without a name is named by its slot.
  assert.match(k3SessionFit({ bta: "A", amPm: "PM" }, training, DAY).text, /^After training \(PM\)/);
});

test("2e. the Event list: that day's events of the session's half, a non-managed one locked, a cancelled one left out; the time shown", () => {
  const morning = ev("10:00", "11:30", { eventId: "m" });
  const club = ev("09:00", null, { eventId: "c", canManage: false });
  const evening = ev("17:00", "18:00", { eventId: "e" });
  const gone = ev("10:00", "11:00", { eventId: "g", cancelled: true });
  const other = { ...ev("10:00", "11:00", { eventId: "o" }), day: "2026-10-13", span: { from: "2026-10-13", to: "2026-10-13" } };
  const list = k3SelectorEvents([morning, club, evening, gone, other], { amPm: "AM" }, DAY);
  assert.deepEqual(list.map((x) => [x.event.eventId, x.locked]), [["m", false], ["c", true]]);
  assert.deepEqual(k3SelectorEvents([morning, evening], { amPm: "" }, DAY).map((x) => x.event.eventId), ["m", "e"]);
  assert.equal(k3SessionTimeText({ time: "" }, morning), "10:00 · from the event");
  assert.equal(k3SessionTimeText({ time: "10:30" }, morning), "10:30");
  assert.equal(k3SessionTimeText({ time: "" }, ev(null, null)), "");
});

// ---------------------------------------------------------------------------
// 3. Session <-> event
// ---------------------------------------------------------------------------
test("3a. the manager view's links place each Builder session by day, AM/PM, B/T/A and name over the batch's plans; orphaned and other plans' links are ignored; two events for one session is a conflict, never a guess", () => {
  const views = [
    { event: { eventId: "E1" }, view: { sessionLinks: [
      { id: "l1", planId: "p1", day: DAY, amPm: "AM", bta: "T", sessionName: "Main Session ", state: "linked" },
      { id: "l2", planId: "p2", day: DAY, amPm: "AM", bta: "T", sessionName: "main session", state: "renamed" },
      { id: "l3", planId: "pX", day: DAY, amPm: "AM", bta: "B", sessionName: "Warm-up", state: "linked" },
      { id: "l4", planId: "p1", day: DAY, amPm: null, bta: null, sessionName: null, state: "orphaned" },
      { id: "l5", planId: "p1", day: DAY, amPm: "PM", bta: "A", sessionName: "Recovery", state: "linked" },
    ] } },
    { event: { eventId: "E2" }, view: { sessionLinks: [
      { id: "l6", planId: "p2", day: DAY, amPm: "PM", bta: "A", sessionName: "Recovery", state: "linked" },
    ] } },
  ];
  const { placed, conflicts } = k3PlacedSessions(views, ["p1", "p2"]);
  const main = k3SessionKey(DAY, { amPm: "AM", bta: "T", name: "main session" });
  assert.deepEqual(placed.get(main), { eventId: "E1", linkIds: ["l1", "l2"] });
  assert.equal(placed.has(k3SessionKey(DAY, { amPm: "AM", bta: "B", name: "Warm-up" })), false);
  const recovery = k3SessionKey(DAY, { amPm: "PM", bta: "A", name: "Recovery" });
  assert.equal(placed.has(recovery), false);
  assert.ok(conflicts.has(recovery));
});

test("3b. a live session that is neither a planned card nor in a managed event's links is in an event the coach doesn't manage", () => {
  const planned = [
    { kind: "planned", date: DAY, title: "Main session", slot: { amPm: "AM", bta: "T" }, athletes: [{ planId: "p1", logicalSessionId: "L1" }, { planId: "p2", logicalSessionId: "L2" }] },
    { kind: "planned", date: DAY, title: "Other team", slot: { amPm: "AM", bta: "T" }, athletes: [{ planId: "pZ", logicalSessionId: "LZ" }] },
  ];
  const placed = new Map([[k3SessionKey(DAY, { amPm: "PM", bta: "A", name: "Recovery" }), { eventId: "E", linkIds: [] }]]);
  const sessions = [
    { day: DAY, amPm: "AM", bta: "T", name: "Main session" },
    { day: DAY, amPm: "PM", bta: "A", name: "Recovery" },
    { day: DAY, amPm: "AM", bta: "B", name: "Video" },
  ];
  assert.deepEqual([...k3InOtherEvent(sessions, planned, placed, ["p1", "p2"])], [k3SessionKey(DAY, sessions[2])]);
  const { ids, missing } = k3LogicalIdsFor(planned, [k3SessionKey(DAY, sessions[0]), k3SessionKey(DAY, sessions[2])], ["p1", "p2"]);
  assert.deepEqual(ids, ["L1", "L2"]);
  assert.deepEqual(missing, [k3SessionKey(DAY, sessions[2])]);
});

// ---------------------------------------------------------------------------
// 4. Save and link
// ---------------------------------------------------------------------------
let n = 0;
const key = () => `key-${++n}`;
const ids = (count, prefix = "s") => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

test("4a. parts of at most 200 ids, deduped, each with its own key", () => {
  const run = k3LinkRun([...ids(450), "s0", "s1"], key);
  assert.equal(K3_ATTACH_MAX, 200);
  assert.deepEqual(run.parts.map((p) => p.ids.length), [200, 200, 50]);
  assert.equal(new Set(run.parts.map((p) => p.requestKey)).size, 3);
  assert.ok(run.parts.every((p) => p.state === "pending"));
  assert.deepEqual(k3LinkRun([], key).parts, []);
});

test("4b. never 'linked' without a confirmed answer: pending, unknown and refused parts each keep the outcome off 'linked'", () => {
  const base = { save: "saved", sessionCount: 2, athleteCount: 18, eventTitle: "Team training · Mon 12.10" };
  let run = k3LinkRun(ids(3), key);
  assert.equal(k3SaveAndLinkOutcome({ ...base, run }).state, "linking");
  run = { parts: [k3SettlePart(run.parts[0], { data: { attached: 3, alreadyAttached: 0 } })] };
  const done = k3SaveAndLinkOutcome({ ...base, run });
  assert.equal(done.state, "linked");
  assert.equal(done.text, "Saved. 2 sessions for 18 athletes are in Team training · Mon 12.10.");
  assert.deepEqual(done.actions, ["backToCalendar", "keepEditing"]);
  const lost = { parts: [k3SettlePart(k3LinkRun(ids(3), key).parts[0], { info: { status: 0, code: "no_answer" } })] };
  const unconfirmed = k3SaveAndLinkOutcome({ ...base, run: lost });
  assert.equal(unconfirmed.state, "unconfirmed");
  assert.equal(unconfirmed.text, "Saved. We couldn't confirm the link. Checking never links twice.");
  assert.deepEqual(unconfirmed.actions, ["checkResult"]);
});

test("4c. a partial success is said, never hidden: 200 of 260 confirmed, the rest unknown or refused", () => {
  const run = k3LinkRun(ids(260), key);
  const first = k3SettlePart(run.parts[0], { data: { attached: 200, alreadyAttached: 0 } });
  const unknown = k3SaveAndLinkOutcome({ save: "saved", run: { parts: [first, k3SettlePart(run.parts[1], { info: { status: 503, code: "outcome_unknown" } })] } });
  assert.equal(unknown.state, "partial_unknown");
  assert.equal(unknown.text, "Saved. 200 of 260 links are confirmed. We couldn't confirm the rest. Checking never links twice.");
  const refused = k3SaveAndLinkOutcome({ save: "saved", run: { parts: [first, k3SettlePart(run.parts[1], { info: { status: 409, code: "athlete_not_targeted" } })] } });
  assert.equal(refused.state, "partial_refused");
  assert.match(refused.text, /^Saved\. 200 of 260 links are confirmed\. The rest weren't linked\. Some athletes of this training are not part of this event/);
  assert.deepEqual(refused.actions, ["tryLinking", "backToCalendar"]);
});

test("4d. Check result keeps the key; only a settling answer changes an unknown part; a refusal retried on 'Try linking again' gets a new key; event_changed is retried once", () => {
  const [part] = k3LinkRun(ids(2), key).parts;
  const lost = k3SettlePart(part, { info: { status: 0, code: "no_answer" } });
  assert.equal(lost.state, "unknown");
  // A busy server on Check result is not an answer about the first send.
  const busy = k3SettlePart(lost, { info: { status: 409, code: "try_again" }, check: true });
  assert.equal(busy.state, "unknown");
  assert.equal(busy.requestKey, part.requestKey);
  const settled = k3SettlePart(lost, { info: { status: 409, code: "athlete_not_targeted" }, check: true });
  assert.equal(settled.state, "refused");
  const replay = k3SettlePart(lost, { data: { attached: 0, alreadyAttached: 2 }, check: true });
  assert.equal(replay.state, "linked");
  const retried = k3RetryRun({ parts: [settled, lost] }, key);
  assert.notEqual(retried.parts[0].requestKey, part.requestKey);
  assert.equal(retried.parts[0].state, "pending");
  assert.equal(retried.parts[1].requestKey, part.requestKey, "an unknown part is only ever checked with its own key");
  assert.equal(k3PartRetriesOnStale(k3SettlePart(part, { info: { status: 409, code: "event_changed" } })), true);
  assert.equal(k3PartRetriesOnStale(settled), false);
  // A 5xx with internal_error is lost too (the server may have written it).
  assert.equal(k3SettlePart(part, { info: { status: 500, code: "internal_error" } }).state, "unknown");
});

test("4e. the save's own outcomes: not saved (nothing linked), save not confirmed, nothing to link, not found on the calendar", () => {
  assert.deepEqual(k3SaveAndLinkOutcome({ save: "not_saved" }).text, "The plan wasn't saved, so nothing was linked to the event.");
  assert.equal(k3SaveAndLinkOutcome({ save: "unconfirmed" }).state, "save_unconfirmed");
  assert.equal(k3SaveAndLinkOutcome({ save: "nothing_to_link" }).text, "Saved. No session was put in the event.");
  assert.equal(k3SaveAndLinkOutcome({ save: "saved", notFound: true }).text, "Saved, but the training isn't on the calendar yet, so it wasn't linked.");
  assert.equal(k3SaveAndLinkOutcome({ save: "saved", run: { parts: [] } }).state, "saved_nothing");
});

// K6-2 (docs/ai/central-calendar-k6-contract.md 3, 6.1): moving to another athlete keeps the week, the day and the
// open path; the slot by its key, below it by type and name (S6); a missing or ambiguous node stops at the parent.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.document = new JSDOM("<body></body>").window.document;
globalThis.window = { confirm: () => true };
const { state } = await import("../state.js");
const K = await import("../weekly-k6.js");
const { switchWeeklyAthlete, activeWeeklyFlow, renderWeeklyK6Html } = await import("../weekly-k6-actions.js");
const { createNode, nextNodes } = await import("../program-structure.js");

const DAY = "2026-10-12";
const WEEK = "2026-10-12";
const item = (o) => ({ amPm: "", bta: "T", domain: "", category: "", section: "", ...o });
const mk = (items) => items.map((it, i) => ({ domain_node_id: it.domain ? `d-${it.domain}` : "", section_node_id: it.section ? `s-${it.section}-${i}` : "", ...it }));
const planOf = (items) => ({ weeks: [{ weekStart: WEEK, weekEnd: "2026-10-18", planId: "p", days: [{ date: DAY, slots: { PM: { T: items.filter((i) => i.amPm === "PM") }, AM: { T: [] } } }] }] });
const tap = (items, labels) => {
  // What a coach does: a tap on the domain, then deeper.
  const slot = { amPm: items[0].amPm, bta: items[0].bta };
  let nodes = K.slotPathFor(items, slot);
  const path = [];
  let siblings = nextNodes(nodes.at(-1), createNode);
  for (const label of labels) {
    const node = siblings.find((n) => K.normalizedNodeName(n.label) === K.normalizedNodeName(label));
    path.push(node);
    siblings = nextNodes(node, createNode);
  }
  return path;
};

const ANA = mk([item({ amPm: "PM", domain: "Strength", section: "Power" }), item({ amPm: "PM", domain: "Strength", section: "Speed" }), item({ amPm: "PM", domain: "Gym", section: "Core" })]);

function place(path, items = ANA) {
  return K.captureWeeklyPlace({ weekStart: WEEK, day: DAY, navStack: path, dayItems: items });
}

test("the name rule: type equal, trimmed, inner spaces collapsed, lower-cased", () => {
  assert.equal(K.sameNodeName({ type: "section", label: " Power " }, { type: "section", label: "power" }), true);
  assert.equal(K.sameNodeName({ type: "section", label: "Po  wer" }, { type: "section", label: "po wer" }), true);
  assert.equal(K.sameNodeName({ type: "section", label: "Power" }, { type: "domain", label: "Power" }), false);
  assert.equal(K.sameNodeName({ type: "section", label: "Éa" }, { type: "section", label: "ea" }), false, "accents kept");
});

test("A in Strength > Power: B's Strength > Power is reached, a differing case and spacing still matched", () => {
  const ben = mk([item({ amPm: "PM", domain: "Strength", section: " power " }), item({ amPm: "PM", domain: "Gym", section: "Core" })]);
  const p = place(tap(ANA, ["Strength", "Power"]));
  const m = K.matchWeeklyPlace(p, ben, { aName: "Ana", bName: "Ben" });
  assert.deepEqual(m.path.map((n) => n.label.trim()), ["Strength", "power"]);
  assert.equal(m.line, "");
  assert.match(m.kept, /Monday 12\.10 · .*Strength/);
});

test("a missing section stops at the domain; never a different node; the line names the domain, not 'this day'", () => {
  const ben = mk([item({ amPm: "PM", domain: "Strength", section: "Speed" }), item({ amPm: "PM", domain: "Gym", section: "Power" })]);
  const m = K.matchWeeklyPlace(place(tap(ANA, ["Strength", "Power"])), ben, { aName: "Ana", bName: "Ben" });
  assert.deepEqual(m.path.map((n) => n.label), ["Strength"]);
  assert.equal(m.path.some((n) => n.label === "Speed"), false);
  assert.equal(m.line, "Ben has no ‘Power’ section in Strength.");
  assert.equal(/this day|on this day/.test(m.line), false);
});

test("two same-named sections in B stop at the parent; two in A's own plan stop and name A", () => {
  const ben = mk([item({ amPm: "PM", domain: "Strength", section: "Power" }), { ...item({ amPm: "PM", domain: "Strength", section: "Power" }), domain_node_id: "d-Strength", section_node_id: "s-other" }]);
  const m = K.matchWeeklyPlace(place(tap(ANA, ["Strength", "Power"])), ben, { aName: "Ana", bName: "Ben" });
  assert.deepEqual(m.path.map((n) => n.label), ["Strength"]);
  assert.equal(m.line, "Ben has two ‘Power’ sections in Strength. Choose one below.");
  const anaTwo = [...ANA, { ...item({ amPm: "PM", domain: "Strength", section: "power" }), domain_node_id: "d-Strength", section_node_id: "s-dup" }];
  const p = place(tap(anaTwo, ["Strength", "Power"]), anaTwo);
  assert.equal(p.path[1].ambiguousInA, true);
  const m2 = K.matchWeeklyPlace(p, ANA, { aName: "Ana", bName: "Ben" });
  assert.deepEqual(m2.path.map((n) => n.label), ["Strength"]);
  assert.match(m2.line, /^Ana has two ‘Power’ sections here, so Ben's plan opens at Strength\.$/);
  assert.equal(/You have/.test(m2.line), false);
});

test("a slot B does not have: the day stays, the line says which slot", () => {
  const benAm = mk([item({ amPm: "AM", domain: "Strength", section: "Power" })]);
  const m = K.matchWeeklyPlace(place(tap(ANA, ["Strength"])), benAm, { aName: "Ana", bName: "Ben" });
  assert.deepEqual(m.path, []);
  assert.equal(m.line, "Ben has no Training (PM) on Monday 12.10.");
});

test("the slot is matched by its key, never by a label: sessions named differently still match", () => {
  const ben = mk([{ ...item({ amPm: "PM", domain: "Strength", section: "Power" }), sessionName: "Totally different name", sessionTime: "19:00" }]);
  const withName = ANA.map((it) => ({ ...it, sessionName: "Main session" }));
  const m = K.matchWeeklyPlace(place(tap(withName, ["Strength"]), withName), ben, { aName: "Ana", bName: "Ben" });
  assert.deepEqual(m.path.map((n) => n.label), ["Strength"]);
});

test("the session levels (an event's slot path) are matched by slot key; sessions named differently and a differing label still match", () => {
  const named = (name, time) => mk([{ ...item({ amPm: "PM", domain: "Strength", section: "Power" }), sessionName: name, sessionTime: time }]);
  const aItems = named("Main session", "18:00");
  const bItems = named("Their own name", "19:30");
  const aPath = K.slotPathFor(aItems, { amPm: "PM", bta: "T" });
  assert.deepEqual(aPath.map((n) => n.type), ["amPm", "bta"]);
  const p = place(aPath, aItems);
  const m = K.matchWeeklyPlace(p, bItems, { aName: "Ana", bName: "Ben" });
  assert.deepEqual(m.path.map((n) => n.type), ["amPm", "bta"]);
  assert.notEqual(m.path[1].label, aPath[1].label, "the labels differ; the slot key is what matched");
  assert.equal(m.line, "");
});

test("a node named like markup is text in the header's line", () => {
  const flow = { keys: ["a", "b"], currentKey: "a", line: "Ben has no ‘<img src=x onerror=alert(1)>’ section in Strength.", kept: "", eventKey: "", notInKeys: [] };
  const html = K.renderWeeklySwitcherHtml({ flow, items: [{ key: "a", name: "Ana" }, { key: "b", name: "Ben" }], currentKey: "a" });
  const d = new JSDOM(`<body>${html}</body>`).window.document;
  assert.equal(d.querySelector("img"), null);
  assert.match(d.querySelector(".weekly-k6-line").textContent, /<img src=x/);
});

// --- the switch itself: no history entry, week and day kept ------------------------------------------------

const roster = [{ athlete_uuid: "ua", athlete_id: "RA", athlete: "Ana" }, { athlete_uuid: "ub", athlete_id: "RB", athlete: "Ben" }, { athlete_uuid: "uc", athlete_id: "RC", athlete: "Cara" }];
const plans = {
  RA: planOf(ANA),
  RB: planOf(mk([item({ amPm: "PM", domain: "Strength", section: "Power" })])),
  RC: { weeks: [] },
};

beforeEach(() => {
  state.athletes = roster.map((r) => ({ ...r }));
  state.activeTab = "weekly";
  state.selectedAthleteId = "RA";
  state.viewedWeekStart = WEEK;
  state.selectedWeekDay = DAY;
  state.lastWeeklyData = plans.RA;
  state.appHistoryDepth = 0;
  state.centralCalendar.weeklyFlow = { keys: ["ua", "ub", "uc"], currentKey: "ua", eventKey: "", notInKeys: [], line: "", kept: "", busy: false };
});

const deps = () => ({ loadWeekly: async () => { state.lastWeeklyData = plans[state.selectedAthleteId]; state.navStack = []; }, renderCurrent() {} });

test("› keeps the week, the day and the open path, and pushes no history entry", async () => {
  state.navStack = tap(ANA, ["Strength", "Power"]);
  assert.equal(await switchWeeklyAthlete("ub", deps()), true);
  assert.equal(state.selectedAthleteId, "RB");
  assert.equal(state.viewedWeekStart, WEEK);
  assert.equal(state.selectedWeekDay, DAY);
  assert.deepEqual(state.navStack.map((n) => n.label), ["Strength", "Power"]);
  assert.equal(state.appHistoryDepth, 0, "switching adds no Back");
  assert.equal(activeWeeklyFlow().currentKey, "ub");
});

test("an athlete with no plan this week: no skip, the blank state", async () => {
  state.navStack = [];
  await switchWeeklyAthlete("uc", deps());
  assert.equal(state.selectedAthleteId, "RC");
  state.activeTab = "weekly";
  const html = renderWeeklyK6Html({ noPlan: true });
  assert.match(html, /No plan this week/);
  assert.match(html, /weekly-create-plan/);
  assert.match(html, /Plan it in the Builder/);
});

test("a click on another athlete in the rail ends the flow; a busy flow ignores a second switch", async () => {
  state.selectedAthleteId = "RB";
  assert.equal(activeWeeklyFlow(), null);
  state.selectedAthleteId = "RA";
  state.centralCalendar.weeklyFlow = { keys: ["ua", "ub"], currentKey: "ua", eventKey: "", notInKeys: [], busy: true };
  assert.equal(await switchWeeklyAthlete("ub", deps()), false);
});

// --- the code review's HIGH and MEDIUMs --------------------------------------------------------------------

test("a failed load of the next athlete never shows the previous plan under the new name", async () => {
  state.navStack = tap(ANA, ["Strength", "Power"]);
  const keep = state.navStack;
  const failing = { loadWeekly: async () => { /* loadCachedView's applyError: no throw, lastWeeklyData untouched */ }, renderCurrent() {} };
  assert.equal(await switchWeeklyAthlete("ub", failing), false);
  const flow = state.centralCalendar.weeklyFlow;
  assert.equal(flow.currentKey, "ua", "the strip still names the athlete whose plan is shown");
  assert.equal(state.selectedAthleteId, "RA");
  assert.equal(state.lastWeeklyData, plans.RA);
  assert.equal(state.navStack, keep, "the open path is where it was");
  assert.equal(flow.line, "Could not open Ben's plan. Try again.");
  assert.equal(flow.busy, false);
});

test("Back to calendar during a load: the answer is not drawn over the calendar, and the flow is gone", async () => {
  const { weeklyBackToCalendar } = await import("../weekly-k6-actions.js");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let drawn = 0;
  const slow = { loadWeekly: async () => { await gate; state.lastWeeklyData = plans.RB; }, renderCurrent() { drawn += 1; } };
  const pending = switchWeeklyAthlete("ub", slow);
  weeklyBackToCalendar({ renderCurrent() {}, goBack() { state.activeTab = "central-calendar"; } });
  assert.equal(state.centralCalendar.weeklyFlow, null, "ending the flow is what makes the continuation bail");
  const before = drawn;
  release();
  assert.equal(await pending, false);
  assert.equal(drawn, before, "nothing is drawn after the coach left");
  assert.deepEqual(state.navStack, []);
});

test("after Back to calendar, a later entry into the same athlete's plan carries no switcher", async () => {
  const { weeklyBackToCalendar } = await import("../weekly-k6-actions.js");
  weeklyBackToCalendar({ renderCurrent() {}, goBack() {} });
  state.activeTab = "weekly";
  state.selectedAthleteId = "RA";
  assert.equal(activeWeeklyFlow(), null);
  assert.equal(renderWeeklyK6Html(), "");
});

test("leaving the Weekly tab by any other way during a load draws nothing either", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let drawn = 0;
  const pending = switchWeeklyAthlete("ub", { loadWeekly: async () => { await gate; state.lastWeeklyData = plans.RB; }, renderCurrent() { drawn += 1; } });
  state.activeTab = "tests";
  const before = drawn;
  release();
  assert.equal(await pending, false);
  assert.equal(drawn, before);
});

test("a failed switch restores the exercise detail's navigation too", async () => {
  state.navStack = tap(ANA, ["Strength", "Power"]);
  state.exerciseDetail = { ids: ["x", "y"], currentId: "x" };
  const keep = state.exerciseDetail;
  assert.equal(await switchWeeklyAthlete("ub", { loadWeekly: async () => {}, renderCurrent() {} }), false);
  assert.equal(state.exerciseDetail, keep);
});

test("K6-F4. the Weekly strip hides: no pills and no Groups, who is chosen and one control to show it stay", () => {
  const flow = { keys: ["a", "b", "c"], currentKey: "b", eventKey: "", line: "", kept: "", busy: false, notInKeys: [] };
  const items = [{ key: "a", name: "Ana Kovač" }, { key: "b", name: "Ben Marsh" }, { key: "c", name: "Cara Both" }];
  const shown = K.renderWeeklySwitcherHtml({ flow, items, currentKey: "b", groupsHtml: "<div class=\"g\"></div>" });
  assert.match(shown, /builder-batch-pills/);
  assert.match(shown, />Hide athletes</);
  const hidden = K.renderWeeklySwitcherHtml({ flow, items, currentKey: "b", groupsHtml: "<div class=\"g\"></div>", stripHidden: true });
  assert.equal(/builder-batch-pills|class="g"/.test(hidden), false);
  assert.match(hidden, /<strong>Ben Marsh<\/strong>/);
  assert.match(hidden, /2 \/ 3/);
  assert.match(hidden, /data-action="weekly-k6-strip-toggle" aria-expanded="false">Show athletes</);
});

// --- PR2: the switcher holds the athletes of one item (or of Home's day), never more than the roster returns ------

test("K6-F5. a panel row opens the plan with THAT item's athletes: roster-intersected, targeted only, named for what it is", async () => {
  const W = await import("../weekly-k6-actions.js");
  const cal = state.centralCalendar;
  const before = cal.panel;
  cal.panel = { open: true, athletes: [
    { athleteId: "ub", name: "Ben", targeted: true },
    { athleteId: "ua", name: "Ana", targeted: true },
    { athleteId: "not-in-roster", name: "Stranger", targeted: true },
    { athleteId: "uc", name: "Cara", targeted: false },
  ] };
  try {
    const event = W.weeklyFlowFromPanel("ua", { kind: "event" });
    assert.deepEqual(event.keys, ["ua", "ub"], "by name, the roster's athletes only, the no-longer-targeted one left out");
    assert.equal(event.listLabel, "in this event");
    assert.equal(event.eventKey, "", "a plain list, not the See each athlete slot flow");
    assert.equal(event.origin, "calendar");
    assert.equal(W.weeklyFlowFromPanel("ua", { kind: "planned" }).listLabel, "planned on this day");
    assert.equal(W.weeklyFlowFromPanel("ua", { kind: "activity" }).listLabel, "recorded in this session", "an imported activity's list is its recorded athletes");
    assert.match(event.scopeNote, /^Only the athletes of this event are listed\./);
    // An athlete the list does not hold falls back to the calendar's own strip, which still holds her.
    const other = W.weeklyFlowFromPanel("uc", { kind: "event" });
    assert.equal(other.listLabel, undefined);
    assert.ok(other.keys.includes("uc"));
    assert.equal(other.keys.includes("not-in-roster"), false);
  } finally {
    cal.panel = before;
  }
});

test("K6-F6. Home's day: only roster athletes with a session; one athlete alone, or one the roster lacks, gets no switcher", async () => {
  const W = await import("../weekly-k6-actions.js");
  const flow = W.weeklyFlowFromHome(["ua", "ub", "not-in-roster", "ua"], "ub");
  assert.deepEqual(flow.keys, ["ua", "ub"], "once each, the roster's only");
  assert.equal(flow.currentKey, "ub");
  assert.equal(flow.origin, "home");
  assert.equal(flow.listLabel, "with a session on this day");
  assert.equal(W.weeklyFlowFromHome(["ua"], "ua"), null, "one athlete needs no switcher");
  assert.equal(W.weeklyFlowFromHome(["ua", "ub"], "not-in-roster"), null);
  assert.equal(W.weeklyFlowFromHome(["not-in-roster", "other"], "not-in-roster"), null);
});

test("K6-F8. Home's day keys are the day list's own rows: training only, a UUID each, the shown day only", async () => {
  const H = await import("../coach-home.js");
  const { emptyCoachHomeState } = await import("../state.js");
  const rows = [
    { athleteId: "RB", athleteUuid: "ub", athlete: "Ben", hasTrainingToday: true },
    { athleteId: "RA", athleteUuid: "ua", athlete: "Ana", hasTrainingToday: true },
    { athleteId: "RC", athleteUuid: "uc", athlete: "Cara", hasTrainingToday: false },
    { athleteId: "RX", athleteUuid: "", athlete: "No uuid", hasTrainingToday: true },
  ];
  const home = emptyCoachHomeState();
  assert.deepEqual(H.coachHomeDayAthleteKeys(rows, home, "2026-10-12", "2026-10-12"), ["ua", "ub"]);
  assert.deepEqual(H.coachHomeDayAthleteKeys(rows, home, "2026-10-13", "2026-10-12"), [], "another day than the one shown");
  home.calendar.selected = "2026-10-14";
  assert.deepEqual(H.coachHomeDayAthleteKeys(rows, home, "2026-10-14", "2026-10-12"), [], "another day is its own read, not ready yet");
});

test("K6-F7. a list flow says what the list is, goes Back to Home, and has no Groups to change it", async () => {
  const W = await import("../weekly-k6-actions.js");
  const flow = W.weeklyFlowFromHome(["ua", "ub"], "ua");
  const html = K.renderWeeklySwitcherHtml({ flow, items: [{ key: "ua", name: "Ana" }, { key: "ub", name: "Ben" }], currentKey: "ua" });
  assert.match(html, /1 \/ 2 with a session on this day/);
  assert.match(html, /Back to Home/);
  assert.equal(/Back to calendar/.test(html), false);
  const calendar = K.renderWeeklySwitcherHtml({ flow: { ...flow, origin: undefined, listLabel: undefined }, items: [{ key: "ua", name: "Ana" }, { key: "ub", name: "Ben" }], currentKey: "ua" });
  assert.match(calendar, /Back to calendar/);
  assert.match(html, /Only the athletes with a session on this day are listed\. Back shows everyone\./);
  // The team exists, so only the list flow's own guard can refuse the chip (a stale or forged click).
  const cal = state.centralCalendar;
  const before = { data: cal.data, teamIds: cal.filters.teamIds };
  cal.data = { teams: [{ teamId: "t1", name: "T1" }] };
  cal.filters.teamIds = [];
  cal.weeklyFlow = flow;
  state.selectedAthleteId = "RA";
  try {
    assert.equal(await W.chooseWeeklyGroup("t1", { loadWeekly: async () => {}, renderCurrent() {} }), false, "the list is fixed: a team chip never widens it");
    assert.deepEqual(cal.filters.teamIds, []);
    assert.deepEqual(flow.keys, ["ua", "ub"]);
  } finally {
    cal.data = before.data;
    cal.filters.teamIds = before.teamIds;
  }
});

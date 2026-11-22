// Central calendar K5-4 (docs/ai/central-calendar-k5-4-contract.md, section 5): the day marks "N GPS sessions to
// review" and Imports opened on day D - through the real calendar loader, applied hook, view and action handler, and
// Imports' real loader and period chooser, with a fake fetch that keeps the routes' contracts: GET /api/calendar,
// GET /api/training-load/gpexe/teams/:teamId/calendar (the mapping stream's Imports calendar: per UTC day the counts
// of its state rule, numbers and state words only) and Imports' own reads. app.js cannot be imported (it runs init()
// at import); its few K5-4 lines are pinned by source guards at the end, and the e2e suite drives them in a browser.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const { state, emptyTrainingLoadState } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { handleCentralCalendarAction } = await import("../central-calendar-actions.js");
const { invalidateCentralCalendarCache, loadCentralCalendar, resetCentralCalendarForWorkspaceChange } = await import("../central-calendar-data.js");
const view = await import("../central-calendar-view.js");
const gps = await import("../central-calendar-gps-review.js");
const { enterImportsOnDay, importsEntryBusy } = await import("../central-calendar-imports-entry.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { setGpexePollDelayForTests } = await import("../gpexe-import-data.js");
const period = await import("../gpexe-period-data.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

setGpexePollDelayForTests(() => Promise.resolve());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
// A past week whose every day is before today: no "future day" rule applies there.
const PAST_MONDAY = addDaysIso(MONDAY, -14);
const PDAY = (offset) => addDaysIso(PAST_MONDAY, offset);
const U17 = "22222222-2222-4222-8222-222222222222";
const U19 = "33333333-3333-4333-8333-333333333333";
const CLUB = "c1c1c1c1-0000-4000-8000-000000000001";
const TEAMS = [{ teamId: U17, name: "U17", athleteCount: 5 }];
const PLANT = { label: "Zyxplant Session", sessionId: "7489991", athlete: "Qwplant Athleteone" };

function rangeAnswer(url, items, workspace) {
  const params = new URL(url, "http://localhost").searchParams;
  const from = params.get("from");
  const to = params.get("to");
  const days = [];
  for (let cursor = from; cursor <= to; cursor = addDaysIso(cursor, 1)) days.push({ date: cursor, items: items.filter((item) => item.date === cursor) });
  return { from, to, today: params.get("today"), workspace, teams: TEAMS, days };
}

function training(date) {
  return {
    key: `event:e1:${date}`, kind: "event", date, eventId: "e0000000-0000-4000-8000-000000000001", eventKind: "training", eventTypeLabel: "Training",
    eventTypeId: null, eventTypeIconKey: null, eventTypeColorKey: null, title: "Team training", slot: null, startTime: "10:00", endTime: null,
    startsAt: null, location: null, place: null, teamIds: [U17], athleteIds: [], athleteCount: 0, expects: [], status: "planned", rpe: null,
    attendance: null, results: null, cancelled: false, projected: false, span: { from: date, to: date }, gaps: [],
    scheduleFold: { external: null, test: null }, revision: 1, canManage: true, notes: null, details: null,
    links: { eventId: "e0000000-0000-4000-8000-000000000001", planIds: [], logicalSessionIds: [], activityIds: [], externalScheduleId: null, testScheduleId: null },
  };
}

// The route's answer for a range: `days` as [{ day, needs, ready, imported, out }].
function gpsDay({ day, needs = 0, ready = 0, imported = 0, out = 0, chips }) {
  const words = [...Array(needs).fill("needs"), ...Array(ready).fill("ready"), ...Array(imported).fill("imported"), ...Array(out).fill("out")];
  return { day, chips: chips || words.slice(0, 3), counts: { needs, ready, imported, out } };
}
function gpsAnswer(url, days, { truncated = false } = {}) {
  const params = new URL(url, "http://localhost").searchParams;
  return { from: params.get("from"), to: params.get("to"), days: days.filter((d) => d.day >= params.get("from") && d.day <= params.get("to")), truncated };
}

// `gpsRoute(call)`: the Imports calendar's answer ({ status, body }, or a promise of one, or a thrown loss).
function server({ items = () => [], workspace = { type: "team", scopeId: U17 }, gpsRoute = (call) => ({ status: 200, body: gpsAnswer(call.url, []) }), imports = null } = {}) {
  return (call) => {
    const pathOnly = call.url.split("?")[0];
    if (pathOnly === "/api/calendar" && call.method === "GET") return { status: 200, body: rangeAnswer(call.url, items(), workspace) };
    if (pathOnly === "/api/calendar/events/types") return { status: 200, body: { types: [], fields: [], locations: [], teamDefaults: {}, questions: { enabled: false } } };
    if (/^\/api\/training-load\/gpexe\/teams\/[^/]+\/calendar$/.test(pathOnly) && !imports?.ownCalendar) return gpsRoute(call);
    if (imports) {
      const answer = imports(call);
      if (answer) return answer;
    }
    return { status: 404, body: { error: "notFound" } };
  };
}

let rendered = "";
let layout = "wide";
function render() {
  rendered = view.renderCentralCalendarHtml(state.centralCalendar, { today: TODAY, layout });
}
const dom = () => new JSDOM(`<!doctype html><body>${rendered}</body>`).window.document;
const marks = () => [...dom().querySelectorAll(".cc-daymark")];
const markOn = (date) => dom().querySelector(`.cc-daymark[data-date="${date}"]`);
const markText = (date) => markOn(date)?.textContent.replace(/\s+/g, " ").trim() ?? null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const gpsReads = (calls) => calls.filter((call) => /\/api\/training-load\/gpexe\/teams\/[^/]+\/calendar/.test(call.url));
const act = (dataset, extra = {}) => handleCentralCalendarAction(fakeAction(dataset), { render, ...extra });

function signIn(workspace = { type: "team", scopeId: U17 }) {
  state.currentUser = { id: "coach-1", activeWorkspace: { ...workspace, label: "U17" } };
}

beforeEach(() => {
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  state.deliberateNavigation = false;
  state.activeTab = "central-calendar";
  state.trainingLoad = emptyTrainingLoadState();
  layout = "wide";
  signIn();
  rendered = "";
});

// Opens the calendar on the past week (or `anchor`) and waits for the mark read.
async function openCalendar(options = {}, { anchor = PAST_MONDAY, view: shownView = "week" } = {}) {
  const calls = installFetchMock(server(options));
  state.centralCalendar.anchor = anchor;
  state.centralCalendar.selectedDate = anchor;
  state.centralCalendar.view = shownView;
  await loadCentralCalendar({ render });
  await tick();
  return calls;
}

// --- R1: the read ------------------------------------------------------------

test("R1a. a team workspace makes ONE Imports-calendar read per shown range, for its team, with the shown days; a week turned back is the cache", async () => {
  const calls = await openCalendar({ gpsRoute: (call) => ({ status: 200, body: gpsAnswer(call.url, [gpsDay({ day: PDAY(2), ready: 2 })]) }) });
  const reads = gpsReads(calls);
  assert.equal(reads.length, 1, "one read");
  const url = new URL(reads[0].url, "http://localhost");
  assert.equal(url.pathname, `/api/training-load/gpexe/teams/${U17}/calendar`);
  assert.equal(url.searchParams.get("from"), state.centralCalendar.data.from, "from: the calendar's own first day");
  assert.equal(url.searchParams.get("to"), state.centralCalendar.data.to, "to: the calendar's own last day");
  assert.equal(reads[0].method, "GET");
  assert.equal(markText(PDAY(2)), "2 GPS sessions to review");

  await act({ action: "central-calendar-next" });
  await tick();
  assert.equal(gpsReads(calls).length, 2, "the next week: its own read");
  await act({ action: "central-calendar-prev" });
  await tick();
  assert.equal(gpsReads(calls).length, 2, "the week turned back: from the cache, no read");
  assert.equal(markText(PDAY(2)), "2 GPS sessions to review", "and its mark is back");
});

test("R1b. a club, platform or private-coach workspace, or an athlete's answer, never reads and never marks", async () => {
  for (const workspace of [{ type: "club", scopeId: CLUB }, { type: "platform", scopeId: null }, { type: "private_coach", scopeId: "pc-1" }, { type: "athlete", scopeId: "ath-1" }]) {
    clearAllViewCache();
    resetCentralCalendarForWorkspaceChange();
    signIn(workspace);
    const calls = await openCalendar({ workspace, gpsRoute: (call) => ({ status: 200, body: gpsAnswer(call.url, [gpsDay({ day: PDAY(2), ready: 2 })]) }) });
    assert.equal(gpsReads(calls).length, 0, `no read in a ${workspace.type} workspace`);
    assert.equal(marks().length, 0, `no mark in a ${workspace.type} workspace`);
  }
});

test("R1c. a workspace change, the calendar's refresh and a sign-out each drop the marks: the next answer reads again", async () => {
  const route = (call) => ({ status: 200, body: gpsAnswer(call.url, [gpsDay({ day: PDAY(2), needs: 1 })]) });
  const calls = await openCalendar({ gpsRoute: route });
  assert.equal(gpsReads(calls).length, 1);

  invalidateCentralCalendarCache();
  assert.equal(gps.gpsReviewMark(state.centralCalendar, PDAY(2)), null, "a refresh drops the read at once");
  await loadCentralCalendar({ render });
  await tick();
  assert.equal(gpsReads(calls).length, 2, "the refresh reads again");

  gps.clearGpsReview(); // what app.js's signOut calls (pinned by a source guard below)
  assert.equal(gps.gpsReviewMark(state.centralCalendar, PDAY(2)), null, "a sign-out drops it");

  resetCentralCalendarForWorkspaceChange();
  const again = await openCalendar({ gpsRoute: route });
  assert.equal(gpsReads(again).length, 1, "the new workspace reads again");
});

test("R1d. no read while the calendar's own answer is missing", async () => {
  const calls = installFetchMock((call) => {
    if (call.url.startsWith("/api/calendar")) return { status: 500, body: { error: "internal_error" } };
    return { status: 200, body: gpsAnswer(call.url, [gpsDay({ day: PDAY(2), ready: 1 })]) };
  });
  state.centralCalendar.anchor = PAST_MONDAY;
  await loadCentralCalendar({ render });
  await tick();
  assert.equal(gpsReads(calls).length, 0);
  assert.equal(gps.ensureGpsReview({ data: null }, render), null);
});

test("R1e. the cache is per team: another team's calendar of the same days reads its own marks", async () => {
  const days = { from: PAST_MONDAY, to: PDAY(6) };
  const calls = installFetchMock((call) => ({
    status: 200,
    body: gpsAnswer(call.url, [gpsDay({ day: PDAY(2), ready: call.url.includes(U17) ? 1 : 4 })]),
  }));
  const calA = { data: { workspace: { type: "team", scopeId: U17 }, ...days }, filters: { kinds: [], eventKinds: [], teamIds: [] } };
  const calB = { data: { workspace: { type: "team", scopeId: U19 }, ...days }, filters: { kinds: [], eventKinds: [], teamIds: [] } };
  await gps.ensureGpsReview(calA, () => {});
  await gps.ensureGpsReview(calB, () => {});
  assert.equal(gpsReads(calls).length, 2, "one read per team");
  assert.deepEqual(gps.gpsReviewMark(calA, PDAY(2)), { count: 1, plus: false });
  assert.deepEqual(gps.gpsReviewMark(calB, PDAY(2)), { count: 4, plus: false }, "never the other team's count");
});

// --- R2: silence -------------------------------------------------------------

test("R2. a 404, a 403, a 500, a lost answer and a malformed answer each give no mark and no message; the cards are unchanged", async () => {
  const items = () => [training(PDAY(2))];
  await openCalendar({ items, gpsRoute: (call) => ({ status: 200, body: gpsAnswer(call.url, []) }) });
  const quiet = rendered;
  assert.equal(marks().length, 0);
  const failures = [
    () => ({ status: 404, body: { error: "notFound" } }),
    () => ({ status: 403, body: { error: "forbidden" } }),
    () => ({ status: 500, body: { error: "internal_error" } }),
    () => { throw new TypeError("Failed to fetch"); },
    () => ({ status: 200, body: { days: "nope" } }),
    () => ({ status: 200, body: { days: [{ day: "14.10.2026", counts: { ready: 2 } }] } }),
    () => ({ status: 200, body: { days: [{ day: PDAY(2), counts: null }] } }),
    () => ({ status: 200, body: null }),
  ];
  for (const [index, failure] of failures.entries()) {
    clearAllViewCache();
    resetCentralCalendarForWorkspaceChange();
    await openCalendar({ items, gpsRoute: failure });
    assert.equal(marks().length, 0, `failure ${index}: no mark`);
    assert.equal(rendered, quiet, `failure ${index}: the calendar is exactly as with nothing waiting`);
  }
});

test("R2b. only an answer with something to show repaints the calendar: a refusal or nothing waiting changes nothing on screen", async () => {
  const cal = { data: { workspace: { type: "team", scopeId: U17 }, from: PAST_MONDAY, to: PDAY(6) }, filters: { kinds: [], eventKinds: [], teamIds: [] } };
  const paints = async (route) => {
    gps.clearGpsReview();
    installFetchMock(route);
    state.centralCalendar = cal;
    let count = 0;
    await gps.ensureGpsReview(cal, () => { count += 1; });
    return count;
  };
  assert.equal(await paints(() => ({ status: 404, body: { error: "notFound" } })), 0, "a refusal: no repaint");
  assert.equal(await paints((call) => ({ status: 200, body: gpsAnswer(call.url, [gpsDay({ day: PDAY(2), imported: 3, out: 1 })]) })), 0, "nothing waiting: no repaint");
  assert.equal(await paints((call) => ({ status: 200, body: gpsAnswer(call.url, [gpsDay({ day: PDAY(2), ready: 1 })]) })), 1, "a mark to draw: one repaint");
  assert.equal(await paints((call) => ({ status: 200, body: gpsAnswer(call.url, [], { truncated: true }) })), 1, "a cut answer (uncertain marks): one repaint");
});

// --- R3: counts ----------------------------------------------------------------

test("R3a. needs + ready is counted; imported and out alone make no mark; one vs several; odd keys and words are ignored", async () => {
  await openCalendar({
    gpsRoute: (call) => ({
      status: 200,
      body: gpsAnswer(call.url, [
        gpsDay({ day: PDAY(0), needs: 1 }),
        gpsDay({ day: PDAY(1), needs: 1, ready: 2, imported: 4, out: 1 }),
        gpsDay({ day: PDAY(2), imported: 3, out: 2 }),
        { day: PDAY(3), chips: ["ready", "bogus"], counts: { needs: "3", ready: 1, imported: 0, out: 0, weird: 9 } },
        { day: PDAY(4), chips: [], counts: { needs: -2, ready: 1.5, imported: 0, out: 0 } },
      ]),
    }),
  });
  assert.equal(markText(PDAY(0)), "1 GPS session to review");
  assert.equal(markText(PDAY(1)), "3 GPS sessions to review", "needs + ready only");
  assert.equal(markOn(PDAY(2)), null, "imported and out alone: no mark");
  assert.equal(markText(PDAY(3)), "1 GPS session to review", "a non-number count and an unknown key are ignored");
  assert.equal(markOn(PDAY(4)), null, "a negative or fractional count is no count");
  assert.doesNotMatch(rendered, /NaN|undefined/);
  assert.equal(markOn(PDAY(1)).getAttribute("aria-label"), `3 GPS sessions to review on ${view.centralCalendarLongDate(PDAY(1))}, open Imports`);
  assert.equal(markOn(PDAY(1)).tagName, "BUTTON");
  assert.equal(markOn(PDAY(1)).dataset.action, "central-calendar-gps-review");
});

test("R3b. a cut answer never reads as nothing: exact before its last day, N+ on it, uncertain after it up to today, nothing in the future", () => {
  // A unit check of the mark rule on today's week, with "now" fixed on its Wednesday.
  const now = new Date(`${addDaysIso(MONDAY, 2)}T12:00:00`);
  const cal = { data: { workspace: { type: "team", scopeId: U17 }, from: MONDAY, to: addDaysIso(MONDAY, 6) }, filters: { kinds: [], eventKinds: [], teamIds: [] } };
  const W = (n) => addDaysIso(MONDAY, n);
  const load = async (days, truncated) => {
    gps.clearGpsReview();
    installFetchMock((call) => ({ status: 200, body: { from: MONDAY, to: W(6), days, truncated } }));
    state.centralCalendar = cal;
    await gps.ensureGpsReview(cal, () => {});
  };
  return (async () => {
    await load([gpsDay({ day: W(0), ready: 2 }), gpsDay({ day: W(1), needs: 12 })], true);
    assert.deepEqual(gps.gpsReviewMark(cal, W(0), now), { count: 2, plus: false }, "a day before the last: exact");
    assert.deepEqual(gps.gpsReviewMark(cal, W(1), now), { count: 12, plus: true }, "the last day: N+");
    assert.equal(gps.gpsReviewWords(gps.gpsReviewMark(cal, W(1), now)), "12+ GPS sessions to review");
    assert.deepEqual(gps.gpsReviewMark(cal, W(2), now), { uncertain: true }, "after the last day, up to today: uncertain");
    assert.equal(gps.gpsReviewWords({ uncertain: true }), "GPS sessions may be waiting");
    assert.equal(gps.gpsReviewMark(cal, W(3), now), null, "a future day: nothing");

    await load([gpsDay({ day: W(0), needs: 1 }), gpsDay({ day: W(1), imported: 4 })], true);
    assert.deepEqual(gps.gpsReviewMark(cal, W(1), now), { uncertain: true }, "the last day at 0: uncertain, never nothing");

    await load([], true);
    for (const n of [0, 1, 2]) assert.deepEqual(gps.gpsReviewMark(cal, W(n), now), { uncertain: true }, "no day at all: every day up to today");
    assert.equal(gps.gpsReviewMark(cal, W(4), now), null);

    await load([gpsDay({ day: W(1), ready: 2 })], false);
    assert.deepEqual(gps.gpsReviewMark(cal, W(1), now), { count: 2, plus: false }, "an answer not cut: exact");
    assert.equal(gps.gpsReviewMark(cal, W(2), now), null, "and nothing after it");
  })();
});

test("R3c. the mark's text and label hold no name, id, time or value of the answer", async () => {
  await openCalendar({
    gpsRoute: (call) => ({
      status: 200,
      body: { ...gpsAnswer(call.url, [{ ...gpsDay({ day: PDAY(2), ready: 2 }), label: PLANT.label, gpexeTeamSessionId: PLANT.sessionId, athlete: PLANT.athlete, sessionStartedAt: `${PDAY(2)}T09:41:00Z` }]), note: PLANT.label },
    }),
  });
  assert.equal(markText(PDAY(2)), "2 GPS sessions to review");
  for (const planted of [PLANT.label, PLANT.sessionId, PLANT.athlete, "09:41"]) assert.equal(rendered.includes(planted), false, `no ${planted}`);
});

// --- R4: late answers ------------------------------------------------------------

test("R4. an answer for a dropped workspace or an earlier week is never drawn on the screen now shown", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const calls = await openCalendar({ gpsRoute: (call) => held.then(() => ({ status: 200, body: gpsAnswer(call.url, [gpsDay({ day: PDAY(2), ready: 5 })]) })) });
  assert.equal(gpsReads(calls).length, 1);
  // The workspace changes while the read is in flight.
  resetCentralCalendarForWorkspaceChange();
  gps.clearGpsReview();
  release();
  await tick();
  assert.equal(gps.gpsReviewMark(state.centralCalendar, PDAY(2)), null, "the late answer is dropped");

  // An earlier week's late answer: drawn on no day of the week now shown.
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  let releaseWeek;
  const heldWeek = new Promise((resolve) => { releaseWeek = resolve; });
  await openCalendar({ gpsRoute: (call) => (call.url.includes(`from=${PAST_MONDAY}`) ? heldWeek : Promise.resolve()).then(() => ({ status: 200, body: gpsAnswer(call.url, [gpsDay({ day: PDAY(2), ready: 5 }), gpsDay({ day: PDAY(9), ready: 1 })]) })) });
  await act({ action: "central-calendar-next" });
  await tick();
  releaseWeek();
  await tick();
  assert.deepEqual(marks().map((mark) => mark.dataset.date), [PDAY(9)], "only the shown week's own mark");
});

// --- R5: the filters ---------------------------------------------------------------

test("R5. with no kind chosen the marks show; another Show only choice, an event type or groups without the team hide them", async () => {
  const route = (call) => ({ status: 200, body: gpsAnswer(call.url, [gpsDay({ day: PDAY(2), ready: 2 })]) });
  await openCalendar({ gpsRoute: route });
  assert.equal(marks().length, 1);
  const cal = state.centralCalendar;
  const gpsPill = () => dom().querySelector('.cc-showonly-pill[data-kind="gps"] .cc-chip-count')?.textContent;
  assert.equal(gpsPill(), "2", "the GPS imports pill counts the waiting sessions");
  // K5-2's Show only · GPS imports keeps them.
  await act({ action: "central-calendar-show-only", kind: "gps" });
  assert.equal(marks().length, 1, "Show only GPS imports keeps them");
  assert.equal(gpsPill(), "2");
  assert.match(dom().querySelector(".cc-showonly-line").textContent, /Showing only GPS imports · 2 this week/);
  cal.filters.kinds = ["event"];
  render();
  assert.equal(marks().length, 0, "another kind hides them");
  cal.filters.kinds = [];
  cal.filters.eventKinds = ["training"];
  render();
  assert.equal(marks().length, 0, "an event type hides them");
  cal.filters.eventKinds = [];
  cal.filters.teamIds = [U19];
  render();
  assert.equal(marks().length, 0, "groups that leave the team out hide them");
  cal.filters.teamIds = [U17];
  render();
  assert.equal(marks().length, 1, "groups with the team keep them");
});

// --- R6: the midnight boundary -------------------------------------------------------

test("R6. the mark sits on the server's day string in every device zone, and its click chooses that day", async () => {
  const before = process.env.TZ;
  try {
    for (const zone of ["Europe/Belgrade", "America/New_York"]) {
      process.env.TZ = zone;
      clearAllViewCache();
      resetCentralCalendarForWorkspaceChange();
      gps.clearGpsReview();
      // 23:30 UTC on 14.10 (00:30 on the 15th in Belgrade) is the 14th; 00:30 and 02:00 UTC on 15.10 are the 15th
      // (the 14th in New York): the server's UTC day, sessionDay.
      const calls = await openCalendar({
        gpsRoute: (call) => ({ status: 200, body: gpsAnswer(call.url, [gpsDay({ day: "2026-10-14", ready: 1 }), gpsDay({ day: "2026-10-15", needs: 2 })]) }),
      }, { anchor: "2026-10-14" });
      const url = new URL(gpsReads(calls)[0].url, "http://localhost");
      assert.equal(url.searchParams.get("from"), "2026-10-12", `${zone}: from is the grid's own Monday`);
      assert.equal(url.searchParams.get("to"), "2026-10-18", `${zone}: to is the grid's own Sunday`);
      assert.equal(markText("2026-10-14"), "1 GPS session to review", `${zone}: on Wed 14.10`);
      assert.equal(markText("2026-10-15"), "2 GPS sessions to review", `${zone}: on Thu 15.10`);
      assert.equal(markOn("2026-10-13"), null);
      const opened = [];
      await act({ action: "central-calendar-gps-review", date: "2026-10-14" }, { openImports: (arg) => opened.push(arg) });
      assert.deepEqual(opened, [{ teamId: U17, day: "2026-10-14" }], `${zone}: the click chooses 14.10`);
    }
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

// --- The mark in every layout, and its click ----------------------------------------------

test("M1. the mark in the week columns, the wide time grid's No set time row, the phone's selected day, the Day view and the month grid", async () => {
  const items = () => [training(PDAY(1))];
  await openCalendar({ items, gpsRoute: (call) => ({ status: 200, body: gpsAnswer(call.url, [gpsDay({ day: PDAY(1), ready: 2 }), gpsDay({ day: PDAY(3), needs: 1 })]) }) });
  const cal = state.centralCalendar;
  layout = "medium";
  render();
  assert.ok(dom().querySelector(`.cc-day-column .cc-daymark[data-date="${PDAY(1)}"]`), "week columns");
  const column = markOn(PDAY(1)).closest(".cc-day-column");
  assert.ok(column.querySelector(".cc-card, .cc-day-cards"), "after the day's cards");
  assert.equal(markOn(PDAY(3)).closest(".cc-day-column").querySelector(".cc-day-empty"), null, "a day with only a mark shows no empty dash");

  layout = "wide";
  cal.weekMode = "grid";
  render();
  assert.ok(dom().querySelector(`.cc-timegrid-untimed .cc-daymark[data-date="${PDAY(1)}"]`), "the time grid: in the No set time row");

  layout = "phone";
  cal.weekMode = "columns";
  cal.selectedDate = PDAY(3);
  render();
  assert.equal(markText(PDAY(3)), "1 GPS session to review", "the phone's selected day");
  assert.doesNotMatch(dom().querySelector(".cc-day-list").textContent, /Nothing on this day/, "a day with a mark is not 'nothing'");
  assert.match(dom().querySelector(`.cc-strip-day[data-date="${PDAY(1)}"]`).getAttribute("aria-label"), /2 GPS sessions to review$/, "the strip's day says it");
  assert.ok(dom().querySelector(`.cc-strip-day[data-date="${PDAY(1)}"] .cc-daymark-sign`), "and wears the sign");

  cal.view = "day";
  cal.anchor = PDAY(1);
  render();
  assert.equal(markText(PDAY(1)), "2 GPS sessions to review", "the Day view");

  cal.view = "month";
  cal.anchor = PAST_MONDAY;
  layout = "wide";
  await loadCentralCalendar({ render });
  await tick();
  const mini = dom().querySelector(`.cc-month-cards .cc-daymark-mini[data-date="${PDAY(1)}"]`);
  assert.ok(mini, "the month grid: a mini mark");
  assert.equal(mini.textContent.trim(), "2", "the icon and the number");
  assert.match(mini.getAttribute("aria-label"), /^2 GPS sessions to review on /);
});

test("M2. a week with only marks is not 'Nothing planned or recorded'", async () => {
  await openCalendar({ gpsRoute: (call) => ({ status: 200, body: gpsAnswer(call.url, [gpsDay({ day: PDAY(2), ready: 1 })]) }) });
  assert.equal(dom().querySelector(".cc-empty"), null);
});

test("M3. the click opens Imports on the day, for the workspace's team; never without a mark, outside a team workspace or for a non-date", async () => {
  await openCalendar({ gpsRoute: (call) => ({ status: 200, body: gpsAnswer(call.url, [gpsDay({ day: PDAY(2), ready: 1 })]) }) });
  const opened = [];
  const openImports = (arg) => opened.push(arg);
  await act({ action: "central-calendar-gps-review", date: PDAY(2) }, { openImports });
  assert.deepEqual(opened, [{ teamId: U17, day: PDAY(2) }]);
  await act({ action: "central-calendar-gps-review", date: PDAY(3) }, { openImports });
  await act({ action: "central-calendar-gps-review", date: "2026-13-45x" }, { openImports });
  assert.equal(opened.length, 1, "no mark, no entry");
  state.centralCalendar.data.workspace = { type: "club", scopeId: CLUB };
  render();
  await act({ action: "central-calendar-gps-review", date: PDAY(2) }, { openImports });
  assert.equal(opened.length, 1, "not outside a team workspace");
  assert.equal(marks().length, 0);
});

// --- B: Imports opened on day D --------------------------------------------------------------

const ORG = { teams: [{ id: U17, name: "U17", club_name: "Club" }], clubs: [], athletes: [] };
const two = (n) => String(n).padStart(2, "0");
const hashOf = (n) => String(n).padStart(2, "0").repeat(32);
function candidate(n, day, overrides = {}) {
  return {
    id: `cand-${n}`, gpexeTeamSessionId: `70${two(n)}`, label: `FULL TRAINING ${n}`, sessionStartedAt: `${day}T${two(8 + (n % 10))}:00:00Z`,
    status: "pending", previewStatus: "ready", previewHash: hashOf(n), counts: { created: 4, athletesNotImported: 0 }, changesToImported: 0,
    snapshot: { available: true, expiresAt: "2099-01-01T00:00:00Z" }, approvalBlockers: [], blockedCode: null, blockedSourceCode: null,
    sessionType: "FULL TRAINING", reasons: [], lastSeenAt: `${day}T12:00:00Z`, ...overrides,
  };
}
function importsServer({ candidates = [], truncated = false, older = {}, lastCheck = null, hold = null } = {}) {
  const calls = installFetchMock(async (call) => {
    if (hold && call.url.endsWith("/status")) await hold;
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/[^?]*)(\?.*)?$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const [, , rest, query = ""] = m;
    const params = new URLSearchParams(query.slice(1));
    if (rest === "/status") {
      return { status: 200, body: { settings: { gpexeTeamId: "980" }, importSwitch: { enabled: true, message: "" }, lastCheck, lastSucceededCheck: null, viewer: { canApprove: true, approvalBasis: "team_grant", isPlatformAdmin: false }, approvalAvailable: true } };
    }
    if (rest === "/source-athletes") return { status: 200, body: { athletes: [], units: {}, lastSeenRule: "" } };
    if (rest === "/athlete-links") return { status: 200, body: { links: [] } };
    if (rest === "/candidates" && params.get("from")) return { status: 200, body: { candidates: older[`${params.get("from")}..${params.get("to")}`] || [], truncated: false } };
    if (rest === "/candidates") return { status: 200, body: { candidates, truncated } };
    if (rest === "/calendar") return { status: 200, body: { from: params.get("from"), to: params.get("to"), days: [], truncated: false } };
    return { status: 404, body: { error: "notFound" } };
  });
  return calls;
}
const gx = () => state.trainingLoad.gpexe;
const importsHtml = () => renderTrainingLoadCoachHtml();
function periodSection() {
  const html = importsHtml();
  const start = html.indexOf('<section class="gpexe-panel imports-period');
  return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start) + 10);
}
const D = PDAY(3);

function enterAsTeamCoach() {
  state.activeTab = "training-load";
  signIn();
}

test("B1. the entry opens Imports' section through its own loader and chooses D; on a phone it opens the sheet", async () => {
  enterAsTeamCoach();
  const calls = importsServer({ candidates: [candidate(1, D)] });
  const outcome = await enterImportsOnDay({ teamId: U17, day: D, phone: true });
  assert.equal(outcome, "chosen");
  assert.equal(state.trainingLoad.section, "imports");
  assert.equal(gx().teamId, U17, "the workspace's own team, set by Imports' loader");
  assert.deepEqual(period.periodRange(gx()), { from: D, to: D, days: 1 });
  assert.equal(period.periodOf(gx()).open, true, "the phone's sheet");
  assert.match(periodSection(), /aria-modal="true"/, "a sheet is a dialog on a phone");
  assert.match(periodSection(), /Already found on these days[\s\S]*data-candidate-id="cand-1"/, "D's session is listed");
  assert.equal(calls.filter((call) => call.method !== "GET").length, 0, "GET only: nothing written, no search started");
});

test("B1b. on a computer the chooser stays on the page: no open sheet, no dialog, a scroll to it", async () => {
  enterAsTeamCoach();
  importsServer({ candidates: [candidate(1, D)] });
  let scrolled = 0;
  const outcome = await enterImportsOnDay({ teamId: U17, day: D, phone: false, scrollToChooser: () => { scrolled += 1; } });
  assert.equal(outcome, "chosen");
  assert.equal(period.periodOf(gx()).open, false, "open is the phone's sheet only");
  assert.equal(scrolled, 1, "scrolled to #imports-period");
  assert.doesNotMatch(periodSection(), /aria-modal/, "no modal on a computer");
  assert.match(periodSection(), /id="imports-period"/);
  assert.deepEqual(period.periodRange(gx()), { from: D, to: D, days: 1 });
});

test("B1c. a cut list and D older than its oldest row: the entry reads D's sessions, and they are listed", async () => {
  enterAsTeamCoach();
  const OLD = PDAY(-20);
  const list = Array.from({ length: 200 }, (_, index) => candidate(100 + index, PDAY(4 + (index % 3))));
  const calls = importsServer({ candidates: list, truncated: true, older: { [`${OLD}..${OLD}`]: [candidate(7, OLD, { label: "OLDER SESSION 7" })] } });
  const outcome = await enterImportsOnDay({ teamId: U17, day: OLD, phone: false });
  assert.equal(outcome, "chosen");
  assert.ok(calls.some((call) => call.url === `/api/training-load/gpexe/teams/${U17}/candidates?from=${OLD}&to=${OLD}`), "D's own read");
  assert.match(periodSection(), /Already found on these days[\s\S]*data-candidate-id="cand-7"/, "D's sessions are listed");
});

test("B2. with anything of Imports in flight or not confirmed, the entry chooses no day, opens no sheet and leaves Imports as it is", async () => {
  const busy = [
    ["a batch sending", (g) => { g.batch.sending = true; }],
    // Imports' unload test answers false during the app's deliberate navigations; the batch in flight still counts.
    ["a batch sending during a deliberate navigation", (g) => { g.batch.sending = true; state.deliberateNavigation = true; }],
    ["a batch not confirmed", (g) => { g.batch.unknown = true; }],
    ["the guide's write sending", (g) => { g.guide = { ...(g.guide || {}), write: { sending: true } }; }],
    ["the guide's write not confirmed", (g) => { g.guide = { ...(g.guide || {}), write: { unknown: true } }; }],
    ["an undo sending", (g) => { g.undo = { ...(g.undo || {}), step: "sending" }; }],
    ["an undo not confirmed", (g) => { g.undo = { ...(g.undo || {}), step: "unknown" }; }],
    ["a time zone saving", (g) => { g.tz = { ...(g.tz || {}), step: "saving" }; }],
    ["a time zone checking", (g) => { g.tz = { ...(g.tz || {}), step: "checking" }; }],
    ["a time zone not confirmed", (g) => { g.tz = { ...(g.tz || {}), step: "unknown" }; }],
    ["a search starting", (g) => { g.checkStarting = true; }],
    // A running search is the server's lastCheck: Imports' loader reads it again on the entry.
    ["a search running", () => {}, { id: "chk-1", status: "running", window: { from: PDAY(0), to: PDAY(1) }, startedAt: new Date().toISOString() }],
  ];
  for (const [name, make, lastCheck = null] of busy) {
    state.trainingLoad = emptyTrainingLoadState();
    clearAllViewCache();
    enterAsTeamCoach();
    importsServer({ candidates: [candidate(1, D)], lastCheck });
    // Imports already open on the team, then the state in flight.
    await enterImportsOnDay({ teamId: U17, day: PDAY(1), phone: false });
    period.clearPeriod(gx());
    period.setPeriodOpen(false, gx());
    make(gx());
    assert.equal(importsEntryBusy(gx()), true, `${name}: busy`);
    const outcome = await enterImportsOnDay({ teamId: U17, day: D, phone: true });
    assert.equal(outcome, "as-is", name);
    assert.equal(period.periodOf(gx()).from, "", `${name}: no day chosen`);
    assert.equal(period.periodOf(gx()).open, false, `${name}: no sheet`);
    state.deliberateNavigation = false;
  }
});

test("B2b. a team other than the workspace's own is never switched, and a future day is refused by the chooser's own rule", async () => {
  enterAsTeamCoach();
  importsServer({ candidates: [candidate(1, D)] });
  assert.equal(await enterImportsOnDay({ teamId: U19, day: D, phone: true }), "as-is");
  assert.equal(gx().teamId, U17);
  assert.equal(period.periodOf(gx()).from, "");
  assert.equal(await enterImportsOnDay({ teamId: U17, day: addDaysIso(TODAY, 2), phone: true }), "as-is");
  assert.equal(period.periodOf(gx()).open, false);
});

test("B4. two entries overlapping: the later mark's day wins; the earlier entry still loading gives up", async () => {
  enterAsTeamCoach();
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  importsServer({ candidates: [candidate(1, PDAY(1)), candidate(2, D)], hold });
  const first = enterImportsOnDay({ teamId: U17, day: PDAY(1), phone: false });
  const second = enterImportsOnDay({ teamId: U17, day: D, phone: false });
  release();
  assert.deepEqual(await Promise.all([first, second]), ["left", "chosen"]);
  assert.deepEqual(period.periodRange(gx()), { from: D, to: D, days: 1 }, "the later mark's day");
});

test("R7. the mark's entry drops the marks: back on the calendar they are read again, never a stale count", async () => {
  let waiting = 2;
  const calls = await openCalendar({ gpsRoute: (call) => ({ status: 200, body: gpsAnswer(call.url, [gpsDay({ day: PDAY(2), ready: waiting, imported: 2 - waiting })]) }) });
  assert.equal(markText(PDAY(2)), "2 GPS sessions to review");
  // What app.js's openImportsOnDay does first (pinned by G1): the coach imports both sessions, then comes back.
  gps.clearGpsReview();
  waiting = 0;
  await loadCentralCalendar({ render });
  await tick();
  assert.equal(gpsReads(calls).length, 2, "read again on the return");
  assert.equal(markOn(PDAY(2)), null, "nothing waiting any more: no mark");
});

// --- B3: the band's marker --------------------------------------------------------------

test("B3. Back to calendar belongs only to the step the mark pushed: claimed once, gone on any other step", () => {
  const before = { tab: "central-calendar" };
  const pushed = { tab: "central-calendar", n: 1 };
  const later = { tab: "training-load", n: 2 };
  gps.setImportsReturn({ day: D });
  assert.equal(gps.importsReturnFor(pushed), null, "nothing before the push claims it");
  gps.claimImportsReturn(pushed);
  gps.claimImportsReturn(later);
  assert.deepEqual(gps.importsReturnFor(pushed), { day: D, notChosen: false }, "the pushed step shows it");
  gps.setImportsReturnOutcome("as-is");
  assert.deepEqual(gps.importsReturnFor(pushed), { day: D, notChosen: true }, "Imports opened as it was: the band says the day was not chosen");
  gps.setImportsReturnOutcome("chosen");
  assert.deepEqual(gps.importsReturnFor(pushed), { day: D, notChosen: false });
  assert.equal(gps.importsReturnFor(later), null, "a later step does not");
  assert.equal(gps.importsReturnFor(before), null, "nor another step at that depth");
  gps.setImportsReturn({ day: "not-a-day" });
  assert.equal(gps.importsReturnFor(pushed), null, "a new entry (or none) replaces it");
});

// --- Source guards on app.js's K5-4 lines (app.js runs init() at import) -------------------------

const appJs = await readFile(path.resolve(__dirname, "../app.js"), "utf8");
function body(name) {
  const start = appJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const open = appJs.indexOf("{", appJs.indexOf(")", start));
  let depth = 0;
  for (let index = open; index < appJs.length; index += 1) {
    if (appJs[index] === "{") depth += 1;
    else if (appJs[index] === "}" && --depth === 0) return appJs.slice(open, index + 1);
  }
  return "";
}

test("G1. openImportsOnDay asks Training Load's leave question first, then the marker and ONE history step, then the module's entry", () => {
  const entry = body("openImportsOnDay");
  const ask = entry.indexOf("if (!confirmLeaveTrainingLoad(\"training-load\")) return;");
  const drop = entry.indexOf("clearGpsReview();");
  const marker = entry.indexOf("setImportsReturn({ day });");
  assert.ok(ask >= 0 && ask < drop && drop < marker, "the marks are dropped after the leave question (R7: the return reads them again)");
  const push = entry.indexOf("pushAppHistory();");
  const enter = entry.indexOf("await enterImportsOnDay({");
  assert.ok(ask >= 0 && ask < marker && marker < push && push < enter, "leave question, marker, push, entry - in that order");
  assert.equal(entry.split("pushAppHistory();").length - 1, 1, "one step");
  assert.match(entry, /phone: Boolean\(window\.matchMedia\?\.\(IMPORTS_PHONE_QUERY\)\?\.matches\)/);
  assert.match(appJs, /openImports: openImportsOnDay/, "the calendar's handler gets it");
});

test("G2. the band is drawn on every Training Load paint, its step is claimed on every push, and a sign-out drops the marks", () => {
  assert.match(body("renderTrainingLoad"), /renderImportsBackBand\(\);/);
  assert.match(body("renderImportsBackBand"), /importsReturnFor\(appHistoryTopEntry\(\)\)/);
  assert.match(body("pushAppHistory"), /claimImportsReturn\(entry\);/);
  assert.match(body("signOut"), /clearGpsReview\(\);/);
  assert.match(appJs, /action\.dataset\.action === "imports-back-to-calendar"[\s\S]{0,300}window\.history\.back\(\)/, "the band's click is the app's Back");
  const entry = body("openImportsOnDay");
  assert.match(entry, /const outcome = await enterImportsOnDay\(\{[\s\S]*\}\);\s*\/\/[^\n]*\n\s*setImportsReturnOutcome\(outcome\);\s*if \(state\.activeTab === "training-load"\) renderImportsBackBand\(\);/, "the entry's outcome reaches the band");
  assert.match(body("renderImportsBackBand"), /back\.notChosen \? `<p class="cc-imports-back-note" role="status">/, "a note only when the day was not chosen");
});

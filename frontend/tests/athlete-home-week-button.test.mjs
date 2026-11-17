// Athlete Home, one week (owner, 2026-11-16, item 2): the old "This week's training load" link is gone; Home's own
// "This week" row carries one button to the training-load sheet, named for what waits there.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const { athleteWeekWaitingCount, renderTrainingLoadWeekButtonHtml } = await import("../training-load-view.js");
const { renderAthleteHomeHtml } = await import("../athlete-home.js");
const { state, emptyTrainingLoadState } = await import("../state.js");

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const TODAY = shift(0);
const session = (rated) => ({ sessionId: `s-${Math.random()}`, sessionName: "Training", rated });
const weekOf = (byDay) => ({ days: Object.entries(byDay).map(([date, sessions]) => ({ date, sessions })) });

test("1. the waiting count: unrated sessions of today or earlier; a rated one and a future day's never count", () => {
  const week = weekOf({ [shift(-2)]: [session(false), session(true)], [TODAY]: [session(false)], [shift(1)]: [session(false)] });
  assert.equal(athleteWeekWaitingCount(week, TODAY), 2);
  assert.equal(athleteWeekWaitingCount(weekOf({ [shift(1)]: [session(false)] }), TODAY), 0);
  assert.equal(athleteWeekWaitingCount(null, TODAY), 0, "not loaded yet: nothing claimed");
});

test("2. the button says 'Rate your sessions (N)' while something waits, 'Your sessions' otherwise, and opens the sheet", () => {
  const waiting = renderTrainingLoadWeekButtonHtml({ data: weekOf({ [shift(-1)]: [session(false)], [TODAY]: [session(false)] }) });
  assert.match(waiting, /data-action="training-load-athlete-weekly-open"/);
  assert.match(waiting, />Rate your sessions \(2\) &rsaquo;</);
  assert.match(waiting, /is-waiting/);
  for (const homeWeek of [{ data: weekOf({ [TODAY]: [session(true)] }) }, { data: null }, undefined]) {
    const quiet = renderTrainingLoadWeekButtonHtml(homeWeek);
    assert.match(quiet, />Your sessions &rsaquo;</);
    assert.doesNotMatch(quiet, /is-waiting|Rate/);
  }
});

test("3. Home: one week strip, the button inside its 'This week' row, and no 'This week's training load' link", () => {
  state.trainingLoad = emptyTrainingLoadState();
  state.trainingLoad.athleteHomeWeek.data = weekOf({ [TODAY]: [session(false)] });
  const html = renderAthleteHomeHtml({ data: { athlete: { name: "Athlete" }, today: { date: TODAY }, week: { days: [{ date: TODAY, isToday: true }] } }, error: "" });
  assert.equal((html.match(/class="athlete-home-week-strip"/g) || []).length, 1, "one week strip");
  assert.doesNotMatch(html, /training-load-week-link|This week(?:'|&#039;)s training load/);
  const row = html.slice(html.indexOf('class="athlete-home-week-head"'), html.indexOf('class="athlete-home-week-strip"'));
  assert.match(row, /This week/);
  assert.match(row, /Rate your sessions \(1\)/);
});

test("4 (code review): a workspace switch clears Home's waiting count", async () => {
  const { resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
  state.trainingLoad = emptyTrainingLoadState();
  state.trainingLoad.athleteHomeWeek.data = weekOf({ [TODAY]: [session(false)] });
  resetTrainingLoadForWorkspaceChange();
  assert.equal(state.trainingLoad.athleteHomeWeek.data, null);
  assert.match(renderTrainingLoadWeekButtonHtml(state.trainingLoad.athleteHomeWeek), />Your sessions &rsaquo;</);
});

test("5 (code review): 'Rate your sessions' opens the sheet on the week's first day that waits; 'Your sessions' keeps the sheet's own week", async () => {
  const { handleTrainingLoadAction } = await import("../training-load-actions.js");
  const { weekMondayIso } = await import("../utils.js");
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ weekStart: weekMondayIso(TODAY), weekEnd: TODAY, days: [] }) });
  const first = shift(-1) >= weekMondayIso(TODAY) ? shift(-1) : TODAY;
  const html = renderTrainingLoadWeekButtonHtml({ data: weekOf({ [first]: [session(false)], [TODAY]: [session(false)] }) });
  assert.match(html, new RegExp(`data-first-waiting="${first}"`));
  state.trainingLoad = emptyTrainingLoadState();
  state.trainingLoad.athleteWeekly.weekStart = "2020-01-06";
  state.trainingLoad.athleteWeekly.selectedDate = "2020-01-08";
  await handleTrainingLoadAction({ dataset: { action: "training-load-athlete-weekly-open", firstWaiting: first } }, { renderTrainingLoad: () => {} });
  assert.equal(state.trainingLoad.athleteWeekly.weekStart, weekMondayIso(first));
  assert.equal(state.trainingLoad.athleteWeekly.selectedDate, first);
  assert.doesNotMatch(renderTrainingLoadWeekButtonHtml({ data: weekOf({ [TODAY]: [session(true)] }) }), /data-first-waiting/);
  state.trainingLoad.athleteWeekly.weekStart = "2020-01-06";
  state.trainingLoad.athleteWeekly.selectedDate = "2020-01-08";
  await handleTrainingLoadAction({ dataset: { action: "training-load-athlete-weekly-open" } }, { renderTrainingLoad: () => {} });
  assert.equal(state.trainingLoad.athleteWeekly.weekStart, "2020-01-06", "no waiting day: the sheet's own week");
});

test("6 (code review): after a saved rating Home's week is read again once Home has read it, and not otherwise", async () => {
  const { handleTrainingLoadAction } = await import("../training-load-actions.js");
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => (String(url).includes("/athlete/today") ? { date: TODAY, sessions: [] } : { weekStart: TODAY, weekEnd: TODAY, days: [] }) }; };
  const { clearAllViewCache } = await import("../view-cache.js");
  for (const [homeRead, expected] of [[false, 0], [true, 1]]) {
    calls.length = 0;
    clearAllViewCache(); // the save itself drops the rated week's cached read (submitRpeForm); this test starts after it
    state.trainingLoad = emptyTrainingLoadState();
    if (homeRead) state.trainingLoad.athleteHomeWeek.data = weekOf({ [TODAY]: [session(false)] });
    state.trainingLoad.rpeForm = { sessionId: "s1", savedFeedback: { rpe: 5, durationMinutes: 30, srpe: 150 } };
    await handleTrainingLoadAction({ dataset: { action: "training-load-close-rpe-form" } }, { renderTrainingLoad: () => {} });
    assert.equal(calls.filter((u) => u.includes("/api/training-load/weekly")).length, expected, `Home read before: ${homeRead}`);
  }
});

test("7 (UX review): an athlete's day with only a note shows the note, never 'Nothing planned' beside it", async () => {
  const { renderDayEntryHtml } = await import("../program-view.js");
  globalThis.document.body.classList.contains = (c) => c === "athlete-mode";
  try {
    const noted = renderDayEntryHtml({ date: TODAY, slots: {}, dayNote: "Match day" }, () => ({}));
    assert.match(noted, /Match day/);
    assert.doesNotMatch(noted, /Nothing planned/);
    assert.match(renderDayEntryHtml({ date: TODAY, slots: {}, dayNote: "" }, () => ({})), /Nothing planned/);
  } finally { globalThis.document.body.classList.contains = () => false; }
  assert.match(renderDayEntryHtml({ date: TODAY, slots: {}, dayNote: "" }, () => ({})), /No entries/, "a coach keeps No entries");
});

test("8 (code review of #583): a failed Home read stays said when the week's count or My training repaints Home", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function renderAthleteHomeFromCache()"), src.indexOf("\n}\n", src.indexOf("function renderAthleteHomeFromCache()")));
  assert.match(body, /error: data \? "" : state\.lastAthleteHomeError/);
  const home = src.slice(src.indexOf("function renderAthleteHome({ data, error })"), src.indexOf("\n}\n", src.indexOf("function renderAthleteHome({ data, error })")));
  assert.match(home, /state\.lastAthleteHomeError = data \? "" : error \|\| "";/);
  // And the view says it: an error with no data is the error, never "Loading your home...".
  const html = renderAthleteHomeHtml({ data: null, error: "Your home could not be loaded." });
  assert.match(html, /Your home could not be loaded\./);
  assert.doesNotMatch(html, /Loading your home/);
});

test("8b (code review): a new Home load forgets the last failure before it starts", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const start = src.indexOf("async function loadAthleteHome(");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(body, /state\.lastAthleteHomeError = "";[\s\S]*Promise\.all/);
});

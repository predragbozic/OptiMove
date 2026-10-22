import { beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// Coach Home redesign (owner, 2026-10-22): the day card's calendar (any day's
// athletes, the month's dots, a week on a phone), the athlete and library
// strips paged with arrows, and the Exercise and Program Library cards. The
// view, the data layer and Home's own actions run here against a jsdom page
// and a fake fetch; leaving Home (an athlete, a library) is app.js's.

const dom = new JSDOM("<!doctype html><body><div id=content></div></body>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
dom.window.requestAnimationFrame = (callback) => { callback(); return 1; };

const { state, emptyCoachHomeState } = await import("../state.js");
const { renderCoachHomeHtml, renderCoachHomeDayHtml, renderCoachHomeExercisesHtml, renderCoachHomeProgramsHtml } = await import("../coach-home.js");
const actions = await import("../coach-home-actions.js");
const data = await import("../coach-home-data.js");
const { addDaysIso, addMonthsIso, localDateIso, monthWeeksIso } = await import("../utils.js");
const { buildContextKey, clearAllViewCache, getCacheEntry, hasCachedData } = await import("../view-cache.js");
const { currentUserWorkspaceContextParts } = await import("../access.js");
const { invalidateTemplatesCache } = await import("../program-library-data.js");
const { fakeAction } = await import("./support/dom.mjs");
const { installFetchMock, restoreFetch } = await import("./support/fetch-mock.mjs");

after(() => restoreFetch());

const content = document.getElementById("content");
const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const roster = [
  { athleteId: "17", athleteUuid: "uuid-17", athlete: "Ana Test", hasTrainingToday: true, sessionCount: 1 },
  { athleteId: "18", athleteUuid: "uuid-18", athlete: "Marko Test", hasTrainingToday: false, sessionCount: 0 },
];
const exercise = (id) => ({ id: `ex-${id}`, name: `Exercise ${id}`, image_url: "", video_url: "" });

beforeEach(() => {
  clearAllViewCache();
  state.currentUser = { id: "coach", activeWorkspace: { type: "private_coach", scopeId: null } };
  state.activeTab = "coach-home";
  data.resetCoachHomeForWorkspaceChange();
  content.innerHTML = "";
});

function mount(rows = roster) {
  content.innerHTML = renderCoachHomeHtml({ rows, user: state.currentUser, home: state.coachHome });
  return content;
}

// The section refresher app.js passes to the loaders (refreshCoachHomeSection).
function onChange(section, appended) {
  actions.renderCoachHomeSection(content, section, { rows: roster, appended });
}

function stubTrack(track, { clientWidth, scrollWidth, scrollLeft = 0 }) {
  Object.defineProperty(track, "clientWidth", { configurable: true, get: () => clientWidth });
  Object.defineProperty(track, "scrollWidth", { configurable: true, get: () => scrollWidth });
  let left = scrollLeft;
  Object.defineProperty(track, "scrollLeft", { configurable: true, get: () => left, set: (value) => { left = value; } });
}

// --- The calendar's weeks -------------------------------------------------

test("monthWeeksIso gives whole Monday-first weeks with the neighbouring months' days, at most six", () => {
  const october = monthWeeksIso("2026-10");
  assert.equal(october.length, 5);
  assert.deepEqual(october[0], ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.equal(october.at(-1)[6], "2026-11-01");
  const august = monthWeeksIso("2026-08-15");
  assert.equal(august.length, 6, "a month across six weeks");
  assert.equal(august[0][0], "2026-07-27");
  assert.equal(august.at(-1)[6], "2026-09-06");
  assert.ok(monthWeeksIso("2027-02").every((week) => week.length === 7));
});

// --- The day card -----------------------------------------------------------

test("the calendar marks today, the chosen day, the days with a session and the week a phone shows", () => {
  const home = emptyCoachHomeState();
  home.days.counts = { "2026-10-20": 3, "2026-10-22": 1 };
  const page = new JSDOM(renderCoachHomeDayHtml({ rows: roster, home, today: "2026-10-22" })).window.document;
  const day = (iso) => page.querySelector(`[data-action="coach-home-day-select"][data-date="${iso}"]`);
  assert.equal(page.querySelector(".coach-home-cal-month").textContent, "October 2026");
  assert.equal(day("2026-10-22").getAttribute("aria-current"), "date");
  assert.equal(day("2026-10-22").getAttribute("aria-pressed"), "true");
  assert.ok(day("2026-10-22").classList.contains("is-selected"));
  assert.equal(day("2026-10-21").getAttribute("aria-pressed"), "false");
  assert.ok(day("2026-10-20").classList.contains("has-training"));
  assert.equal(day("2026-10-20").getAttribute("aria-label"), "Tuesday, 20 October 2026, 3 athletes with a session");
  assert.match(day("2026-10-22").getAttribute("aria-label"), /, today, 1 athlete with a session$/);
  assert.ok(!day("2026-10-21").classList.contains("has-training"));
  assert.ok(day("2026-09-28").classList.contains("is-outside"), "the previous month's days are shown, muted");
  assert.ok(page.querySelector("[data-cursor-week]").contains(day("2026-10-22")), "a phone shows the chosen day's week");
  assert.deepEqual([...page.querySelectorAll('[data-action="coach-home-calendar-step"]')].map((button) => `${button.dataset.step}${button.dataset.direction}`), ["month-1", "week-1", "week1", "month1"]);
  const toggle = page.querySelector('[data-action="coach-home-calendar-toggle"]');
  assert.equal(toggle.textContent, "Show month");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.match(page.querySelector("#coachHomeDayTitle").textContent, /^Today Thu 22 Oct$/);
  assert.equal(page.querySelector('[data-action="coach-home-day-today"]'), null, "no Today button on today");
});

test("another day: loading, then its athletes with that date, its own count, an error with Try again, and the way back to today", () => {
  const today = "2026-10-22";
  const home = emptyCoachHomeState();
  home.calendar = { selected: "2026-10-24", cursor: "2026-10-24", expanded: false };
  const render = () => new JSDOM(renderCoachHomeDayHtml({ rows: roster, home, today })).window.document;

  let page = render();
  assert.match(page.querySelector('[role="status"]').textContent, /Loading athletes/);
  assert.equal(page.querySelector(".coach-home-day-count"), null, "no count before the day's answer");
  assert.equal(page.querySelector("#coachHomeDayTitle").textContent, "Sat 24 Oct");
  assert.ok(page.querySelector('[data-action="coach-home-day-today"]'));
  assert.equal(page.querySelector('[data-date="2026-10-24"]').getAttribute("aria-pressed"), "true");

  home.day = { date: "2026-10-24", rows: [{ ...roster[1], hasTrainingToday: true, sessionCount: 2 }, { ...roster[0], hasTrainingToday: false, sessionCount: 0 }], loading: false, error: "" };
  page = render();
  assert.equal(page.querySelector(".coach-home-day-count").textContent, "1 / 2 athletes with a session");
  const rows = page.querySelectorAll('.coach-home-day-list [data-action="coach-home-open-athlete"]');
  assert.deepEqual([...rows].map((row) => [row.dataset.athleteId, row.dataset.mode, row.dataset.date]), [["18", "day", "2026-10-24"]]);
  assert.match(rows[0].textContent, /2 sessions/);
  assert.doesNotMatch(rows[0].textContent, /today/);

  home.day = { date: "2026-10-24", rows: [], loading: false, error: "<b>down</b>" };
  page = render();
  const alert = page.querySelector('[role="alert"]');
  assert.match(alert.textContent, /This day could not be loaded/);
  assert.equal(alert.querySelector(".builder-error").innerHTML, "&lt;b&gt;down&lt;/b&gt;");
  assert.ok(alert.querySelector('[data-action="coach-home-day-retry"]'));

  home.day = { date: "2026-10-24", rows: [roster[1]], loading: false, error: "" };
  assert.match(render().querySelector(".coach-home-day-list").textContent, /No athletes have a session scheduled on this day/);

  home.calendar.selected = "2027-01-04";
  home.day = { date: "2027-01-04", rows: roster, loading: false, error: "" };
  assert.equal(render().querySelector("#coachHomeDayTitle").textContent, "Mon, 4 Jan 2027", "another year names the year");
});

test("the day's athletes: one strip named by its date, the month's dots failing says so, and Today shows once the calendar moved", () => {
  const today = "2026-10-22";
  const home = emptyCoachHomeState();
  const busy = Array.from({ length: 7 }, (_, index) => ({ athleteId: String(200 + index), athleteUuid: `u-${index}`, athlete: `Name ${index}`, hasTrainingToday: true, sessionCount: 1 }));
  let page = new JSDOM(renderCoachHomeDayHtml({ rows: busy, home, today })).window.document;
  const track = page.querySelector('[data-coach-home-track="day"]');
  assert.equal(track.dataset.coachHomeTrackKey, today);
  assert.equal(track.querySelectorAll('[data-action="coach-home-open-athlete"]').length, 7);
  assert.equal(track.querySelectorAll("li.is-beyond-list").length, 1);
  assert.deepEqual([...page.querySelectorAll('.coach-home-day-list [data-action="coach-home-scroll"]')].map((arrow) => arrow.dataset.track), ["day", "day"]);
  assert.equal(track.querySelector("small").textContent, "1 session");

  home.days = { from: "2026-09-28", to: "2026-11-01", counts: {}, error: "offline" };
  page = new JSDOM(renderCoachHomeDayHtml({ rows: busy, home, today })).window.document;
  const note = page.querySelector(".coach-home-cal-note");
  assert.equal(note.getAttribute("role"), "alert");
  assert.match(note.textContent, /Training days could not be shown\./);
  assert.ok(note.querySelector('[data-action="coach-home-days-retry"]'));
  home.days = { from: "2026-08-31", to: "2026-10-04", counts: {}, error: "offline" };
  assert.equal(new JSDOM(renderCoachHomeDayHtml({ rows: busy, home, today })).window.document.querySelector(".coach-home-cal-note"), null, "another month's failure is not this month's");

  home.calendar = { selected: "", cursor: "2026-11-19", expanded: false };
  page = new JSDOM(renderCoachHomeDayHtml({ rows: busy, home, today })).window.document;
  assert.match(page.querySelector("#coachHomeDayTitle").textContent, /^Today/);
  assert.ok(page.querySelector('[data-action="coach-home-day-today"]'), "the calendar moved away from today: one tap back");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 600px) {\n  .coach-home-panel"));
  assert.match(phone, /\.coach-home-day-list \.coach-home-track \{ display: flex; overflow-x: auto;/, "a phone pages the day's athletes sideways");
  assert.match(phone, /\.coach-home-day-show-all \{ display: none; \}/, "and needs no Show all there");
  assert.match(css, /\.coach-home-day-list \.coach-home-track > li\.is-beyond-list \{ display: none; \}/, "a computer lists six");
});

// --- The library cards --------------------------------------------------------

test("the Exercise and Program Library cards: loading, error with Try again, empty, and their strips", () => {
  const parse = (html) => new JSDOM(html).window.document;
  const exercises = emptyCoachHomeState().exercises;
  let page = parse(renderCoachHomeExercisesHtml(exercises));
  const title = page.querySelector('[data-action="coach-home-open-library"]');
  assert.equal(title.dataset.library, "exercises");
  assert.match(title.textContent, /Exercise Library/);
  assert.match(page.querySelector('[role="status"]').textContent, /Loading exercises/);

  page = parse(renderCoachHomeExercisesHtml({ ...exercises, error: "offline" }));
  assert.equal(page.querySelector('[data-action="coach-home-library-retry"]').dataset.library, "exercises");
  assert.match(page.querySelector('[role="alert"]').textContent, /Exercises could not be loaded\.\s*offline/);

  page = parse(renderCoachHomeExercisesHtml({ ...exercises, loaded: true }));
  assert.match(page.body.textContent, /No exercises in your library yet/);
  assert.equal(page.querySelector("[data-coach-home-track]"), null);

  page = parse(renderCoachHomeExercisesHtml({ ...exercises, loaded: true, items: [exercise(1), { ...exercise(2), name: "<img src=x>" }], hasMore: true, loadingMore: true }));
  const items = page.querySelectorAll('[data-action="coach-home-open-exercise"]');
  assert.deepEqual([...items].map((item) => item.dataset.exerciseId), ["ex-1", "ex-2"]);
  assert.equal(items[1].querySelector(".coach-home-strip-label").textContent, "<img src=x>", "a name is text, never markup");
  assert.equal(page.querySelector(".coach-home-strip-label img"), null);
  assert.match(page.querySelector("[data-coach-home-more]").textContent, /Loading more/);
  page = parse(renderCoachHomeExercisesHtml({ ...exercises, loaded: true, items: [exercise(1)], hasMore: true, moreError: "x" }));
  const more = page.querySelector('[data-coach-home-more] [role="alert"]');
  assert.match(more.textContent, /More exercises could not be loaded\./, "a failed further page says so");
  assert.equal(more.querySelector('[data-action="coach-home-exercises-more"]').textContent, "Try again");

  const programs = { items: [{ plan_id: "p1", plan_name: "Pre-season block", cover_image_url: "https://example.com/cover.jpg" }, { plan_id: "p2", plan_name: "Speed work", cover_image_url: "" }], loaded: true, loading: false, error: "" };
  page = parse(renderCoachHomeProgramsHtml(programs));
  assert.equal(page.querySelector('[data-action="coach-home-open-library"]').dataset.library, "programs");
  const cards = page.querySelectorAll('[data-action="coach-home-open-program"]');
  assert.deepEqual([...cards].map((card) => card.dataset.templateId), ["p1", "p2"]);
  assert.ok(cards[0].querySelector("img.coach-home-strip-thumb"));
  assert.equal(cards[1].querySelector(".coach-home-strip-initials").textContent, "SW", "no cover: the program's initials");
  assert.match(parse(renderCoachHomeProgramsHtml({ ...programs, items: [] })).body.textContent, /No programs in My Programs yet/);
});

test("an empty roster and a failed roster still show the two library cards", () => {
  for (const options of [{ rows: [] }, { rows: [], error: "down" }]) {
    const page = new JSDOM(renderCoachHomeHtml({ ...options, user: state.currentUser })).window.document;
    assert.ok(page.querySelector('[data-coach-home-section="exercises"]'));
    assert.ok(page.querySelector('[data-coach-home-section="programs"]'));
    assert.equal(page.querySelector(".coach-home-day"), null);
  }
  const platform = renderCoachHomeHtml({ rows: [], user: { activeWorkspace: { type: "platform" }, availableWorkspaces: [] } });
  assert.doesNotMatch(platform, /coach-home-section|coach-home-panel/, "platform administration keeps its workspace list only");
});

// --- Loading Home's extras ----------------------------------------------------

test("Home loads the month's dots, the first exercise page and My Programs - no day read while today is chosen", async () => {
  const calls = installFetchMock((call) => {
    if (call.url.startsWith("/api/athletes/training-days")) return { body: { days: [{ date: localDateIso(), athleteCount: 2 }] } };
    if (call.url.startsWith("/api/exercises")) return { body: { exercises: [exercise(1)], hasMore: false } };
    if (call.url.startsWith("/api/templates")) return { body: { templates: [{ plan_id: "p1", plan_name: "Block" }] } };
    return { status: 404, body: { error: "unexpected" } };
  });
  await data.loadCoachHomeExtras({ onChange: () => {} });
  const weeks = monthWeeksIso(localDateIso().slice(0, 7));
  assert.deepEqual(calls.map((call) => call.url).sort(), [
    "/api/exercises?search=&limit=12&searchIn=name&kind=accessible",
    `/api/athletes/training-days?from=${weeks[0][0]}&to=${weeks.at(-1)[6]}`,
    "/api/templates?scope=my_programs",
  ].sort());
  assert.deepEqual(state.coachHome.days.counts, { [localDateIso()]: 2 });
  assert.deepEqual(state.coachHome.exercises.items.map((item) => item.id), ["ex-1"]);
  assert.equal(state.coachHome.programs.items[0].plan_id, "p1");

  // The program strip is the Program Library's own "My Programs" entry: a
  // program change there (invalidateTemplatesCache) clears Home's copy too.
  const key = buildContextKey([...currentUserWorkspaceContextParts(), "my_programs"]);
  assert.ok(hasCachedData(getCacheEntry("templates", key)));
  invalidateTemplatesCache();
  assert.equal(hasCachedData(getCacheEntry("templates", key)), false);

  await data.loadCoachHomeExtras({ onChange: () => {} });
  assert.equal(calls.filter((call) => call.url.startsWith("/api/templates")).length, 2, "invalidated: read again");
  assert.equal(calls.filter((call) => call.url.startsWith("/api/athletes/training-days")).length, 1, "fresh: not read again");
});

test("choosing a day reads that day once, draws its athletes, and a late answer for a day already left never replaces it", async () => {
  const today = localDateIso();
  const first = addDaysIso(today, 2);
  const second = addDaysIso(today, 3);
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = installFetchMock(async (call) => {
    if (call.url === `/api/athletes/today?date=${first}`) { await firstGate; return { body: { date: first, rows: [{ ...roster[1], athlete: "Late Answer", hasTrainingToday: true, sessionCount: 1 }] } }; }
    if (call.url === `/api/athletes/today?date=${second}`) return { body: { date: second, rows: [{ ...roster[0], hasTrainingToday: true, sessionCount: 3 }, roster[1]] } };
    if (call.url.startsWith("/api/athletes/training-days")) return { body: { days: [] } };
    return { status: 404, body: {} };
  });
  mount();
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-day-select", date: first }), { root: content, onChange });
  assert.equal(state.coachHome.calendar.selected, first);
  assert.match(content.querySelector(".coach-home-day-list").textContent, /Loading athletes/);
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-day-select", date: second }), { root: content, onChange });
  await flush();
  assert.match(content.querySelector(".coach-home-day-list").textContent, /Ana Test/);
  assert.match(content.querySelector(".coach-home-day-count").textContent, /1 \/ 2 athletes with a session/);
  releaseFirst();
  await flush();
  assert.equal(state.coachHome.day.date, second);
  assert.doesNotMatch(content.querySelector(".coach-home-day-list").textContent, /Late Answer/);
  assert.equal(calls.filter((call) => call.url === `/api/athletes/today?date=${second}`).length, 1);

  // Back to today: the roster read already answers it, nothing is sent.
  const before = calls.length;
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-day-today" }), { root: content, onChange });
  await flush();
  assert.equal(state.coachHome.calendar.selected, "");
  assert.equal(calls.filter((call) => call.url.startsWith("/api/athletes/today")).length, calls.filter((call, index) => index < before && call.url.startsWith("/api/athletes/today")).length);
  assert.match(content.querySelector("#coachHomeDayTitle").textContent, /^Today/);
  // Not a real date: nothing changes.
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-day-select", date: "2026-10-22T00:00" }), { root: content, onChange });
  assert.equal(state.coachHome.calendar.selected, "");
});

test("the arrows move the calendar by a month (desktop) or a week (phone); Show month and Show week keep the chosen day in view", async () => {
  const calls = installFetchMock((call) => (call.url.startsWith("/api/athletes/training-days") ? { body: { days: [] } } : { status: 404, body: {} }));
  const today = localDateIso();
  mount();
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-calendar-step", step: "month", direction: "1" }), { root: content, onChange });
  await flush();
  const nextMonth = addMonthsIso(today, 1);
  assert.equal(state.coachHome.calendar.cursor, nextMonth);
  assert.equal(state.coachHome.calendar.selected, "", "moving the calendar never changes the chosen day");
  const weeks = monthWeeksIso(nextMonth.slice(0, 7));
  assert.ok(calls.some((call) => call.url === `/api/athletes/training-days?from=${weeks[0][0]}&to=${weeks.at(-1)[6]}`), "the new month's dots");
  assert.equal(content.querySelector(".coach-home-cal-month").textContent, new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(`${nextMonth}T12:00:00`)));

  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-calendar-step", step: "week", direction: "1" }), { root: content, onChange });
  await flush();
  assert.equal(state.coachHome.calendar.cursor, addDaysIso(nextMonth, 7));
  assert.ok(content.querySelector(`[data-cursor-week] [data-date="${addDaysIso(nextMonth, 7)}"]`));

  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-calendar-toggle" }), { root: content, onChange });
  let toggle = content.querySelector('[data-action="coach-home-calendar-toggle"]');
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.textContent, "Show week");
  assert.ok(content.querySelector(".coach-home-cal.is-expanded"));

  // The chosen day (today) is not in the month on screen: the week stays.
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-calendar-toggle" }), { root: content, onChange });
  assert.equal(state.coachHome.calendar.cursor, addDaysIso(nextMonth, 7));
  toggle = content.querySelector('[data-action="coach-home-calendar-toggle"]');
  assert.equal(toggle.textContent, "Show month");

  // A day chosen in the month on screen: after the month view, Show week
  // goes back to its week.
  const chosen = addDaysIso(nextMonth, 20);
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-day-select", date: chosen }), { root: content, onChange });
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-calendar-step", step: "month", direction: "-1" }), { root: content, onChange });
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-calendar-step", step: "month", direction: "1" }), { root: content, onChange });
  assert.equal(state.coachHome.calendar.cursor, nextMonth);
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-calendar-toggle" }), { root: content, onChange });
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-calendar-toggle" }), { root: content, onChange });
  assert.equal(state.coachHome.calendar.cursor, chosen);
  assert.ok(content.querySelector(`[data-cursor-week] [data-date="${chosen}"]`));
});

test("choosing a day from the month view folds it back to that day's week, a failed month's dots read again on Try again, and a new day starts its strip at the beginning", async () => {
  let failDays = true;
  const calls = installFetchMock((call) => {
    if (call.url.startsWith("/api/athletes/training-days")) return failDays ? { status: 500, body: { error: "busy" } } : { body: { days: [] } };
    return { body: { rows: roster } };
  });
  const today = localDateIso();
  mount();
  await data.loadCoachHomeTrainingDays({ onChange });
  assert.ok(content.querySelector('.coach-home-cal-note [data-action="coach-home-days-retry"]'));
  failDays = false;
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-days-retry" }), { root: content, onChange });
  await flush();
  assert.equal(calls.filter((call) => call.url.startsWith("/api/athletes/training-days")).length, 2);
  assert.equal(content.querySelector(".coach-home-cal-note"), null);

  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-calendar-toggle" }), { root: content, onChange });
  assert.equal(state.coachHome.calendar.expanded, true);
  const week = monthWeeksIso(today.slice(0, 7)).find((days) => days.includes(today));
  const other = week.find((day) => day !== today);
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-day-select", date: other }), { root: content, onChange });
  await flush();
  assert.equal(state.coachHome.calendar.expanded, false);
  assert.ok(content.querySelector(`[data-cursor-week] [data-date="${other}"]`));

  // A redraw keeps a strip's scroll only for the same contents: the day
  // strip of another date starts at its first athlete.
  const strips = (dayKey) => new JSDOM(`<div><ul data-coach-home-track="day" data-coach-home-track-key="${dayKey}"></ul><ul data-coach-home-track="plan"></ul></div>`).window.document.body.firstElementChild;
  const before = strips("2026-10-22");
  before.querySelectorAll("ul").forEach((ul) => stubTrack(ul, { clientWidth: 300, scrollWidth: 900, scrollLeft: 120 }));
  const snapshot = actions.captureCoachHomeView(before);
  for (const [dayKey, expected] of [["2026-10-23", 0], ["2026-10-22", 120]]) {
    const after = strips(dayKey);
    after.querySelectorAll("ul").forEach((ul) => stubTrack(ul, { clientWidth: 300, scrollWidth: 900, scrollLeft: 0 }));
    actions.restoreCoachHomeView(after, snapshot);
    assert.equal(after.querySelector('[data-coach-home-track="day"]').scrollLeft, expected, dayKey);
    assert.equal(after.querySelector('[data-coach-home-track="plan"]').scrollLeft, 120);
  }
});

test("an invalidated exercise strip the coach had paged is replaced, clears its loading state and pages again", async () => {
  state.coachHome.exercises = { ...state.coachHome.exercises, items: Array.from({ length: 24 }, (_, index) => exercise(index + 1)), hasMore: true, loaded: true };
  const calls = installFetchMock((call) => {
    const offset = Number(new URL(call.url, "http://home.test").searchParams.get("offset"));
    return { body: { exercises: offset ? [exercise(offset + 1)] : [{ ...exercise(1), name: "Renamed" }], hasMore: true } };
  });
  await data.loadCoachHomeExercises({ onChange: () => {} });
  assert.equal(state.coachHome.exercises.items.length, 1);
  assert.equal(state.coachHome.exercises.items[0].name, "Renamed");
  assert.equal(state.coachHome.exercises.loading, false);
  await data.loadMoreCoachHomeExercises({ onChange: () => {} });
  assert.equal(calls.at(-1).url, "/api/exercises?search=&limit=12&searchIn=name&kind=accessible&offset=1");
});

test("a calendar redraw keeps the keyboard on the day it chose, and Today hands it to the chosen day", async () => {
  installFetchMock((call) => (call.url.startsWith("/api/athletes/") ? { body: { rows: roster, days: [] } } : { status: 404, body: {} }));
  const today = localDateIso();
  const target = monthWeeksIso(today.slice(0, 7)).find((week) => week.includes(today)).find((day) => day !== today);
  mount();
  const button = content.querySelector(`[data-action="coach-home-day-select"][data-date="${target}"]`);
  button.focus();
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-day-select", date: target }), { root: content, onChange });
  await flush();
  assert.notEqual(document.activeElement, button, "the card was drawn anew");
  assert.equal(document.activeElement.dataset.date, target);
  assert.equal(document.activeElement.getAttribute("aria-pressed"), "true");

  content.querySelector('[data-action="coach-home-day-today"]').focus();
  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-day-today" }), { root: content, onChange });
  assert.equal(document.activeElement.dataset.date, localDateIso(), "the Today button is gone; the keyboard lands on today");
});

// --- The strips ---------------------------------------------------------------

test("the arrows follow the strip: dimmed at either end, hidden when everything fits, and they page by one strip width", () => {
  mount();
  const carousel = content.querySelector('[data-coach-home-carousel="plan"]');
  const track = carousel.querySelector("[data-coach-home-track]");
  const [previous, next] = carousel.querySelectorAll('[data-action="coach-home-scroll"]');
  stubTrack(track, { clientWidth: 300, scrollWidth: 900 });
  actions.syncCoachHomeCarousel(carousel);
  assert.deepEqual([previous.getAttribute("aria-disabled"), next.getAttribute("aria-disabled")], ["true", "false"]);
  assert.ok(!carousel.classList.contains("is-static"));
  track.scrollLeft = 300;
  actions.syncCoachHomeCarousel(carousel);
  assert.deepEqual([previous.getAttribute("aria-disabled"), next.getAttribute("aria-disabled")], ["false", "false"]);
  track.scrollLeft = 600;
  actions.syncCoachHomeCarousel(carousel);
  assert.equal(next.getAttribute("aria-disabled"), "true");
  assert.equal(next.hasAttribute("disabled"), false, "never disabled: a focused arrow keeps the focus");

  const scrolled = [];
  track.scrollBy = (options) => scrolled.push(options);
  actions.handleCoachHomeAction(next, { root: content, onChange });
  assert.deepEqual(scrolled, [], "an arrow at the end does nothing");
  actions.handleCoachHomeAction(previous, { root: content, onChange });
  assert.deepEqual(scrolled, [{ left: -300, behavior: "smooth" }]);

  stubTrack(track, { clientWidth: 300, scrollWidth: 300 });
  actions.syncCoachHomeCarousel(carousel);
  assert.ok(carousel.classList.contains("is-static"), "every athlete fits: no arrows");

  actions.handleCoachHomeAction(fakeAction({ action: "coach-home-scroll", track: "unknown", direction: "1" }, { getAttribute: () => "false" }), { root: content, onChange });
});

test("near the end of the exercise strip the next page is appended in place (offset, no duplicate), and a failure offers it again", async () => {
  state.coachHome.exercises = { ...state.coachHome.exercises, items: Array.from({ length: 12 }, (_, index) => exercise(index + 1)), hasMore: true, loaded: true };
  let fail = false;
  // A page from the offset, starting with the last exercise already listed
  // (a row added meanwhile shifts the pages by one).
  const calls = installFetchMock((call) => {
    if (fail) return { status: 500, body: { error: "busy" } };
    const offset = Number(new URL(call.url, "http://home.test").searchParams.get("offset"));
    return { body: { exercises: Array.from({ length: 12 }, (_, index) => exercise(offset + index)), hasMore: true } };
  });
  mount();
  const track = content.querySelector('[data-coach-home-track="exercises"]');
  stubTrack(track, { clientWidth: 400, scrollWidth: 1600, scrollLeft: 0 });
  const nearEnd = [];
  actions.bindCoachHomeCarousels(content, { onNearEnd: (name) => { if (name === "exercises") nearEnd.push(name); } });
  assert.deepEqual(nearEnd, [], "far from the end: nothing is fetched");
  track.scrollLeft = 900;
  track.dispatchEvent(new dom.window.Event("scroll"));
  assert.deepEqual(nearEnd, ["exercises"]);

  await data.loadMoreCoachHomeExercises({ onChange });
  assert.equal(calls[0].url, "/api/exercises?search=&limit=12&searchIn=name&kind=accessible&offset=12");
  assert.equal(content.querySelector('[data-coach-home-track="exercises"]'), track, "appended to the same strip, never redrawn");
  assert.equal(track.querySelectorAll('[data-action="coach-home-open-exercise"]').length, 23, "the repeated exercise is listed once");
  assert.equal(track.querySelector("[data-coach-home-more]"), null);

  fail = true;
  await data.loadMoreCoachHomeExercises({ onChange });
  const retry = track.querySelector('[data-coach-home-more] [data-action="coach-home-exercises-more"]');
  assert.ok(retry);
  fail = false;
  retry.focus();
  actions.handleCoachHomeAction(retry, { root: content, onChange });
  await flush();
  assert.equal(calls.at(-1).url, "/api/exercises?search=&limit=12&searchIn=name&kind=accessible&offset=23");
  assert.equal(track.querySelector("[data-coach-home-more]"), null);
  assert.equal(track.querySelectorAll('[data-action="coach-home-open-exercise"]').length, 34);
  assert.equal(document.activeElement?.dataset.exerciseId, "ex-24", "the keyboard moves to the first new exercise");
});

test("a workspace switch drops a further exercise page that answers late, and a Home invalidation clears every day read", async () => {
  state.coachHome.exercises = { ...state.coachHome.exercises, items: [exercise(1)], hasMore: true, loaded: true };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  installFetchMock(async () => { await gate; return { body: { exercises: [exercise(2)], hasMore: false } }; });
  const pending = data.loadMoreCoachHomeExercises({ onChange: () => {} });
  data.resetCoachHomeForWorkspaceChange();
  release();
  await pending;
  assert.deepEqual(state.coachHome.exercises.items, []);

  installFetchMock((call) => ({ body: call.url.includes("training-days") ? { days: [] } : { rows: roster } }));
  const day = addDaysIso(localDateIso(), 5);
  state.coachHome.calendar = { selected: day, cursor: day, expanded: false };
  await data.loadCoachHomeDay(day, { onChange: () => {} });
  await data.loadCoachHomeTrainingDays({ onChange: () => {} });
  const dayKey = buildContextKey([...currentUserWorkspaceContextParts(), day]);
  const range = data.coachHomeGridRange();
  const daysKey = buildContextKey([...currentUserWorkspaceContextParts(), range.from, range.to]);
  assert.ok(hasCachedData(getCacheEntry("coach-home-day", dayKey)));
  assert.ok(hasCachedData(getCacheEntry("coach-home-days", daysKey)));
  data.invalidateCoachHomeCache();
  assert.equal(hasCachedData(getCacheEntry("coach-home-day", dayKey)), false);
  assert.equal(hasCachedData(getCacheEntry("coach-home-days", daysKey)), false);
});

test("strip pictures load lazily, every strip stays a named list, and the same answer twice leaves a card alone", () => {
  const withPicture = [{ ...roster[0], athleteImageUrl: "https://example.com/ana.jpg" }, roster[1]];
  const page = new JSDOM(renderCoachHomeHtml({ rows: withPicture, user: state.currentUser })).window.document;
  const pictures = page.querySelectorAll(".coach-home-panel-plan img, .coach-home-day img");
  assert.ok(pictures.length >= 2);
  for (const picture of pictures) {
    assert.equal(picture.getAttribute("loading"), "lazy");
    assert.equal(picture.getAttribute("decoding"), "async");
  }
  const cover = new JSDOM(renderCoachHomeProgramsHtml({ items: [{ plan_id: "p1", plan_name: "Block", cover_image_url: "https://example.com/cover.jpg" }], loaded: true, loading: false, error: "" })).window.document.querySelector("img");
  assert.equal(cover.getAttribute("loading"), "lazy");
  for (const track of page.querySelectorAll("[data-coach-home-track]")) {
    assert.equal(track.getAttribute("role"), "list");
    assert.ok(track.getAttribute("aria-label"));
  }
  const names = [...page.querySelectorAll('[data-action="coach-home-scroll"]')].map((arrow) => arrow.getAttribute("aria-label"));
  assert.equal(new Set(names).size, names.length, "every arrow says which strip it moves");

  state.coachHome.programs = { items: [{ plan_id: "p1", plan_name: "Block", cover_image_url: "" }], loaded: true, loading: false, error: "" };
  mount();
  actions.renderCoachHomeSection(content, "programs", { rows: roster });
  const drawn = content.querySelector('[data-coach-home-section="programs"]');
  actions.renderCoachHomeSection(content, "programs", { rows: roster });
  assert.equal(content.querySelector('[data-coach-home-section="programs"]'), drawn, "unchanged: not redrawn");
  state.coachHome.programs = { ...state.coachHome.programs, items: [{ plan_id: "p2", plan_name: "Other", cover_image_url: "" }] };
  actions.renderCoachHomeSection(content, "programs", { rows: roster });
  assert.notEqual(content.querySelector('[data-coach-home-section="programs"]'), drawn);
  assert.ok(content.querySelector('[data-template-id="p2"]'));
});

test("a strip extended in place is drawn again when the exercises go back to their first page", () => {
  const first = Array.from({ length: 12 }, (_, index) => exercise(index + 1));
  state.coachHome.exercises = { ...state.coachHome.exercises, items: first, hasMore: true, loaded: true };
  mount();
  actions.renderCoachHomeSection(content, "exercises", { rows: roster });
  const more = Array.from({ length: 12 }, (_, index) => exercise(index + 13));
  state.coachHome.exercises = { ...state.coachHome.exercises, items: [...first, ...more] };
  actions.renderCoachHomeSection(content, "exercises-more", { rows: roster, appended: more });
  assert.equal(content.querySelectorAll('[data-action="coach-home-open-exercise"]').length, 24);
  state.coachHome.exercises = { ...state.coachHome.exercises, items: first };
  actions.renderCoachHomeSection(content, "exercises", { rows: roster });
  assert.equal(content.querySelectorAll('[data-action="coach-home-open-exercise"]').length, 12);
});

// --- Leaving Home (app.js) ------------------------------------------------------

test("app.js: a library title opens the library the menu's way, an exercise or a program opens in it, and a workspace switch resets Home", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const block = (start, length = 900) => app.slice(app.indexOf(start), app.indexOf(start) + length);
  assert.match(block('if (type === "coach-home-open-library")'), /openLibraryTab\(action\.dataset\.library === "programs" \? \{ libraryTab: "templates", templateScope: "my_programs" \} : \{ libraryTab: "exercises" \}\)/);
  const openExercise = block('if (type === "coach-home-open-exercise")');
  assert.match(openExercise, /openLibraryTab\(\{ libraryTab: "exercises" \}\)/);
  assert.match(openExercise, /pushAppHistory\(\);\s*await renderExerciseDetail\(/);
  assert.match(block('if (type === "coach-home-open-program")'), /openTemplatePreviewFromCoachProgram\(template,/);
  assert.match(block('if (type === "coach-home-open-athlete")', 2600), /action\.dataset\.mode === "day"\) await openWeeklyPlanOnDate\(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(action\.dataset\.date/);
  assert.match(block("async function onWorkspaceChanged() {", 700), /resetCoachHomeForWorkspaceChange\(\);/);
  assert.match(block("els.libraryTabs.forEach((button) => {", 200), /openLibraryTab\(button\.dataset\)/);
  assert.match(block("function loadMoreCoachHomeOnNearEnd(track) {", 200), /track === "exercises" && !state\.coachHome\.exercises\.moreError\)/, "after a failed page only Try again loads it again");
});

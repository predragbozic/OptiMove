// K2b-1e: the athlete's Upcoming events on Home (docs/ai/central-calendar-k2b-plan.md section 22, D28, the manager's
// decisions in 22.7). Through the real loader (athlete-home-events-data.js), the real handlers
// (athlete-home-events-actions.js) and the real templates (athlete-home-events-view.js, athlete-home.js), with a fake
// fetch that answers her GET /api/calendar in the shape of the athlete's event card (backend/src/calendarQuery.js
// publicCard, the athlete branch; pinned key by key by central-calendar-k2b-event-details.test.mjs).
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

const data = await import("../athlete-home-events-data.js");
const { handleAthleteHomeEventsAction } = await import("../athlete-home-events-actions.js");
const { renderAthleteHomeEventsHtml } = await import("../athlete-home-events-view.js");
const { renderAthleteHomeHtml } = await import("../athlete-home.js");
const { state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");

const {
  ATHLETE_HOME_EVENT_ROW_KEYS, ATHLETE_HOME_EVENTS_LIMIT, athleteHomeEventRows, loadAthleteHomeEvents, resetAthleteHomeEvents,
} = data;

// A Wednesday: Thursday 19 Nov is Tomorrow.
const TODAY = "2026-11-18";
const ATHLETE = { id: "u-athlete", activeWorkspace: { type: "athlete", scopeId: null } };
const MAPS = (address) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

after(() => restoreFetch());

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// One of her cards, exactly the athlete branch's keys (plus `extra` when a test adds fields the server must never send
// her, to prove the list never shows them).
function card({ id, date, title = "Event", eventKind = "match", eventTypeLabel = "Match", span = null, startTime = null, endTime = null, place = null, location = null, cancelled = false, extra = {} }) {
  return {
    key: `event:${id}:${date}`, kind: "event", date, title, eventKind, eventTypeLabel,
    span: span || { from: date, to: date }, startTime, endTime, location, place,
    status: cancelled ? "cancelled" : "planned", cancelled, teamIds: ["team-1"], links: { eventId: id }, ...extra,
  };
}

// The calendar answer: the 14 days of the window, each with its cards.
function answer(cards, today = TODAY) {
  const days = [];
  for (let i = 0; i < 14; i += 1) {
    const date = addDays(today, i);
    days.push({ date, items: cards.filter((c) => c.date === date) });
  }
  return { from: today, to: addDays(today, 13), today, workspace: { type: "athlete", scopeId: null }, teams: [{ teamId: "team-1", name: "First team" }], days };
}

function calendarServer(responder) {
  return installFetchMock(async (call) => {
    if (!String(call.url).startsWith("/api/calendar?")) return { status: 404, body: { error: "notFound" } };
    return responder(call);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// The page: Home's section painted into a real DOM, as app.js's renderAthleteHomeFromCache does.
let dom;
let renders = 0;
function render() {
  renders += 1;
  dom.window.document.body.innerHTML = renderAthleteHomeEventsHtml(state.athleteHomeEvents);
}
const $ = (sel) => dom.window.document.querySelector(sel);
const $$ = (sel) => [...dom.window.document.querySelectorAll(sel)];
const rowTexts = () => $$(".athlete-home-event").map((li) => li.textContent.replace(/\s+/g, " ").trim());

beforeEach(() => {
  clearAllViewCache();
  resetAthleteHomeEvents();
  state.currentUser = ATHLETE;
  dom = new JSDOM("<!doctype html><body></body>");
  globalThis.document = dom.window.document;
  renders = 0;
});

const load = (opts = {}) => loadAthleteHomeEvents({ render, today: TODAY, ...opts });

test("E1. one GET /api/calendar for today and the 13 days after it, kinds=event, her date as today; nothing else is read", async () => {
  const calls = calendarServer(() => ({ status: 200, body: answer([]) }));
  await load();
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url, "http://x");
  assert.equal(url.pathname, "/api/calendar");
  assert.deepEqual(Object.fromEntries(url.searchParams), { from: TODAY, to: "2026-12-01", today: TODAY, kinds: "event" });
  assert.equal(calls[0].method, "GET");
});

test("E2. the explicit pick: notes, details, athletes, a type id, canManage, a value or a place id never reach the row or the screen", async () => {
  const leak = {
    notes: "Internal coach note", details: { selected: 3, filled: 1 }, athletes: [{ athleteId: "a-2", name: "Teammate Tina" }],
    eventTypeId: "type-uuid-1", canManage: true, value: "secret-value-42", expects: ["rpe"], revision: 7, alignment: { pending: 2 },
  };
  calendarServer(() => ({ status: 200, body: answer([
    card({ id: "e1", date: TODAY, title: "Cup match", startTime: "18:00:00", endTime: "19:30:00", place: { source: "library", locationId: "loc-uuid-9", name: "City Stadium", address: "Main street 1", note: "Gate B", extraPlaceField: "hidden-place-thing" }, extra: leak }),
  ]) }));
  await load();
  const rows = state.athleteHomeEvents.rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), ATHLETE_HOME_EVENT_ROW_KEYS);
  assert.deepEqual(Object.keys(rows[0].place), ["source", "name", "address", "note"]);
  const html = dom.window.document.body.innerHTML;
  for (const word of ["Internal coach note", "Teammate Tina", "a-2", "type-uuid-1", "secret-value-42", "loc-uuid-9", "hidden-place-thing", "e1", "team-1", "rpe"]) {
    assert.equal(html.includes(word), false, `"${word}" must not reach the screen`);
  }
  assert.match(rowTexts()[0], /Cup match/);
  assert.match(rowTexts()[0], /City Stadium/);
});

test("E3. one row per event: a three-day event's three cards are one row with its days; one that began before today shows its real first day; the order", async () => {
  const camp = { from: "2026-11-20", to: "2026-11-22" };
  const trip = { from: "2026-11-16", to: "2026-11-19" };
  calendarServer(() => ({ status: 200, body: answer([
    card({ id: "trip", date: TODAY, title: "Away trip", eventKind: "travel", eventTypeLabel: "Travel", span: trip }),
    card({ id: "trip", date: "2026-11-19", title: "Away trip", eventKind: "travel", eventTypeLabel: "Travel", span: trip }),
    card({ id: "camp", date: "2026-11-20", title: "Winter camp", eventKind: "camp", eventTypeLabel: "Camp", span: camp, startTime: "09:00:00", endTime: "17:00:00" }),
    card({ id: "camp", date: "2026-11-21", title: "Winter camp", eventKind: "camp", eventTypeLabel: "Camp", span: camp, startTime: "09:00:00", endTime: "17:00:00" }),
    card({ id: "camp", date: "2026-11-22", title: "Winter camp", eventKind: "camp", eventTypeLabel: "Camp", span: camp, startTime: "09:00:00", endTime: "17:00:00" }),
    card({ id: "late", date: TODAY, title: "Evening meeting", eventKind: "meeting", eventTypeLabel: "Meeting", startTime: "19:00:00" }),
    card({ id: "early", date: TODAY, title: "Morning session", eventKind: "training", eventTypeLabel: "Training", startTime: "08:30:00" }),
    card({ id: "gym", date: "2026-11-19", title: "Gym", eventKind: "training", eventTypeLabel: "Training", startTime: "08:00:00" }),
  ]) }));
  await load();
  assert.deepEqual(state.athleteHomeEvents.rows.map((r) => r.eventId), ["early", "late", "trip", "gym", "camp"], "today's timed events by time, then today's untimed one, then later days");
  assert.equal(state.athleteHomeEvents.rows.find((r) => r.eventId === "trip").day, TODAY, "listed at its first day in the window");
  const texts = rowTexts();
  assert.equal(texts.length, 5);
  assert.match(texts[2], /^Away trip Mon 16 Nov – Tomorrow · Time not set · Travel/);
  assert.match(texts[4], /^Winter camp Fri 20 Nov – Sun 22 Nov · 09:00–17:00 · Camp/);
});

test("E4. the words: Today, Tomorrow, a weekday and a date; a time, a start only, Time not set; the type word not repeated; the kind's word without a label", async () => {
  calendarServer(() => ({ status: 200, body: answer([
    card({ id: "a", date: TODAY, title: "Cup match", startTime: "18:00:00", endTime: "19:30:00" }),
    card({ id: "b", date: "2026-11-19", title: "Match", startTime: "10:00:00" }),
    card({ id: "c", date: "2026-11-25", title: "Team meeting", eventKind: "meeting", eventTypeLabel: null }),
  ]) }));
  await load();
  const texts = rowTexts();
  assert.match(texts[0], /^Cup match Today · 18:00–19:30 · Match$/);
  assert.match(texts[1], /^Match Tomorrow · 10:00$/, "the title is the type word: the word is not repeated");
  assert.match(texts[2], /^Team meeting Wed 25 Nov · Time not set · Meeting$/, "a moved team's event has no label: the kind's word");
  assert.equal(dom.window.document.body.innerHTML.includes("All day"), false, "never All day (the manager's Q2)");
  // The kind's icon (her card names no type).
  assert.ok($$(".athlete-home-event svg.athlete-home-event-icon").length === 3);
});

test("E4b. a Day off (kind day_off) without a time shows no time part; with a time it shows it; every other kind keeps Time not set; a date range is \" – \" (en dash, a space each side)", async () => {
  calendarServer(() => ({ status: 200, body: answer([
    card({ id: "off", date: TODAY, title: "Day off", eventKind: "day_off", eventTypeLabel: "Day off" }),
    card({ id: "offtimed", date: "2026-11-19", title: "Day off", eventKind: "day_off", eventTypeLabel: "Day off", startTime: "12:00:00" }),
    card({ id: "rest2", date: "2026-11-20", title: "Rest weekend", eventKind: "day_off", eventTypeLabel: "Day off", span: { from: "2026-11-20", to: "2026-11-21" } }),
    card({ id: "rest2", date: "2026-11-21", title: "Rest weekend", eventKind: "day_off", eventTypeLabel: "Day off", span: { from: "2026-11-20", to: "2026-11-21" } }),
    card({ id: "meet", date: "2026-11-22", title: "Video analysis", eventKind: "meeting", eventTypeLabel: "Meeting" }),
  ]) }));
  await load();
  const texts = rowTexts();
  assert.match(texts[0], /^Day off Today$/, "no time part, not even Time not set");
  assert.match(texts[1], /^Day off Tomorrow · 12:00$/);
  assert.match(texts[2], /^Rest weekend Fri 20 Nov – Sat 21 Nov · Day off$/);
  assert.match(texts[3], /^Video analysis Sun 22 Nov · Time not set · Meeting$/);
  assert.ok(texts[2].includes(" – "), "the range: the en dash with a space on each side");
  assert.equal(/\d - |\d-[A-Z]/.test(dom.window.document.body.textContent), false, "no hyphen in a range");
});

test("E5. the place: a library place's name, address with Open in maps and note; no link without an address; a one-off text without a link; no place, no line; markup is text", async () => {
  const xss = "<img src=x onerror=alert(1)>";
  calendarServer(() => ({ status: 200, body: answer([
    card({ id: "lib", date: TODAY, title: "Cup match", startTime: "18:00:00", place: { source: "library", locationId: "l1", name: "City Stadium", address: "Main street 1, Novi Sad", note: "Gate B" } }),
    card({ id: "noaddr", date: TODAY, title: "Video session", startTime: "19:00:00", place: { source: "library", locationId: "l2", name: "Club house", address: null, note: null } }),
    card({ id: "oneoff", date: "2026-11-19", title: "Beach run", startTime: "07:00:00", place: { source: "one_off", text: "Strand beach, north entrance" }, location: "Strand beach, north entrance" }),
    card({ id: "none", date: "2026-11-20", title: "Rest day", startTime: "08:00:00" }),
    card({ id: "xss", date: "2026-11-21", title: xss, startTime: "08:00:00", place: { source: "library", locationId: "l3", name: xss, address: xss, note: xss } }),
    card({ id: "blank", date: "2026-11-22", title: "Empty place", startTime: "08:00:00", place: { source: "library", locationId: "l4", name: null, address: " ", note: null } }),
  ]) }));
  await load();
  await handleAthleteHomeEventsAction(fakeAction({ action: "athlete-home-events-toggle" }), { render });
  const items = $$(".athlete-home-event");
  assert.equal(items.length, 6);
  const links = $$("a.cc-maps");
  assert.equal(links.length, 2, "only the library places with an address");
  assert.equal(links[0].getAttribute("href"), MAPS("Main street 1, Novi Sad"));
  assert.equal(links[0].getAttribute("target"), "_blank");
  assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");
  assert.match(items[0].textContent, /City Stadium[\s\S]*Main street 1, Novi Sad[\s\S]*Open in maps[\s\S]*Gate B/);
  assert.match(items[1].textContent, /Club house/);
  assert.equal(items[1].querySelector("a"), null);
  assert.match(items[2].textContent, /Strand beach, north entrance/);
  assert.equal(items[2].querySelector("a"), null, "a one-off text is not known to be an address");
  assert.equal(items[3].querySelector(".cc-panel-place"), null);
  assert.equal(dom.window.document.querySelector("img"), null, "markup in a title, a name, an address or a note is text");
  assert.equal(links[1].getAttribute("href"), MAPS(xss));
  assert.equal(items[4].querySelector(".athlete-home-event-title").textContent, xss);
  assert.equal(items[5].querySelector(".cc-panel-place"), null, "a library place with nothing to show draws no empty line");
});

test("E6. a cancelled event is shown and marked: a glyph and the word, its title muted, no place and no Open in maps", async () => {
  calendarServer(() => ({ status: 200, body: answer([
    card({ id: "off", date: "2026-11-19", title: "Friendly", startTime: "17:00:00", cancelled: true, place: { source: "library", locationId: "l1", name: "City Stadium", address: "Main street 1", note: "Gate B" } }),
  ]) }));
  await load();
  const li = $(".athlete-home-event");
  assert.ok(li.classList.contains("is-cancelled"));
  const badge = li.querySelector(".athlete-home-event-cancelled");
  assert.ok(badge);
  assert.match(badge.textContent, /✕\s*Cancelled/);
  assert.equal(badge.querySelector("[aria-hidden='true']").textContent, "✕");
  assert.equal(li.querySelector(".cc-panel-place"), null);
  assert.equal(li.querySelector("a"), null);
  assert.equal(li.textContent.includes("City Stadium"), false);
  // The mark right under the title, read before the time (UX review).
  const body = [...li.querySelector(".athlete-home-event-body").children].map((el) => el.className);
  assert.deepEqual(body, ["athlete-home-event-title", "athlete-home-event-status", "athlete-home-event-when"]);
});

test("E7. the states: loading, empty, an error with one Try again, a lost sign-in without it, a 403 hides the section", async () => {
  // Loading while the answer is on its way.
  const gate = deferred();
  let calls = calendarServer(() => gate.promise);
  const pending = load();
  assert.match($(".athlete-home-events").textContent, /Loading events…/);
  gate.resolve({ status: 200, body: answer([]) });
  await pending;
  assert.match($(".athlete-home-events").textContent, /No events in the next 14 days\./);
  assert.equal($("button"), null, "the empty state has no button");

  // An error, and Try again sends one new request.
  clearAllViewCache();
  resetAthleteHomeEvents();
  let fail = true;
  calls = calendarServer(() => (fail ? { status: 500, body: { error: "internal_error" } } : { status: 200, body: answer([card({ id: "x", date: TODAY, title: "Cup match", startTime: "18:00:00" })]) }));
  await load();
  assert.match($(".athlete-home-events").textContent, /Events could not be loaded\./);
  assert.equal($(".athlete-home-events-state").getAttribute("role"), "alert", "the failure is announced");
  assert.equal($(".athlete-home-events").textContent.includes("internal_error"), false, "no code");
  const retry = $("[data-action='athlete-home-events-retry']");
  assert.ok(retry);
  assert.equal(retry.textContent, "Try again");
  retry.focus();
  fail = false;
  const before = calls.length;
  assert.equal(await handleAthleteHomeEventsAction(fakeAction({ action: "athlete-home-events-retry" }), { render }), true);
  assert.equal(calls.length - before, 1, "one new request");
  assert.equal(rowTexts().length, 1);
  assert.equal(dom.window.document.activeElement, $("#athleteHomeEventsTitle"), "the focus is on the section's heading, not lost to the page");
  assert.equal($("#athleteHomeEventsList").getAttribute("role"), "list");

  // A lost sign-in: said, no Try again.
  clearAllViewCache();
  resetAthleteHomeEvents();
  calendarServer(() => ({ status: 401, body: { error: "Unauthorized" } }));
  await load();
  assert.match($(".athlete-home-events").textContent, /Sign in again to see your events\./);
  assert.equal($("[data-action='athlete-home-events-retry']"), null);

  // 403: nothing she can do here.
  clearAllViewCache();
  resetAthleteHomeEvents();
  calendarServer(() => ({ status: 403, body: { error: "This account has no athlete profile." } }));
  await load();
  assert.equal($(".athlete-home-events"), null);
  assert.equal(state.athleteHomeEvents.status, "hidden");
});

test("E8. the first 5 rows, then Show N more / Show fewer in place, with no request; the focus stays on the button", async () => {
  const cards = Array.from({ length: 7 }, (_, i) => card({ id: `e${i}`, date: addDays(TODAY, i), title: `Event ${i}`, startTime: "10:00:00" }));
  const calls = calendarServer(() => ({ status: 200, body: answer(cards) }));
  await load();
  assert.equal(ATHLETE_HOME_EVENTS_LIMIT, 5);
  assert.equal($$(".athlete-home-event").length, 5);
  let toggle = $("[data-action='athlete-home-events-toggle']");
  assert.equal(toggle.textContent, "Show 2 more");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-controls"), "athleteHomeEventsList");
  const before = calls.length;
  await handleAthleteHomeEventsAction(fakeAction({ action: "athlete-home-events-toggle" }), { render });
  assert.equal($$(".athlete-home-event").length, 7);
  toggle = $("[data-action='athlete-home-events-toggle']");
  assert.equal(toggle.textContent, "Show fewer");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(dom.window.document.activeElement, toggle);
  await handleAthleteHomeEventsAction(fakeAction({ action: "athlete-home-events-toggle" }), { render });
  assert.equal($$(".athlete-home-event").length, 5);
  assert.equal(calls.length, before, "no request");
  // Five or fewer: no button.
  clearAllViewCache();
  resetAthleteHomeEvents();
  calendarServer(() => ({ status: 200, body: answer(cards.slice(0, 5)) }));
  await load();
  assert.equal($$(".athlete-home-event").length, 5);
  assert.equal($("[data-action='athlete-home-events-toggle']"), null);
  // Every entry into Home starts with the first rows.
  calendarServer(() => ({ status: 200, body: answer(cards) }));
  clearAllViewCache();
  await load();
  await handleAthleteHomeEventsAction(fakeAction({ action: "athlete-home-events-toggle" }), { render });
  assert.equal(state.athleteHomeEvents.expanded, true);
  await load();
  assert.equal(state.athleteHomeEvents.expanded, false);
  assert.equal($$(".athlete-home-event").length, 5);
});

test("E9. the cache and late answers: a re-entry inside the TTL reads nothing; a reset or another workspace drops the answer on its way; a new date reads again", async () => {
  let calls = calendarServer(() => ({ status: 200, body: answer([card({ id: "a", date: TODAY, title: "Cup match", startTime: "18:00:00" })]) }));
  await load();
  await load();
  assert.equal(calls.length, 1, "Home entered again within 30 s paints from the cache");

  // A workspace switch while the answer is on its way: never painted, never kept.
  clearAllViewCache();
  resetAthleteHomeEvents();
  const gate = deferred();
  calls = calendarServer(() => gate.promise);
  const pending = load();
  resetAthleteHomeEvents();
  const rendersAfterReset = renders;
  gate.resolve({ status: 200, body: answer([card({ id: "old", date: TODAY, title: "Old workspace event", startTime: "18:00:00" })]) });
  await pending;
  assert.equal(state.athleteHomeEvents.status, "idle");
  assert.deepEqual(state.athleteHomeEvents.rows, []);
  assert.equal(renders, rendersAfterReset, "nothing painted after the reset");

  // Another account or workspace by the time the answer lands: dropped.
  clearAllViewCache();
  resetAthleteHomeEvents();
  const gate2 = deferred();
  calendarServer(() => gate2.promise);
  const pending2 = load();
  state.currentUser = { id: "u-athlete", activeWorkspace: { type: "team", scopeId: "team-1" } };
  gate2.resolve({ status: 200, body: answer([card({ id: "x", date: TODAY, title: "Should not show", startTime: "18:00:00" })]) });
  await pending2;
  assert.deepEqual(state.athleteHomeEvents.rows, []);
  assert.equal(dom.window.document.body.textContent.includes("Should not show"), false);

  // An older read overtaken by a newer one (Home entered twice): only the newer one paints.
  state.currentUser = ATHLETE;
  clearAllViewCache();
  resetAthleteHomeEvents();
  const first = deferred();
  let n = 0;
  calendarServer(() => {
    n += 1;
    return n === 1 ? first.promise : { status: 200, body: answer([card({ id: "new", date: addDays(TODAY, 1), title: "Newer day", startTime: "18:00:00" })], addDays(TODAY, 1)) };
  });
  const older = load();
  await loadAthleteHomeEvents({ render, today: addDays(TODAY, 1) });
  first.resolve({ status: 200, body: answer([card({ id: "old", date: TODAY, title: "Older read", startTime: "18:00:00" })]) });
  await older;
  assert.deepEqual(state.athleteHomeEvents.rows.map((r) => r.eventId), ["new"]);

  // A new date (a tab left open past midnight) reads again, with the new range.
  clearAllViewCache();
  resetAthleteHomeEvents();
  calls = calendarServer(() => ({ status: 200, body: answer([]) }));
  await load();
  await loadAthleteHomeEvents({ render, today: addDays(TODAY, 1) });
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url, "http://x").searchParams.get("from"), addDays(TODAY, 1));
  assert.equal(new URL(calls[1].url, "http://x").searchParams.get("to"), addDays(TODAY, 14));
});

test("E10. Home: the section comes after This week and before My training and the quick actions; nothing on Home carries data-tab; app.js wires the read, the actions and the reset", async () => {
  calendarServer(() => ({ status: 200, body: answer([card({ id: "a", date: TODAY, title: "Cup match", startTime: "18:00:00" })]) }));
  await load();
  const home = renderAthleteHomeHtml({
    data: {
      athlete: { name: "Ana", imageUrl: "" },
      today: { date: TODAY, hasTraining: false, sessionCount: 0, itemCount: 0 },
      week: { days: [{ date: TODAY, isToday: true, hasTraining: false }] },
      wellness: { count: 0 },
    },
    error: "",
  });
  const week = home.indexOf('class="athlete-home-week"');
  const events = home.indexOf("athlete-home-events");
  const quick = home.indexOf('class="athlete-home-quick-actions"');
  assert.ok(week >= 0 && events > week && quick > events, "after This week, before the quick actions");
  assert.equal(/data-tab=/.test(home), false, "no element carries data-tab (app.js hijacks it)");
  assert.equal(/data-tab=/.test(renderAthleteHomeEventsHtml({ ...state.athleteHomeEvents, expanded: true })), false);

  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = app.indexOf("async function loadAthleteHome(");
  const body = app.slice(start, app.indexOf("\n}\n", start));
  assert.match(body, /Promise\.all\(\[[\s\S]*loadAthleteHomeEvents\(\{ render: renderAthleteHomeFromCache, forceRefresh \}\)/);
  const switchStart = app.indexOf("async function onWorkspaceChanged(");
  const switchBody = app.slice(switchStart, app.indexOf("\n}\n", switchStart));
  assert.match(switchBody, /resetAthleteHomeEvents\(\);/);
  // Gated by its prefix (code review): every other click keeps reaching the handlers below without an await.
  assert.match(app, /if \(type\?\.startsWith\("athlete-home-events-"\)\) \{\n\s+await handleAthleteHomeEventsAction\(action, \{ render: renderAthleteHomeFromCache \}\);\n\s+return;\n\s+\}/);
  assert.equal(/if \(await handleAthleteHomeEventsAction/.test(app), false, "no ungated await in the click dispatch");
});

test("E7b. after a 403, the next entry into Home never flashes the section while it asks again", async () => {
  calendarServer(() => ({ status: 403, body: { error: "This account has no athlete profile." } }));
  await load();
  assert.equal($(".athlete-home-events"), null);
  const gate = deferred();
  calendarServer(() => gate.promise);
  const pending = load();
  assert.equal(state.athleteHomeEvents.status, "hidden");
  assert.equal($(".athlete-home-events"), null, "no Loading events… flash");
  gate.resolve({ status: 403, body: { error: "This account has no athlete profile." } });
  await pending;
  assert.equal($(".athlete-home-events"), null);
});

test("E11. athleteHomeEventRows keeps only event cards with an id, and reads nothing from a malformed answer", () => {
  assert.deepEqual(athleteHomeEventRows(null), []);
  assert.deepEqual(athleteHomeEventRows({ days: "x" }), []);
  const rows = athleteHomeEventRows({ days: [{ date: TODAY, items: [
    { kind: "planned", date: TODAY, title: "Training", links: {} },
    { kind: "event", date: TODAY, title: "No id", links: {} },
    card({ id: "ok", date: TODAY, title: "Kept" }),
  ] }] });
  assert.deepEqual(rows.map((r) => r.title), ["Kept"]);
});

// The independent review of PR #603 (F1-F3): three guards its own mutations found unpinned here.

test("E12 (F1). without a `today`, the read takes the DEVICE's local date: Europe/Belgrade at 2026-11-17T23:30Z is 18 Nov, so today=2026-11-18 and to=2026-12-01 (never the UTC date)", async () => {
  const RealDate = globalThis.Date;
  const realTz = process.env.TZ;
  const fixed = RealDate.parse("2026-11-17T23:30:00Z");
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed]));
    }
    static now() {
      return fixed;
    }
  }
  process.env.TZ = "Europe/Belgrade";
  globalThis.Date = FixedDate;
  try {
    assert.equal(new Date().getDate(), 18, "the clock is set: 00:30 on 18 Nov in Belgrade");
    const calls = calendarServer(() => ({ status: 200, body: answer([], "2026-11-18") }));
    await loadAthleteHomeEvents({ render });
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url, "http://x");
    assert.equal(url.searchParams.get("today"), "2026-11-18");
    assert.equal(url.searchParams.get("from"), "2026-11-18");
    assert.equal(url.searchParams.get("to"), "2026-12-01");
  } finally {
    globalThis.Date = RealDate;
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  }
});

test("E5b (F2). a type label with markup is text on the time line: no element is made, the label is shown as it is", async () => {
  const xss = "<img src=x onerror=alert(1)>";
  calendarServer(() => ({ status: 200, body: answer([
    card({ id: "lbl", date: TODAY, title: "Cup match", eventTypeLabel: xss, startTime: "18:00:00" }),
  ]) }));
  await load();
  assert.equal(dom.window.document.querySelector("img"), null);
  assert.equal($(".athlete-home-event-when").textContent, `Today · 18:00 · ${xss}`);
});

test("E9b (F3). read A for 18 Nov is on its way, read B for 19 Nov succeeds, then A answers 500: B's list stays, never A's error", async () => {
  const a = deferred();
  let n = 0;
  calendarServer(() => {
    n += 1;
    return n === 1 ? a.promise : { status: 200, body: answer([card({ id: "b", date: addDays(TODAY, 1), title: "Read B", startTime: "18:00:00" })], addDays(TODAY, 1)) };
  });
  const readA = load();
  await loadAthleteHomeEvents({ render, today: addDays(TODAY, 1) });
  assert.deepEqual(state.athleteHomeEvents.rows.map((r) => r.eventId), ["b"]);
  a.resolve({ status: 500, body: { error: "internal_error" } });
  await readA;
  assert.equal(state.athleteHomeEvents.status, "ready");
  assert.deepEqual(state.athleteHomeEvents.rows.map((r) => r.eventId), ["b"]);
  assert.equal($(".athlete-home-events").textContent.includes("could not be loaded"), false);
  assert.match(rowTexts()[0], /^Read B /);
});

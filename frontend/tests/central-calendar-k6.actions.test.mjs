// K6-1 (docs/ai/central-calendar-k6-contract.md, sections 2, 5 and 6.1): the calendar's team and athlete switcher,
// through the real handlers, loaders and templates with a fake fetch that keeps the routes' contracts: the roster is
// `state.athletes`, the team facts are GET /api/organization's, `athleteIds` narrows inside the scope.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true };

const { state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { handleCentralCalendarAction, handleCentralCalendarInput, handleCentralCalendarKeydown } = await import("../central-calendar-actions.js");
const data = await import("../central-calendar-data.js");
const view = await import("../central-calendar-view.js");
const { buildCentralCalendarSwitcherModel, reduceOrganizationPairs } = await import("../central-calendar-switcher.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const OTHER_TEAM = "99999999-9999-4999-8999-999999999999";
const TEAMS = [{ teamId: A, name: "U19" }, { teamId: B, name: "U17" }];
const uuid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ROSTER = [
  { athlete_uuid: uuid(1), athlete_id: "R1", athlete: "Ana Kovač" },
  { athlete_uuid: uuid(2), athlete_id: "R2", athlete: "Ben Marsh" },
  { athlete_uuid: uuid(3), athlete_id: "R3", athlete: "Marko Stone" },
  { athlete_uuid: uuid(4), athlete_id: "R4", athlete: "Cara Both" },
];
const ARCHIVED_ONLY = uuid(9);
const OUTSIDE_ROSTER = uuid(10);
const ORG = {
  users: [{ id: "u1", email: "secret@example.com" }], joinLinks: [{ token: "tok" }],
  athletes: [
    { id: uuid(1), name: "Ana Kovač", memberships: [{ membershipType: "team", status: "active", teamId: A, teamName: "U19", clubName: "Mine" }] },
    { id: uuid(2), name: "Ben Marsh", memberships: [{ membershipType: "team", status: "active", teamId: A }] },
    { id: uuid(3), name: "Marko Stone", memberships: [{ membershipType: "team", status: "active", teamId: B }] },
    { id: uuid(4), name: "Cara Both", memberships: [{ membershipType: "team", status: "active", teamId: A }, { membershipType: "team", status: "active", teamId: B }, { membershipType: "team", status: "active", teamId: OTHER_TEAM, teamName: "Foreign Team", clubName: "Foreign Club" }] },
    { id: ARCHIVED_ONLY, name: "Archived Person", memberships: [{ membershipType: "team", status: "archived", teamId: A }] },
    { id: OUTSIDE_ROSTER, name: "Outside Person", memberships: [{ membershipType: "team", status: "active", teamId: A }] },
  ],
};

let workspaceType = "club";
let failOrg = false;
let rendered = "";
let layout = "wide";
const render = () => { rendered = view.renderCentralCalendarHtml(state.centralCalendar, { today: TODAY, layout }); };
const dom = (html = rendered) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
const act = (dataset) => handleCentralCalendarAction(fakeAction(dataset), { render });

function item(key, date, title, athleteIds, extra = {}) {
  return { key, kind: "planned", date, title, slot: null, startTime: null, teamIds: [A], athleteIds, athleteCount: athleteIds.length, expects: [], status: "none", rpe: null, cancelled: false, projected: false, links: {}, ...extra };
}
// The unfiltered answer holds everyone's cards; an athlete read holds only the cards that name her, with her own count.
const CARDS = [
  item("planned:team", MONDAY, "Team training", [uuid(1), uuid(2)], { athleteCount: 18 }),
  item("planned:other", MONDAY, "Other team's session", [uuid(3)], { teamIds: [B], athleteCount: 24 }),
  item("planned:club", addDaysIso(MONDAY, 1), "Club-wide", [], { teamIds: [], athleteCount: 40 }),
];
function answer(url) {
  const params = new URL(url, "http://localhost").searchParams;
  const athleteIds = (params.get("athleteIds") || "").split(",").filter(Boolean);
  const days = [];
  for (let cursor = params.get("from"); cursor <= params.get("to"); cursor = addDaysIso(cursor, 1)) {
    const items = CARDS.filter((card) => card.date === cursor)
      .filter((card) => !athleteIds.length || card.athleteIds.includes(athleteIds[0]) || card.key === "planned:club")
      .map((card) => (athleteIds.length ? { ...card, athleteCount: 1, athleteIds: athleteIds } : { ...card }));
    days.push({ date: cursor, items });
  }
  return { from: params.get("from"), to: params.get("to"), today: params.get("today"), workspace: { type: workspaceType, scopeId: "w-1" }, teams: workspaceType === "club" ? TEAMS : workspaceType === "platform" ? TEAMS : workspaceType === "team" ? [TEAMS[0]] : [], days };
}
let calls;
function server(overrides = {}) {
  calls = installFetchMock((call) => {
    if (overrides.before) { const r = overrides.before(call); if (r) return r; }
    if (call.url.startsWith("/api/calendar?")) return { status: 200, body: answer(call.url) };
    if (call.url === "/api/organization") return failOrg ? { status: 500, body: {} } : { status: 200, body: ORG };
    return { status: 404, body: {} };
  });
  return calls;
}
const calendarCalls = () => calls.filter((c) => c.url.startsWith("/api/calendar?"));
const paramsOf = (c) => new URL(c.url, "http://localhost").searchParams;

beforeEach(() => {
  clearAllViewCache();
  data.resetCentralCalendarForWorkspaceChange();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "w-1", label: "Club" } };
  state.activeTab = "central-calendar";
  state.athletes = ROSTER.map((row) => ({ ...row }));
  workspaceType = "club";
  failOrg = false;
  layout = "wide";
  rendered = "";
});

async function open() {
  server();
  await data.loadCentralCalendar({ render });
  render();
}
const pills = () => [...dom().querySelectorAll(".athlete-switcher .builder-batch-pill")].map((el) => el.getAttribute("aria-label"));

// --- the list per workspace (2.3) and the order (2.4) -------------------------------------------

test("K6-1a. a club's strip: All groups lists every athlete once, by team; a chosen team lists its own", async () => {
  await open();
  // Everyone, then U19 (Ana, Ben, Cara - once, under her first team), then U17 (Marko).
  assert.deepEqual(pills(), ["Everyone", "Ana Kovač", "Ben Marsh", "Cara Both", "Marko Stone"]);
  assert.equal(dom().querySelectorAll(".athlete-switcher-dot").length, 4, "each athlete carries her team's dot");
  assert.ok(dom().querySelector(".athlete-switcher-group-label"), "a team label starts each group");
  await act({ action: "central-calendar-toggle-team", teamId: B });
  assert.deepEqual(pills(), ["Everyone", "Cara Both", "Marko Stone"], "in a chosen team she is listed again, by name");
});

test("K6-1b. a team coach: the roster only, no Groups row, no organization read; a private coach likewise; the platform has no strip", async () => {
  workspaceType = "team";
  await open();
  assert.deepEqual(pills(), ["Everyone", "Ana Kovač", "Ben Marsh", "Cara Both", "Marko Stone"]);
  assert.equal(dom().querySelector(".athlete-switcher-groups"), null);
  assert.equal(calls.filter((c) => c.url === "/api/organization").length, 0, "F-H1: a team coach does not read it");
  clearAllViewCache(); data.resetCentralCalendarForWorkspaceChange();
  workspaceType = "platform";
  state.athletes = [];
  server();
  await data.loadCentralCalendar({ render });
  render();
  assert.equal(dom().querySelector(".builder-batch-pill"), null, "F-H5: no strip in the platform workspace");
  assert.equal(dom().querySelector('[data-athlete-switcher-search]'), null);
  assert.equal(calls.filter((c) => c.url === "/api/organization").length, 0);
  assert.ok(dom().querySelector(".athlete-switcher-groups"), "the Groups row stays there");
});

test("K6-1c. more than 60 athletes in All groups: no strip, the sentence, the search", async () => {
  state.athletes = Array.from({ length: 62 }, (_, i) => ({ athlete_uuid: uuid(100 + i), athlete_id: `X${i}`, athlete: `Person ${String(i).padStart(2, "0")}` }));
  server({ before: (call) => (call.url === "/api/organization" ? { status: 200, body: { athletes: state.athletes.map((row, i) => ({ id: row.athlete_uuid, memberships: [{ membershipType: "team", status: "active", teamId: i % 2 ? A : B }] })) } } : null) });
  await data.loadCentralCalendar({ render });
  render();
  assert.equal(dom().querySelector(".builder-batch-pill"), null);
  assert.match(dom().querySelector(".athlete-switcher-note").textContent, /62 athletes in the club\. Search for an athlete, or choose a group\./);
  assert.ok(dom().querySelector("[data-athlete-switcher-search]"), "the search is the way in");
  await act({ action: "central-calendar-toggle-team", teamId: A });
  assert.ok(dom().querySelectorAll(".builder-batch-pill").length > 1, "a chosen team brings its strip back");
});

// --- the read (2.5) --------------------------------------------------------------------------------

test("K6-1d. choosing an athlete reads with athleteIds ALONE; the key is its own; kinds stack; cards never fall back", async () => {
  await open();
  const before = calendarCalls().length;
  await act({ action: "central-calendar-toggle-team", teamId: A });
  await act({ action: "central-calendar-pick-athlete", athleteKey: uuid(1) });
  const athleteRead = calendarCalls().slice(before).find((c) => paramsOf(c).get("athleteIds"));
  assert.ok(athleteRead, "an athlete read was sent");
  assert.equal(paramsOf(athleteRead).get("athleteIds"), uuid(1));
  assert.equal(paramsOf(athleteRead).has("teamIds"), false, "never teamIds with athleteIds");
  assert.equal(paramsOf(athleteRead).has("clubIds"), false);
  assert.equal(data.centralCalendarUrl("a", "b", "c", { athleteId: "x" }).includes("teamIds"), false);
  assert.notEqual(data.centralCalendarContextKey("a", "b", "c", "", uuid(1)), data.centralCalendarContextKey("a", "b", "c"), "the athlete is part of the key");
  assert.equal(data.centralCalendarContextKey("a", "b", "c", "planned"), data.centralCalendarContextKey("a", "b", "c", "planned", ""), "the unfiltered key is unchanged");
  render();
  const titles = [...dom().querySelectorAll(".cc-card")].map((c) => c.textContent);
  assert.ok(titles.some((t) => t.includes("Team training")));
  assert.equal(titles.some((t) => t.includes("Other team's session")), false);
  // Kinds + athlete in one read.
  const sub = calendarCalls().length;
  await act({ action: "central-calendar-show-only", kind: "planned" });
  const both = calendarCalls().slice(sub).find((c) => paramsOf(c).get("kinds") === "planned");
  assert.equal(paramsOf(both).get("athleteIds"), uuid(1));
});

test("K6-1e. while the athlete's read is pending or failed, no card of the unfiltered answer is drawn", async () => {
  await open();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  calls = installFetchMock(async (call) => {
    if (call.url.startsWith("/api/calendar?") && new URL(call.url, "http://x").searchParams.get("athleteIds")) await gate;
    return call.url.startsWith("/api/calendar?") ? { status: 200, body: answer(call.url) } : { status: 200, body: ORG };
  });
  const pending = act({ action: "central-calendar-pick-athlete", athleteKey: uuid(1) });
  render();
  assert.equal(dom().querySelectorAll(".cc-card").length, 0, "nothing under 'Showing Ana' while loading");
  assert.match(dom().body.textContent, /Loading calendar/);
  release();
  await pending;
  render();
  assert.ok(dom().querySelectorAll(".cc-card").length > 0);
  // A failed read: the error state with Try again.
  await act({ action: "central-calendar-pick-athlete", athleteKey: "" });
  calls = installFetchMock((call) => (call.url.startsWith("/api/calendar?") && call.url.includes("athleteIds") ? { status: 500, body: {} } : { status: 200, body: call.url.startsWith("/api/calendar?") ? answer(call.url) : ORG }));
  await act({ action: "central-calendar-pick-athlete", athleteKey: uuid(2) });
  render();
  assert.equal(dom().querySelectorAll(".cc-card").length, 0);
  assert.ok(dom().querySelector('[data-action="central-calendar-retry"]'));
});

test("K6-1f. the Groups chips are suspended while an athlete is chosen: a club-wide event of hers stays", async () => {
  await open();
  await act({ action: "central-calendar-toggle-team", teamId: B });
  await act({ action: "central-calendar-pick-athlete", athleteKey: uuid(4) });
  render();
  const titles = [...dom().querySelectorAll(".cc-card")].map((c) => c.textContent).join("|");
  assert.match(titles, /Club-wide/, "the club-wide card has no team, and the chip would have hidden it");
});

test("K6-1g. the green line's forms, Show everyone, and Clear filters clearing the athlete", async () => {
  await open();
  await act({ action: "central-calendar-toggle-team", teamId: A });
  await act({ action: "central-calendar-pick-athlete", athleteKey: uuid(1) });
  render();
  assert.match(dom().querySelector(".cc-athlete-line").textContent, /Showing Ana Kovač · U19/);
  await act({ action: "central-calendar-show-only", kind: "planned" });
  render();
  assert.match(dom().querySelector(".cc-athlete-line").textContent, /Showing Ana Kovač · U19 · only Planned training/);
  await act({ action: "central-calendar-show-everyone" });
  render();
  assert.equal(dom().querySelector(".cc-athlete-line"), null);
  assert.deepEqual(state.centralCalendar.filters.kinds, ["planned"], "the kinds stay");
  await act({ action: "central-calendar-pick-athlete", athleteKey: uuid(1) });
  await act({ action: "central-calendar-clear-filters" });
  assert.equal(state.centralCalendar.switcher.athleteKey, "");
  assert.deepEqual(state.centralCalendar.filters.teamIds, []);
});

test("K6-1h. an athlete not in the new team goes back to Everyone", async () => {
  await open();
  await act({ action: "central-calendar-toggle-team", teamId: A });
  await act({ action: "central-calendar-pick-athlete", athleteKey: uuid(1) });
  await act({ action: "central-calendar-toggle-team", teamId: B });
  assert.equal(state.centralCalendar.switcher.athleteKey, "", "Ana is not in U17");
});

// --- the search (2.6) ---------------------------------------------------------------------------------

test("K6-1i. search: accents, word starts first, the team's names, and choosing another team's athlete sets the Groups choice", async () => {
  state.athletes = [...ROSTER, ...Array.from({ length: 6 }, (_, i) => ({ athlete_uuid: uuid(50 + i), athlete_id: `F${i}`, athlete: `Filler ${i}` }))];
  server();
  await data.loadCentralCalendar({ render });
  state.centralCalendar.switcher.query = "kovac";
  render();
  assert.ok(dom().querySelector(".athlete-switcher-result"), "an accent-insensitive match");
  state.centralCalendar.switcher.query = "mark";
  render();
  const results = [...dom().querySelectorAll(".athlete-switcher-result")];
  assert.match(results[0].textContent, /Marko Stone/);
  assert.match(results[0].textContent, /U17/, "the result names her team");
  await act({ action: "central-calendar-pick-result", athleteKey: uuid(3) });
  assert.deepEqual(state.centralCalendar.filters.teamIds, [B], "Groups switches to her team");
  assert.equal(state.centralCalendar.switcher.athleteKey, uuid(3));
  assert.ok(calendarCalls().some((c) => paramsOf(c).get("athleteIds") === uuid(3)), "her week is read");
});

test("K6-1j. the empty sentence depends only on the typed text: an athlete of another team reads as one nobody has", async () => {
  workspaceType = "team";
  state.athletes = [...ROSTER, ...Array.from({ length: 6 }, (_, i) => ({ athlete_uuid: uuid(50 + i), athlete_id: `F${i}`, athlete: `Filler ${i}` }))];
  server();
  await data.loadCentralCalendar({ render });
  const sentence = (query) => { state.centralCalendar.switcher.query = query; render(); return dom().querySelector(".athlete-switcher-empty")?.textContent; };
  assert.equal(sentence("zzzzz"), "No athlete in this team matches ‘zzzzz’.");
  // "Foreign" exists nowhere in this roster; the same sentence form, nothing else of it in the DOM.
  assert.equal(sentence("Foreign"), "No athlete in this team matches ‘Foreign’.");
  assert.equal(/Foreign Team|Foreign Club/.test(rendered), false);
});

// --- information hiding and the workspace (5.2, F-H) --------------------------------------------------

test("F-H2. another club's names, an archived-only tie and the raw answer never reach the DOM or the state", async () => {
  await open();
  const html = rendered;
  assert.equal(/Foreign Team|Foreign Club|Archived Person|Outside Person|secret@example\.com/.test(html), false);
  const stored = JSON.stringify(state.centralCalendar);
  assert.equal(/Foreign|Archived|secret@example|tok"/.test(stored), false, "only { athleteUuid, teamId } pairs are kept");
  for (const pair of state.centralCalendar.switcher.org.pairs) assert.deepEqual(Object.keys(pair).sort(), ["athleteUuid", "teamId"]);
  assert.equal(state.centralCalendar.switcher.org.pairs.some((pair) => pair.teamId === OTHER_TEAM), false);
  assert.equal(state.centralCalendar.switcher.org.pairs.some((pair) => pair.athleteUuid === ARCHIVED_ONLY), false);
  assert.equal(state.centralCalendar.switcher.org.pairs.some((pair) => pair.athleteUuid === OUTSIDE_ROSTER), false, "an active athlete the roster does not hold is never kept");
  assert.equal(buildCentralCalendarSwitcherModel(state.centralCalendar).searchList.some((entry) => entry.key === OUTSIDE_ROSTER), false);
  assert.deepEqual(reduceOrganizationPairs(ORG, ROSTER, TEAMS).filter((p) => p.athleteUuid === uuid(4)).map((p) => p.teamId), [A, B]);
});

test("F-H3. a failed organization read: the roster by name, no grouping, a retry sentence", async () => {
  failOrg = true;
  await open();
  assert.deepEqual(pills(), ["Everyone", "Ana Kovač", "Ben Marsh", "Cara Both", "Marko Stone"]);
  assert.equal(dom().querySelectorAll(".athlete-switcher-dot").length, 0);
  assert.match(dom().body.textContent, /Teams could not be loaded/);
});

test("F-H6/F-H7. a workspace switch clears the choice; a slower old answer is dropped; a remembered id is checked against the roster", async () => {
  await open();
  await act({ action: "central-calendar-pick-athlete", athleteKey: uuid(1) });
  assert.equal(state.centralCalendar.switcher.athleteKey, uuid(1));
  data.resetCentralCalendarForWorkspaceChange();
  assert.equal(state.centralCalendar.switcher.athleteKey, "");
  assert.deepEqual(state.centralCalendar.switcher.org.pairs, []);
  assert.equal(state.centralCalendar.weeklyFlow, null);
  // A remembered athlete that the roster no longer holds is never sent.
  await open();
  state.centralCalendar.switcher.athleteKey = uuid(77);
  const before = calendarCalls().length;
  await data.loadCentralCalendar({ render, forceRefresh: true });
  assert.equal(calendarCalls().slice(before).some((c) => paramsOf(c).get("athleteIds")), false);
  assert.equal(state.centralCalendar.switcher.athleteKey, "", "dropped");
  // The old workspace's slow organization answer is not stored in the new one.
  data.resetCentralCalendarForWorkspaceChange();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  calls = installFetchMock(async (call) => {
    if (call.url === "/api/organization") { await gate; return { status: 200, body: ORG }; }
    return { status: 200, body: answer(call.url) };
  });
  const loading = data.loadCentralCalendar({ render });
  await new Promise((resolve) => setTimeout(resolve, 20));
  data.resetCentralCalendarForWorkspaceChange();
  release();
  await loading;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(state.centralCalendar.switcher.org.pairs, [], "the answer of the first workspace is dropped");
});

test("K6-1k. the panel's day read carries the athlete; Show everyone in the panel's note reads the item again", async () => {
  await open();
  await act({ action: "central-calendar-pick-athlete", athleteKey: uuid(1) });
  const before = calendarCalls().length;
  await act({ action: "central-calendar-open-item", key: "planned:team", date: MONDAY });
  const dayRead = calendarCalls().slice(before).find((c) => paramsOf(c).get("include") === "athletes");
  assert.equal(paramsOf(dayRead).get("athleteIds"), uuid(1));
  await act({ action: "central-calendar-show-everyone" });
  const again = calendarCalls().filter((c) => paramsOf(c).get("include") === "athletes").at(-1);
  assert.equal(paramsOf(again).has("athleteIds"), false);
  assert.equal(state.centralCalendar.panel.open, true, "the panel stays on its item");
});

test("K6-1l. the model: the search list is the roster intersected, never the organization's own list", async () => {
  await open();
  const model = buildCentralCalendarSwitcherModel(state.centralCalendar);
  assert.equal(model.searchList.some((entry) => entry.key === ARCHIVED_ONLY), false);
  assert.equal(handleCentralCalendarInput({ dataset: {}, matches: () => false, closest: () => null }), false);
  assert.equal(typeof handleCentralCalendarKeydown, "function");
});

test("K6-1m. the Everyone pill says it once (the caption), the avatar carries a glyph", async () => {
  await open();
  const all = dom().querySelector(".athlete-switcher .athlete-switcher-all");
  assert.equal(all.querySelector(".builder-batch-caption").textContent, "All");
  assert.equal(all.querySelector(".builder-batch-avatar").textContent.includes("All"), false);
});

test("K6-1n. a search for an athlete with no team while a team is chosen goes to All groups, so the strip holds her", async () => {
  const lone = { athlete_uuid: uuid(5), athlete_id: "R5", athlete: "Lone Person" };
  state.athletes = [...ROSTER, lone];
  server();
  await data.loadCentralCalendar({ render });
  await act({ action: "central-calendar-toggle-team", teamId: A });
  await act({ action: "central-calendar-pick-result", athleteKey: uuid(5) });
  assert.deepEqual(state.centralCalendar.filters.teamIds, []);
  assert.equal(state.centralCalendar.switcher.athleteKey, uuid(5));
  render();
  assert.equal(dom().querySelector(".athlete-switcher .builder-batch-pill.is-active").getAttribute("aria-label"), "Lone Person");
});

test("K6-1o. the phone's fold line: a team alone reads 'U19 · all athletes', never 'Everyone · U19'", async () => {
  layout = "phone";
  await open();
  await act({ action: "central-calendar-toggle-team", teamId: A });
  render();
  assert.equal(dom().querySelector(".athlete-switcher-fold small").textContent, "U19 · all athletes");
});

// --- K6 follow-up (2026-11-22): hide / show the strip, and the phone's box kept open by the arrows ------------------

function memoryStorage() {
  const store = new Map();
  return { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, store };
}

test("K6-F1. a computer's box hides and shows again; who is chosen stays; the choice is per user and survives a new slice", async () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  try {
    await open();
    await act({ action: "central-calendar-pick-athlete", athleteKey: uuid(2) });
    render();
    assert.equal(dom().querySelector(".athlete-switcher-hide").textContent, "Hide athletes");
    assert.ok(dom().querySelector(".athlete-switcher .builder-batch-pills"));
    await act({ action: "central-calendar-switcher-hide" });
    render();
    const box = dom().querySelector(".athlete-switcher");
    assert.ok(box.classList.contains("is-collapsed"));
    assert.equal(box.querySelector(".athlete-switcher-body").hasAttribute("hidden"), true, "the strip takes no room");
    assert.match(box.querySelector(".athlete-switcher-head-text").textContent, /Ben Marsh/, "who is chosen stays on one line");
    assert.equal(box.querySelector(".athlete-switcher-hide").textContent, "Show athletes");
    assert.equal(box.querySelector(".athlete-switcher-hide").getAttribute("aria-expanded"), "false");
    assert.equal(storage.store.get("optimove.athleteStrip.hidden.calendar.coach-1"), "1", "remembered for this user and this surface");
    // A new slice (a workspace change) reads the preference again.
    data.resetCentralCalendarForWorkspaceChange();
    await open();
    assert.ok(dom().querySelector(".athlete-switcher.is-collapsed"));
    // Another user does not inherit it.
    data.resetCentralCalendarForWorkspaceChange();
    state.currentUser = { ...state.currentUser, id: "coach-2" };
    await open();
    assert.equal(dom().querySelector(".athlete-switcher.is-collapsed"), null);
    state.currentUser = { ...state.currentUser, id: "coach-1" };
    data.resetCentralCalendarForWorkspaceChange();
    await open();
    await act({ action: "central-calendar-switcher-hide" });
    render();
    assert.equal(dom().querySelector(".athlete-switcher.is-collapsed"), null, "shown again");
    assert.equal(storage.store.has("optimove.athleteStrip.hidden.calendar.coach-1"), false);
  } finally {
    delete globalThis.localStorage;
  }
});

test("K6-F2. blocked storage: hiding still works for the screen and nothing throws; a phone has no hide control", async () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  try {
    await open();
    await act({ action: "central-calendar-switcher-hide" });
    render();
    assert.ok(dom().querySelector(".athlete-switcher.is-collapsed"));
    layout = "phone";
    render();
    assert.equal(dom().querySelector(".athlete-switcher-hide"), null, "a phone keeps its own fold");
    assert.equal(dom().querySelector(".athlete-switcher.is-collapsed"), null);
  } finally {
    delete globalThis.localStorage;
  }
});

test("K6-F3. an arrow keeps a phone's box open; a pill folds it", async () => {
  layout = "phone";
  await open();
  await act({ action: "central-calendar-switcher-toggle" });
  assert.equal(state.centralCalendar.switcher.open, true);
  await handleCentralCalendarAction(fakeAction({ action: "central-calendar-pick-athlete", athleteKey: uuid(1) }, { classList: { contains: (name) => name === "icon-button" } }), { render });
  assert.equal(state.centralCalendar.switcher.open, true, "› keeps the box open");
  await act({ action: "central-calendar-pick-athlete", athleteKey: uuid(2) });
  assert.equal(state.centralCalendar.switcher.open, false, "a pill folds it");
});

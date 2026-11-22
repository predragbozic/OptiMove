// K6-1 (docs/ai/central-calendar-k6-contract.md section 2 and the frontend info-hiding tests of 5.2): the calendar's
// team and athlete switcher, through the real handlers, loaders and templates with a fake fetch that keeps the
// routes' contracts: GET /api/calendar narrows to `athleteIds` inside the scope and answers a forged id with nothing;
// GET /api/organization answers the Settings read's shape, other clubs' memberships, users and join links included.
// Synthetic names only.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true };

const { state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { centralCalendarRosterIndex, handleCentralCalendarAction, handleCentralCalendarInput, handleCentralCalendarKeydown } = await import("../central-calendar-actions.js");
const data = await import("../central-calendar-data.js");
const view = await import("../central-calendar-view.js");
const k6 = await import("../central-calendar-athletes.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
const DAY = (offset) => addDaysIso(MONDAY, offset);
const U19 = "11111111-1111-4111-8111-111111111111";
const FIRST = "22222222-2222-4222-8222-222222222222";
const OTHER_CLUB_TEAM = "99999999-9999-4999-8999-999999999999";
const TEAMS = [{ teamId: FIRST, name: "First team" }, { teamId: U19, name: "U19" }];
const uuid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ANA = uuid(1);
const BEN = uuid(2);
const MARKO = uuid(3);
const X1 = uuid(4); // in U19 and in another club's team
const LOOSE = uuid(5); // in the club, no team
const ARCHIVED = uuid(6); // an archived-only tie: not in the roster
const OUTSIDE = uuid(7); // another team's athlete, outside a team coach's scope
const ROSTER = [
  { athlete_uuid: ANA, athlete_id: "R-1", athlete: "Ana Kovac" },
  { athlete_uuid: BEN, athlete_id: "R-2", athlete: "Ben Ilic" },
  { athlete_uuid: MARKO, athlete_id: "R-3", athlete: "Marko Šimić" },
  { athlete_uuid: X1, athlete_id: "R-4", athlete: "Xena Lukic" },
  { athlete_uuid: LOOSE, athlete_id: "R-5", athlete: "Lea Todic" },
];
const ORG = {
  athletes: [
    { id: ANA, name: "Ana Kovac", memberships: [{ membershipType: "team", status: "active", clubId: "club-1", clubName: "First Club", teamId: U19, teamName: "U19" }] },
    { id: BEN, name: "Ben Ilic", memberships: [{ membershipType: "team", status: "active", teamId: U19, teamName: "U19" }, { membershipType: "team", status: "archived", teamId: FIRST, teamName: "First team" }] },
    { id: MARKO, name: "Marko Šimić", memberships: [{ membershipType: "team", status: "active", teamId: FIRST, teamName: "First team" }] },
    { id: X1, name: "Xena Lukic", memberships: [{ membershipType: "team", status: "active", teamId: U19, teamName: "U19" }, { membershipType: "team", status: "active", clubId: "club-9", clubName: "Rival Club", teamId: OTHER_CLUB_TEAM, teamName: "Rival Seniors" }] },
    { id: LOOSE, name: "Lea Todic", memberships: [{ membershipType: "club", status: "active", clubId: "club-1", teamId: null }] },
    { id: ARCHIVED, name: "Archie Old", memberships: [{ membershipType: "team", status: "archived", teamId: U19, teamName: "U19" }] },
  ],
  users: [{ id: "u-1", email: "someone@example.invalid", name: "A User" }],
  joinLinks: [{ id: "j-1", token: "secret-join-token" }],
  clubs: [{ id: "club-9", name: "Rival Club" }],
};

const item = (overrides) => ({ key: "", kind: "planned", date: DAY(0), title: "Team training", slot: null, startTime: null, teamIds: [U19], athleteIds: [], athleteCount: 2, expects: [], status: "none", cancelled: false, links: {}, ...overrides });
const ITEMS = [
  item({ key: "planned:u19", title: "U19 training", athleteIds: [ANA, BEN, X1], athleteCount: 3 }),
  item({ key: "planned:first", title: "First team training", teamIds: [FIRST], athleteIds: [MARKO], athleteCount: 1 }),
  item({ key: "event:club-wide", kind: "event", title: "Club meeting", teamIds: [], athleteIds: [ANA, MARKO], athleteCount: 2, date: DAY(1) }),
  item({ key: "external:gym", kind: "external", title: "Gym", teamIds: [U19], athleteIds: [ANA], athleteCount: 1, date: DAY(2) }),
];

let workspaceType = "club";
function calendarAnswer(url) {
  const params = new URL(url, "http://localhost").searchParams;
  const from = params.get("from");
  const to = params.get("to");
  const athlete = params.get("athleteIds");
  const kinds = (params.get("kinds") || "").split(",").filter(Boolean);
  const days = [];
  for (let day = from; day <= to; day = addDaysIso(day, 1)) {
    const items = ITEMS.filter((entry) => entry.date === day)
      .filter((entry) => !kinds.length || kinds.includes(entry.kind))
      .filter((entry) => !athlete || entry.athleteIds.includes(athlete))
      .map((entry) => ({ ...entry, ...(athlete ? { athleteCount: 1 } : {}), ...(params.get("include") === "athletes" ? { athletes: (athlete ? [athlete] : entry.athleteIds).map((id) => ({ athleteId: id, name: ROSTER.find((r) => r.athlete_uuid === id)?.athlete || "Someone" })) } : {}) }));
    days.push({ date: day, items });
  }
  const teams = workspaceType === "club" ? TEAMS : workspaceType === "team" ? [TEAMS[1]] : workspaceType === "platform" ? TEAMS : [];
  return { from, to, today: params.get("today"), workspace: { type: workspaceType, scopeId: "scope-1" }, teams, days };
}
let orgResponder = () => ({ status: 200, body: ORG });
let calendarDelay = null;
function server() {
  return installFetchMock(async (call) => {
    if (call.url.startsWith("/api/calendar?")) {
      if (calendarDelay) await calendarDelay(call);
      return { status: 200, body: calendarAnswer(call.url) };
    }
    if (call.url === "/api/organization") return orgResponder(call);
    return { status: 404, body: { error: "not found" } };
  });
}

let rendered = "";
let layout = "wide";
const render = () => { rendered = view.renderCentralCalendarHtml(state.centralCalendar, { today: TODAY, layout, roster: centralCalendarRosterIndex() }); };
const dom = () => new JSDOM(`<!doctype html><body>${rendered}</body>`).window.document;
const act = (dataset, handlers = {}, options = {}) => handleCentralCalendarAction(fakeAction(dataset, options), { render, ...handlers });
const reads = (calls) => calls.filter((call) => call.url.startsWith("/api/calendar?")).map((call) => new URL(call.url, "http://localhost").searchParams);
const cardKeys = () => [...dom().querySelectorAll(".cc-card, .cc-daychip, .cc-mini")].map((node) => node.dataset.key);
const stripNames = () => [...dom().querySelectorAll(".cc-k6 .builder-batch-pill")].map((node) => node.getAttribute("aria-label"));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function signIn(type, roster = ROSTER) {
  workspaceType = type;
  state.currentUser = { id: "coach-1", activeWorkspace: { type, scopeId: "scope-1", label: "Somewhere" } };
  state.athletes = roster;
}

beforeEach(() => {
  clearAllViewCache();
  data.resetCentralCalendarForWorkspaceChange();
  signIn("club");
  state.activeTab = "central-calendar";
  layout = "wide";
  rendered = "";
  orgResponder = () => ({ status: 200, body: ORG });
  calendarDelay = null;
});

async function load() {
  const calls = server();
  await data.loadCentralCalendar({ render });
  await settle();
  render();
  return calls;
}

// --- The list per workspace (2.3, 2.4) ------------------------------------------------------------------------

test("1. a club: All groups is every roster athlete by team (the answer's order) then name, each team labelled with its dot; an athlete in two teams once; No team last", async () => {
  await load();
  assert.deepEqual(stripNames(), ["Everyone", "Marko Šimić", "Ana Kovac", "Ben Ilic", "Xena Lukic", "Lea Todic"]);
  const labels = [...dom().querySelectorAll(".cc-k6 .athlete-switcher-group-label")].map((node) => node.textContent);
  assert.deepEqual(labels, ["First team", "U19", "No team"]);
  assert.equal(dom().querySelectorAll('.cc-k6 .builder-batch-pill[aria-label="Xena Lukic"]').length, 1, "x1 once");
  assert.ok(dom().querySelector('.cc-k6 .builder-batch-pill[aria-label="Ana Kovac"] .athlete-switcher-dot'), "the team's dot");
  assert.equal(dom().querySelector(".cc-k6 .cc-k6-position"), null, "no N / M on Everyone");
});

test("2. a club, one team chosen: that team's athletes by name; another team switches over; the chosen one again is All groups", async () => {
  await load();
  await act({ action: "central-calendar-toggle-team", teamId: U19 });
  assert.deepEqual(stripNames(), ["Everyone", "Ana Kovac", "Ben Ilic", "Xena Lukic"]);
  assert.equal(dom().querySelector(".cc-k6 .athlete-switcher-group-label"), null);
  await act({ action: "central-calendar-toggle-team", teamId: FIRST });
  assert.deepEqual(stripNames(), ["Everyone", "Marko Šimić"]);
  await act({ action: "central-calendar-toggle-team", teamId: FIRST });
  assert.equal(state.centralCalendar.filters.teamIds.length, 0);
});

test("3. a team workspace: the roster by name, no Groups row, no GET /api/organization (F-H1)", async () => {
  signIn("team", ROSTER.slice(0, 2));
  const calls = await load();
  assert.deepEqual(stripNames(), ["Everyone", "Ana Kovac", "Ben Ilic"]);
  assert.equal(dom().querySelector(".cc-k6-groups"), null);
  assert.equal(calls.some((call) => call.url === "/api/organization"), false);
});

test("4. a private coach: the roster by name, no Groups row; the platform: no strip, no search, no organization read, no Showing line (F-H5)", async () => {
  signIn("private_coach", ROSTER.slice(0, 3));
  let calls = await load();
  assert.deepEqual(stripNames(), ["Everyone", "Ana Kovac", "Ben Ilic", "Marko Šimić"]);
  assert.equal(dom().querySelector(".cc-k6-groups"), null);
  assert.equal(calls.some((call) => call.url === "/api/organization"), false);
  clearAllViewCache();
  data.resetCentralCalendarForWorkspaceChange();
  signIn("platform", []);
  calls = await load();
  assert.equal(dom().querySelector(".cc-k6 .builder-batch-pills"), null, "no strip");
  assert.equal(dom().querySelector(".athlete-switcher-search"), null, "no search");
  assert.ok(dom().querySelector(".cc-k6-groups"), "the Groups row stays");
  assert.equal(calls.some((call) => call.url === "/api/organization"), false);
  state.centralCalendar.k6 = { ...data.emptyCentralCalendarK6State(), athleteId: ANA };
  state.athletes = ROSTER;
  render();
  assert.equal(data.centralCalendarChosenAthlete(state.centralCalendar), "", "a choice is never used in the platform");
  assert.equal(dom().querySelector(".cc-k6-line"), null);
});

test("5. over 60 athletes with All groups: no strip, the search and one sentence counting the strip's own list; a chosen team draws its strip", async () => {
  const many = Array.from({ length: 62 }, (_, i) => ({ athlete_uuid: uuid(100 + i), athlete_id: `R-${100 + i}`, athlete: `Athlete ${String(i).padStart(2, "0")}` }));
  signIn("club", many);
  orgResponder = () => ({ status: 200, body: { athletes: [...many.map((row) => ({ id: row.athlete_uuid, memberships: [{ membershipType: "team", status: "active", teamId: U19 }] })), ...ORG.athletes] } });
  await load();
  assert.equal(dom().querySelector(".cc-k6 .builder-batch-pills"), null);
  assert.equal(dom().querySelector(".cc-k6-searchonly").textContent, "62 athletes in the club. Search for an athlete, or choose a group.");
  assert.ok(dom().querySelector(".athlete-switcher-search-input"));
  await act({ action: "central-calendar-toggle-team", teamId: U19 });
  assert.equal(stripNames().length, 63);
});

// --- The read (2.5) -------------------------------------------------------------------------------------------

test("6. choosing an athlete reads athleteIds alone (never teamIds or clubIds) under its own key; her cards only; N / M; the unfiltered read keeps its key", async () => {
  const calls = await load();
  await act({ action: "central-calendar-toggle-team", teamId: U19 });
  await act({ action: "central-calendar-k6-athlete", athleteKey: ANA });
  const last = reads(calls).at(-1);
  assert.equal(last.get("athleteIds"), ANA);
  assert.equal(last.has("teamIds"), false);
  assert.equal(last.has("clubIds"), false);
  assert.deepEqual(cardKeys().sort(), ["event:club-wide", "external:gym", "planned:u19"].sort());
  assert.match(dom().querySelector(".cc-k6-position").textContent, /Ana Kovac\s+1 \/ 3/);
  const range = data.centralCalendarRange("week", state.centralCalendar.anchor);
  assert.notEqual(data.centralCalendarContextKey(range.from, range.to, TODAY), data.centralCalendarContextKey(range.from, range.to, TODAY, "", ANA));
  assert.equal(data.centralCalendarContextKey(range.from, range.to, TODAY, "planned", ANA).includes("athlete"), true);
  assert.equal(data.centralCalendarUrl(range.from, range.to, TODAY, { athleteIds: ANA, kinds: "planned" }).includes("teamIds"), false);
});

test("7. the Groups chips are suspended while an athlete is chosen (Q3): a club-wide event of hers stays", async () => {
  await load();
  await act({ action: "central-calendar-toggle-team", teamId: U19 });
  await act({ action: "central-calendar-k6-athlete", athleteKey: ANA });
  assert.ok(cardKeys().includes("event:club-wide"), "no team, still hers");
});

test("8. while her read is pending, and when it failed, no card of the unfiltered answer is drawn", async () => {
  await load();
  let release;
  calendarDelay = (call) => (call.url.includes("athleteIds") ? new Promise((resolve) => { release = resolve; }) : null);
  const pending = act({ action: "central-calendar-k6-athlete", athleteKey: BEN });
  await settle();
  assert.deepEqual(cardKeys(), [], "loading: nothing of everyone");
  assert.ok(dom().querySelector(".cc-state-loading"));
  release();
  await pending;
  calendarDelay = null;
  installFetchMock((call) => (call.url.includes("athleteIds") ? { status: 500, body: { error: "internal_error" } } : { status: 200, body: calendarAnswer(call.url) }));
  await act({ action: "central-calendar-k6-athlete", athleteKey: MARKO });
  assert.deepEqual(cardKeys(), [], "failed: nothing of everyone");
  assert.ok(dom().querySelector(".cc-state-error"));
});

test("9. a slower older athlete read is dropped: the later choice's cards are drawn", async () => {
  await load();
  let releaseAna;
  calendarDelay = (call) => (call.url.includes(ANA) ? new Promise((resolve) => { releaseAna = resolve; }) : null);
  const first = act({ action: "central-calendar-k6-athlete", athleteKey: ANA });
  await settle();
  await act({ action: "central-calendar-k6-athlete", athleteKey: MARKO });
  releaseAna();
  await first;
  assert.deepEqual(cardKeys().sort(), ["event:club-wide", "planned:first"].sort());
});

test("10. with Show only: the athlete read carries the kinds; the green line names her, her team and the kind; Show everyone keeps the kind; Clear filters clears her", async () => {
  const calls = await load();
  await act({ action: "central-calendar-show-only", kind: "external" });
  await act({ action: "central-calendar-k6-athlete", athleteKey: ANA });
  const last = reads(calls).at(-1);
  assert.equal(last.get("kinds"), "external");
  assert.equal(last.get("athleteIds"), ANA);
  assert.equal(dom().querySelector(".cc-k6-line span").textContent, "Showing Ana Kovac · U19 · only RPE requests");
  await act({ action: "central-calendar-k6-everyone" });
  assert.equal(dom().querySelector(".cc-k6-line"), null);
  assert.deepEqual(state.centralCalendar.filters.kinds, ["external"], "the kind stays");
  await act({ action: "central-calendar-k6-athlete", athleteKey: ANA });
  await act({ action: "central-calendar-clear-filters" });
  assert.equal(data.centralCalendarChosenAthlete(state.centralCalendar), "");
});

test("11. the green line of a team coach and a private coach names no team", async () => {
  signIn("team", ROSTER.slice(0, 2));
  await load();
  await act({ action: "central-calendar-k6-athlete", athleteKey: BEN });
  assert.equal(dom().querySelector(".cc-k6-line span").textContent, "Showing Ben Ilic");
});

test("12. ‹ › step through the strip without wrap: on Everyone ‹ is disabled, › chooses the first; on the last › is disabled", async () => {
  signIn("team", ROSTER.slice(0, 2));
  await load();
  const arrows = () => [...dom().querySelectorAll(".cc-k6 .icon-button")];
  assert.equal(arrows()[0].disabled, true);
  assert.equal(arrows()[1].dataset.athleteKey, ANA);
  await act({ action: "central-calendar-k6-athlete", athleteKey: arrows()[1].dataset.athleteKey });
  await act({ action: "central-calendar-k6-athlete", athleteKey: arrows()[1].dataset.athleteKey });
  assert.equal(data.centralCalendarChosenAthlete(state.centralCalendar), BEN);
  assert.equal(arrows()[1].disabled, true);
});

test("13. the search: accents and case ignored, word starts first, at most 8; a result of another team sets Groups to it and reads her week", async () => {
  // More than 8 in U19, so the search is drawn (2.6).
  const mates = Array.from({ length: 7 }, (_, i) => ({ athlete_uuid: uuid(300 + i), athlete_id: `R-${300 + i}`, athlete: `Team Mate ${i}` }));
  signIn("club", [...ROSTER, ...mates]);
  orgResponder = () => ({ status: 200, body: { athletes: [...ORG.athletes, ...mates.map((row) => ({ id: row.athlete_uuid, memberships: [{ membershipType: "team", status: "active", teamId: U19 }] }))] } });
  const calls = await load();
  await act({ action: "central-calendar-toggle-team", teamId: U19 });
  assert.ok(dom().querySelector(".athlete-switcher-search-input"), "drawn past 8");
  handleCentralCalendarInput({ dataset: { action: "central-calendar-k6-search" }, value: "mate" }, { render });
  render();
  assert.equal(dom().querySelectorAll(".athlete-switcher-result").length, 7);
  assert.equal(k6.centralCalendarK6Model(state.centralCalendar).searchList.length, 12);
  const input = { dataset: { action: "central-calendar-k6-search" }, value: "simi" };
  handleCentralCalendarInput(input, { render });
  render();
  const results = [...dom().querySelectorAll(".athlete-switcher-result")];
  assert.equal(results.length, 1);
  assert.match(results[0].textContent, /Marko Šimić/);
  assert.match(results[0].innerHTML, /<mark>Šimi<\/mark>/);
  assert.match(results[0].textContent, /First team/, "the team named in a club");
  await act({ action: "central-calendar-k6-athlete", athleteKey: MARKO }, {}, { closest: (selector) => (selector === ".athlete-switcher-search" ? {} : null) });
  assert.deepEqual(state.centralCalendar.filters.teamIds, [FIRST], "Groups follows her team");
  assert.equal(reads(calls).at(-1).get("athleteIds"), MARKO);
});

test("14. the search's keys: ↓ moves, Enter chooses, Escape clears", async () => {
  signIn("team", ROSTER);
  await load();
  handleCentralCalendarInput({ dataset: { action: "central-calendar-k6-search" }, value: "a" }, { render });
  const target = { dataset: { action: "central-calendar-k6-search" }, value: "a" };
  const key = (name) => handleCentralCalendarKeydown({ key: name, target, preventDefault() {}, stopPropagation() {} }, { render });
  assert.equal(key("ArrowDown"), true);
  assert.equal(state.centralCalendar.k6.searchIndex, 1);
  key("Enter");
  await settle();
  await settle();
  assert.ok(data.centralCalendarChosenAthlete(state.centralCalendar));
  handleCentralCalendarInput({ dataset: { action: "central-calendar-k6-search" }, value: "zz" }, { render });
  key("Escape");
  assert.equal(state.centralCalendar.k6.search, "");
});

// --- Info hiding (5.2) ----------------------------------------------------------------------------------------

test("F-H1. a team coach: a name of another team gives the team sentence, byte-identical to a name that exists nowhere; no other team's name anywhere", async () => {
  signIn("team", ROSTER.slice(0, 2));
  await load();
  const sentence = (query) => {
    data.centralCalendarK6(state.centralCalendar).search = query;
    return k6.centralCalendarK6Model(state.centralCalendar) && view.renderCentralCalendarHtml(state.centralCalendar, { today: TODAY, layout, roster: centralCalendarRosterIndex() });
  };
  const html = (query) => new JSDOM(sentence(query)).window.document.querySelector(".athlete-switcher-empty")?.textContent;
  // Force the search on for a short roster: the empty sentence is the search body's.
  const many = [...ROSTER.slice(0, 2), ...Array.from({ length: 8 }, (_, i) => ({ athlete_uuid: uuid(200 + i), athlete_id: `R-${200 + i}`, athlete: `Team Mate ${i}` }))];
  state.athletes = many;
  assert.equal(html("Marko").replace("Marko", "Q"), html("Qqqq").replace("Qqqq", "Q"));
  assert.equal(html("Marko"), "No athlete in this team matches ‘Marko’.");
  const box = new JSDOM(sentence("Marko")).window.document.querySelector(".cc-k6").outerHTML;
  assert.doesNotMatch(box, /First team|Šimić/, "the box names no other team or its athlete");
});

test("F-H2. a club: the organization read is reduced on arrival; the archived-only athlete and the other club's team are drawn nowhere and stored nowhere", async () => {
  await load();
  const html = view.renderCentralCalendarHtml(state.centralCalendar, { today: TODAY, layout, roster: centralCalendarRosterIndex() });
  assert.doesNotMatch(html, /Archie Old|Rival|someone@example|secret-join-token/);
  const stored = JSON.stringify(state.centralCalendar);
  assert.doesNotMatch(stored, /Rival|club-9|someone@example|secret-join-token|Archie|99999999-9999/);
  const pairs = state.centralCalendar.k6.organization.pairs;
  assert.ok(pairs.every((pair) => Object.keys(pair).sort().join() === "athleteUuid,teamId"));
  assert.ok(pairs.every((pair) => [U19, FIRST].includes(pair.teamId)));
  assert.equal(pairs.some((pair) => pair.athleteUuid === BEN && pair.teamId === FIRST), false, "an archived membership is not kept");
  assert.deepEqual(data.reduceCentralCalendarOrganization(ORG, { teamIds: new Set([U19]), rosterUuids: new Set([ANA, ARCHIVED]) }), [{ athleteUuid: ANA, teamId: U19 }]);
});

test("F-H3. a failed organization read: the roster by name with the retry sentence, nothing else", async () => {
  orgResponder = () => ({ status: 500, body: { error: "internal_error" } });
  await load();
  assert.deepEqual(stripNames(), ["Everyone", "Ana Kovac", "Ben Ilic", "Lea Todic", "Marko Šimić", "Xena Lukic"]);
  assert.match(dom().querySelector(".cc-k6-note").textContent, /Teams could not be loaded\. Try again/);
  assert.equal(dom().querySelector(".cc-k6 .athlete-switcher-dot"), null);
});

test("F-H6. a workspace switch clears the chosen athlete and team, the search and the organization pairs together", async () => {
  await load();
  await act({ action: "central-calendar-toggle-team", teamId: U19 });
  await act({ action: "central-calendar-k6-athlete", athleteKey: ANA });
  state.centralCalendar.k6.search = "an";
  data.resetCentralCalendarForWorkspaceChange();
  assert.equal(state.centralCalendar.k6, undefined);
  assert.deepEqual(state.centralCalendar.filters.teamIds, []);
});

test("F-H7. a slow organization read of W1 is dropped after the switch to W2; a remembered athlete no longer in the roster is never sent", async () => {
  let releaseOrg;
  orgResponder = () => new Promise((resolve) => { releaseOrg = () => resolve({ status: 200, body: ORG }); });
  const calls = server();
  await data.loadCentralCalendar({ render });
  data.resetCentralCalendarForWorkspaceChange();
  signIn("team", ROSTER.slice(0, 2));
  releaseOrg();
  await settle();
  assert.equal(state.centralCalendar.k6?.organization?.status ?? "idle", "idle", "W1's answer is not stored in W2");
  await data.loadCentralCalendar({ render });
  state.centralCalendar.k6 = { ...data.emptyCentralCalendarK6State(), athleteId: MARKO };
  await data.loadCentralCalendar({ render });
  assert.equal(reads(calls).some((params) => params.get("athleteIds") === MARKO), false, "never sent");
  assert.equal(state.centralCalendar.k6.athleteId, "", "dropped");
});

test("15. remembered across a view switch; the panel follows her (athleteIds on the day read) and Show everyone reads the item without her", async () => {
  const calls = await load();
  await act({ action: "central-calendar-k6-athlete", athleteKey: ANA });
  await act({ action: "central-calendar-view", view: "month" });
  assert.equal(data.centralCalendarChosenAthlete(state.centralCalendar), ANA);
  await act({ action: "central-calendar-view", view: "week" });
  await act({ action: "central-calendar-open-item", key: "planned:u19", date: DAY(0) });
  const dayRead = reads(calls).filter((params) => params.get("include") === "athletes").at(-1);
  assert.equal(dayRead.get("athleteIds"), ANA);
  assert.match(dom().querySelector(".cc-k6-panel-note").textContent, /Showing Ana Kovac only/);
  await act({ action: "central-calendar-k6-panel-everyone" });
  const again = reads(calls).filter((params) => params.get("include") === "athletes").at(-1);
  assert.equal(again.has("athleteIds"), false);
});

test("16. a phone: the box folds to one line naming the choice; a tap opens it; choosing folds it again; the green line stays", async () => {
  layout = "phone";
  await load();
  assert.equal(dom().querySelector(".cc-k6-fold-text").textContent, "Everyone");
  assert.ok(dom().querySelector("#ccK6Body").hasAttribute("hidden"));
  await act({ action: "central-calendar-k6-box" });
  assert.equal(dom().querySelector("#ccK6Body").hasAttribute("hidden"), false);
  await act({ action: "central-calendar-k6-athlete", athleteKey: ANA });
  assert.equal(dom().querySelector(".cc-k6-fold-text").textContent, "Ana Kovac · U19");
  assert.ok(dom().querySelector("#ccK6Body").hasAttribute("hidden"));
  assert.ok(dom().querySelector(".cc-k6-line"));
});

// K2b-1d2 (docs/ai/central-calendar-k2b-plan.md section 23, the manager's decisions in 23.6): the platform workspace's
// calendar names teams of several clubs. One helper names a team "U19 · Club" when it carries `clubName`, in every place
// the calendar names a team; the event form never takes the platform's teams. Through the real view and form templates
// over the API's answer shape; invented names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true };

const { emptyCentralCalendarState } = await import("../state.js");
const { centralCalendarTeamLabel } = await import("../central-calendar-data.js");
const { newCentralCalendarCreateForm } = await import("../central-calendar-event-form.js");
const view = await import("../central-calendar-view.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
const CLUB_A = "cccccccc-0000-4000-8000-00000000000a";
const CLUB_B = "cccccccc-0000-4000-8000-00000000000b";
const A_U19 = "11111111-1111-4111-8111-11111111111a";
const B_U19 = "11111111-1111-4111-8111-11111111111b";
const A_U17 = "22222222-2222-4222-8222-22222222222a";

// The platform's teams (backend loadWorkspaceTeams, K2b-1d2): each with its club's id and name.
const PLATFORM_TEAMS = [
  { teamId: A_U17, name: "U17", athleteCount: 18, colorKey: null, clubId: CLUB_A, clubName: "Club Alpha" },
  { teamId: A_U19, name: "U19", athleteCount: 20, colorKey: "teal", clubId: CLUB_A, clubName: "Club Alpha" },
  { teamId: B_U19, name: "U19", athleteCount: 21, colorKey: "teal", clubId: CLUB_B, clubName: "Club Beta" },
];
// A club's teams: no club keys (unchanged).
const CLUB_TEAMS = [
  { teamId: A_U17, name: "U17", athleteCount: 18, colorKey: null },
  { teamId: A_U19, name: "U19", athleteCount: 20, colorKey: "teal" },
];

function card(overrides) {
  return {
    key: "planned:x", kind: "planned", date: TODAY, title: "Team training", slot: { amPm: "AM", bta: "T", order: 1 }, startTime: "10:00",
    startsAt: null, teamIds: [], athleteIds: [], athleteCount: 0, expects: [], status: "none", rpe: null, attendance: null,
    results: null, cancelled: false, projected: false, links: {}, ...overrides,
  };
}

function answer(workspaceType, teams, items) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDaysIso(MONDAY, i);
    return { date, items: items.filter((item) => item.date === date) };
  });
  return { from: MONDAY, to: addDaysIso(MONDAY, 6), today: TODAY, workspace: { type: workspaceType, scopeId: workspaceType === "club" ? CLUB_A : null }, teams, days };
}

function render(workspaceType, teams, items, extra = {}) {
  const cal = { ...emptyCentralCalendarState(), anchor: TODAY, selectedDate: TODAY, view: "week", filtersOpen: true, data: answer(workspaceType, teams, items), ...extra };
  const html = view.renderCentralCalendarHtml(cal, { today: TODAY, layout: "wide" });
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
}

test("P1. the label: a team with its club reads \"U19 · Club Alpha\"; without a club its name as before; no team at all \"Team\"", () => {
  assert.equal(centralCalendarTeamLabel(PLATFORM_TEAMS[1]), "U19 · Club Alpha");
  assert.equal(centralCalendarTeamLabel(CLUB_TEAMS[1]), "U19");
  assert.equal(centralCalendarTeamLabel(undefined), "Team");
  assert.equal(centralCalendarTeamLabel({ name: "", clubName: "Club Beta" }), "Team · Club Beta");
});

test("P2. the platform's two U19 teams read apart everywhere the calendar names a team: Groups chips, a card's team, the day's legend", () => {
  const items = [
    card({ key: "planned:a", teamIds: [A_U19], athleteCount: 20 }),
    card({ key: "planned:b", teamIds: [B_U19], athleteCount: 21, startTime: "11:00" }),
  ];
  const doc = render("platform", PLATFORM_TEAMS, items, { view: "day" });
  const chips = [...doc.querySelectorAll("[data-action='central-calendar-toggle-team']")].map((el) => el.textContent.replace(/\s+/g, " ").trim());
  assert.ok(chips.some((t) => t.startsWith("U19 · Club Alpha")), chips.join(" | "));
  assert.ok(chips.some((t) => t.startsWith("U19 · Club Beta")), chips.join(" | "));
  assert.ok(chips.some((t) => t.startsWith("U17 · Club Alpha")), chips.join(" | "));
  // A card's own team pill (not the day's legend below).
  const cardTeams = [...doc.querySelectorAll(".cc-team-pill-name")].filter((el) => !el.closest(".cc-day-teams")).map((el) => el.textContent);
  assert.ok(cardTeams.includes("U19 · Club Alpha"), `a card names its team with the club: ${cardTeams.join(" | ")}`);
  assert.ok(cardTeams.includes("U19 · Club Beta"), cardTeams.join(" | "));
  // The day's legend (two teams with items that day).
  const legend = [...doc.querySelectorAll(".cc-day-teams .cc-team-pill-name")].map((el) => el.textContent);
  assert.ok(legend.some((t) => t.startsWith("U19 · Club Alpha · ")), legend.join(" | "));
  assert.ok(legend.some((t) => t.startsWith("U19 · Club Beta · ")), legend.join(" | "));
});

test("P2b. a club's name with markup is text everywhere a team is named: chips, a card's pill, the legend, the panel and its athlete rows (the independent review)", () => {
  const C_U21 = "44444444-4444-4444-8444-44444444444c";
  const markup = "<i id=pwn>Club Gamma</i>";
  const teams = [...PLATFORM_TEAMS, { teamId: C_U21, name: "U21", athleteCount: 1, colorKey: null, clubId: "cccccccc-0000-4000-8000-00000000000c", clubName: markup }];
  const items = [
    card({ key: "planned:c", teamIds: [C_U21], athleteCount: 1 }),
    card({ key: "planned:a", teamIds: [A_U19], athleteCount: 20, startTime: "11:00" }),
  ];
  const doc = render("platform", teams, items, {
    view: "day",
    panel: { open: true, key: "planned:c", date: TODAY, athletes: [{ athleteId: "aaaaaaaa-0000-4000-8000-0000000000c1", name: "Test Athlete", teamIds: [C_U21], rpe: "submitted" }], loading: false, error: "" },
  });
  assert.equal(doc.querySelector("#pwn"), null, "no element is made from a club's name");
  assert.equal(doc.querySelector("i"), null);
  const label = "U21 · <i id=pwn>Club Gamma</i>";
  const chips = [...doc.querySelectorAll("[data-action='central-calendar-toggle-team']")].map((el) => el.textContent);
  assert.ok(chips.some((t) => t.includes(label)), "the chip shows it as text");
  const pills = [...doc.querySelectorAll(".cc-team-pill-name")].map((el) => el.textContent);
  assert.ok(pills.some((t) => t === label), "a card's pill shows it as text");
  assert.ok(pills.some((t) => t.startsWith(`${label} · `)), "the legend shows it as text");
  assert.ok([...doc.querySelectorAll(".cc-panel-team")].some((el) => el.textContent.includes(label)), "the panel's teams show it as text");
  assert.ok([...doc.querySelectorAll(".cc-athlete-teams")].some((el) => el.textContent === label), "an athlete's row shows it as text");
});

test("P3. a club's workspace reads exactly as before: its teams' plain names, no club in them", () => {
  const items = [card({ key: "planned:a", teamIds: [A_U19], athleteCount: 20 })];
  const doc = render("club", CLUB_TEAMS, items);
  const chips = [...doc.querySelectorAll("[data-action='central-calendar-toggle-team']")].map((el) => el.textContent.replace(/\s+/g, " ").trim());
  assert.ok(chips.some((t) => t.startsWith("U19")), chips.join(" | "));
  assert.equal(doc.body.textContent.includes("·  Club") || doc.body.textContent.includes("Club Alpha"), false, "no club name in a club's own calendar");
});

test("P4. the event form never takes the platform's teams: with the same form, a club workspace offers its teams as targets, the platform none", () => {
  const owner = { scope: "club", id: CLUB_A, name: "Club Alpha" };
  // The guard is tested on its own: the targets are not read-only here (the platform's support edit also keeps them
  // read-only, a second guard).
  const formFor = () => newCentralCalendarCreateForm({ day: TODAY, owner, types: [], targets: [] });
  const clubDoc = render("club", CLUB_TEAMS, [], { form: formFor() });
  assert.ok(clubDoc.querySelectorAll("[data-cc-event-target='team']").length >= 2, "a club's form offers its teams");
  const platformDoc = render("platform", PLATFORM_TEAMS, [], { form: formFor() });
  assert.equal(platformDoc.querySelectorAll("[data-cc-event-target='team']").length, 0, "the platform's form offers no team");
  const platformForm = platformDoc.querySelector(".cc-event-form");
  assert.ok(platformForm, "the form is drawn");
  assert.equal(platformForm.textContent.includes("Club Beta"), false, "nothing of another club in the form");
});

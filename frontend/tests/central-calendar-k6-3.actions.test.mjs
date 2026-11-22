// K6-3 (docs/ai/central-calendar-k6-contract.md section 4, F-H4): See each athlete from an event's panel - offered to
// a manager (Open the week to a reader), one button per linked slot of the day, the list the panel's athletes
// intersected with the roster, a target without a link marked "not in this session". Synthetic names only.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true };

const { state } = await import("../state.js");
const { centralCalendarRosterIndex, handleCentralCalendarAction } = await import("../central-calendar-actions.js");
const data = await import("../central-calendar-data.js");
const view = await import("../central-calendar-view.js");

const DAY = "2026-10-12";
const uuid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ANA, BEN, CARA, OUT] = [1, 2, 3, 9].map(uuid);
const EVENT = { key: `event:ev-1:${DAY}`, kind: "event", date: DAY, title: "Team training", teamIds: [], athleteIds: [], athleteCount: 4, expects: [], status: "none", cancelled: false, links: {}, canManage: true };
const LINKS = [
  { id: "l1", day: DAY, amPm: "AM", bta: "T", order: 1, state: "linked", sessionName: "Main session", athleteId: ANA },
  { id: "l2", day: DAY, amPm: "AM", bta: "T", order: 1, state: "linked", sessionName: "Main session", athleteId: CARA },
];

let rendered = "";
const render = () => { rendered = view.renderCentralCalendarHtml(state.centralCalendar, { today: DAY, layout: "wide", roster: centralCalendarRosterIndex() }); };
const dom = () => new JSDOM(`<!doctype html><body>${rendered}</body>`).window.document;

function world({ manager = true, links = LINKS } = {}) {
  data.resetCentralCalendarForWorkspaceChange();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "team", scopeId: "t-1" } };
  state.activeTab = "central-calendar";
  state.athletes = [ANA, BEN, CARA].map((id, i) => ({ athlete_uuid: id, athlete_id: `R-${i + 1}`, athlete: ["Ana Kovac", "Ben Ilic", "Cara Lee"][i] }));
  const cal = state.centralCalendar;
  const item = { ...EVENT, canManage: manager };
  cal.anchor = DAY;
  cal.selectedDate = DAY;
  cal.data = { from: "2026-10-12", to: "2026-10-18", today: DAY, workspace: { type: "team", scopeId: "t-1" }, teams: [{ teamId: "t-1", name: "U19" }], days: [{ date: DAY, items: [item] }] };
  cal.panel = { open: true, key: item.key, date: DAY, athletes: [{ athleteId: BEN, name: "Ben Ilic" }, { athleteId: ANA, name: "Ana Kovac" }, { athleteId: OUT, name: "Olga Out" }, { athleteId: CARA, name: "Cara Lee" }], loading: false, error: "" };
  cal.panelEvent = manager ? { key: item.key, event: { id: "ev-1", sessionLinks: links } } : { key: item.key, event: { id: "ev-1" } };
  render();
  return item;
}

beforeEach(() => { rendered = ""; });

test("1. a manager: one See each athlete, the sentence counts the event's athletes in the roster, the outsider is counted, never named in the switcher", () => {
  world();
  const buttons = [...dom().querySelectorAll('[data-action="central-calendar-k6-each"]')];
  assert.deepEqual(buttons.map((node) => node.textContent), ["See each athlete"]);
  assert.match(dom().querySelector(".cc-k6-each").textContent, /Opens Main session, one athlete at a time, only the 3 of this event\./);
  assert.match(dom().querySelector(".cc-k6-each").textContent, /1 athlete of this event is not in your roster\./);
});

test("2. two linked slots on the day: one button per slot, named", () => {
  world({ links: [...LINKS, { id: "l3", day: DAY, amPm: "PM", bta: "A", order: 1, state: "linked", sessionName: "Gym", athleteId: BEN }] });
  assert.deepEqual([...dom().querySelectorAll('[data-action="central-calendar-k6-each"]')].map((node) => node.textContent), ["See each athlete · Main session", "See each athlete · Gym"]);
});

test("3. a reader: Open the week, no roster sentence (F-H4: the count is a manager's only)", () => {
  world({ manager: false });
  assert.deepEqual([...dom().querySelectorAll('[data-action="central-calendar-k6-each"]')].map((node) => node.textContent), ["Open the week"]);
  assert.doesNotMatch(dom().querySelector(".cc-k6-each").textContent, /not in your roster/);
});

test("4. the click opens the first athlete's plan on the day and the slot; the list is roster-only in the panel's order; a target without a link is marked", async () => {
  const item = world();
  const opened = [];
  const button = dom().querySelector('[data-action="central-calendar-k6-each"]');
  await handleCentralCalendarAction(fakeAction({ ...button.dataset }), { render, openWeeklyPlanForAthleteOnDate: async (...args) => opened.push(args) });
  assert.equal(opened.length, 1);
  const [id, date, { switcher, slot }] = opened[0];
  assert.equal(id, "R-1");
  assert.equal(date, DAY);
  assert.deepEqual(slot, { amPm: "AM", bta: "T" });
  assert.deepEqual(switcher.athletes.map((athlete) => athlete.name), ["Ana Kovac", "Ben Ilic", "Cara Lee"]);
  assert.equal(switcher.athletes.find((athlete) => athlete.name === "Ben Ilic").mark, "–", "Ben is a target without a link");
  assert.equal(switcher.athletes.some((athlete) => athlete.name === "Olga Out"), false);
  assert.equal(switcher.context, "in this event");
  assert.equal(item.key, state.centralCalendar.panel.key, "the panel stays open behind, for Back");
});

test("5. F-H4: without the roster intersection the outsider would be listed (mutation guard): every key is a roster id", async () => {
  world();
  const opened = [];
  const button = dom().querySelector('[data-action="central-calendar-k6-each"]');
  await handleCentralCalendarAction(fakeAction({ ...button.dataset }), { render, openWeeklyPlanForAthleteOnDate: async (...args) => opened.push(args) });
  assert.ok(opened[0][2].switcher.athletes.every((athlete) => /^R-\d$/.test(athlete.key)));
});

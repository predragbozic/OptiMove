// K6-3 (docs/ai/central-calendar-k6-contract.md 4, 6.1): See each athlete from an event's panel.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true };
const { state } = await import("../state.js");
const { handleCentralCalendarAction } = await import("../central-calendar-actions.js");
const data = await import("../central-calendar-data.js");
const view = await import("../central-calendar-view.js");
const { localDateIso } = await import("../utils.js");

const TODAY = localDateIso();
const uuid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const KEY = "event:e1";
const EVENT = { key: KEY, kind: "event", eventKind: "training", eventId: "e1", date: TODAY, title: "Main session", teamIds: [], athleteIds: [], athleteCount: 5, expects: [], status: "none", rpe: null, cancelled: false, projected: false, canManage: true, links: {} };
let rendered = "";
const render = () => { rendered = view.renderCentralCalendarHtml(state.centralCalendar, { today: TODAY, layout: "wide" }); };
const dom = () => new JSDOM(`<!doctype html><body>${rendered}</body>`).window.document;

function world({ manager = true, panelAthletes, links }) {
  const cal = state.centralCalendar;
  cal.anchor = TODAY; cal.selectedDate = TODAY;
  cal.data = { from: TODAY, to: TODAY, today: TODAY, workspace: { type: "club", scopeId: "c" }, teams: [], days: [{ date: TODAY, items: [{ ...EVENT, canManage: manager }] }] };
  cal.panel = { open: true, key: KEY, date: TODAY, athletes: panelAthletes, loading: false, error: "" };
  cal.panelEvent = manager ? { key: KEY, event: { sessionLinks: links }, loading: false, error: "" } : null;
  render();
}
const A = (n, name, targeted = true) => ({ athleteId: uuid(n), name, targeted, teamIds: [] });
const link = (n, slot) => ({ planId: `p${n}`, day: TODAY, amPm: slot.amPm, bta: slot.bta, order: 1, athleteId: uuid(n), sessionName: slot.name });

beforeEach(() => {
  data.resetCentralCalendarForWorkspaceChange();
  state.activeTab = "central-calendar";
  state.athletes = [1, 2, 3, 4, 5].map((n) => ({ athlete_uuid: uuid(n), athlete_id: `R${n}`, athlete: `Athlete ${n}` }));
});

test("a manager is offered See each athlete; one button per linked slot", () => {
  const main = { amPm: "PM", bta: "T", name: "Main session" };
  const gym = { amPm: "AM", bta: "B", name: "Gym" };
  world({ panelAthletes: [1, 2, 3, 4, 5].map((n) => A(n, `Athlete ${n}`)), links: [link(1, main), link(2, main), link(3, gym)] });
  const buttons = [...dom().querySelectorAll('[data-action="central-calendar-see-each-athlete"]')];
  assert.deepEqual(buttons.map((b) => b.textContent), ["See each athlete · Main session · Training (PM)", "See each athlete · Gym · Before training (AM)"]);
  world({ panelAthletes: [1, 2].map((n) => A(n, `Athlete ${n}`)), links: [link(1, main)] });
  assert.equal(dom().querySelector('[data-action="central-calendar-see-each-athlete"]').textContent, "See each athlete");
  assert.match(dom().querySelector(".cc-see-each").textContent, /one athlete at a time, only the 2 of this event/);
});

test("unnamed slots are told apart by their own facts; the note names the same slot; no ids", () => {
  const slots = [{ amPm: "AM", bta: "B", name: "" }, { amPm: "AM", bta: "T", name: "" }, { amPm: "PM", bta: "", name: "" }, { amPm: "", bta: "A", name: "" }, { amPm: "", bta: "", name: "" }];
  world({ panelAthletes: [1, 2, 3, 4, 5].map((n) => A(n, `Athlete ${n}`)), links: slots.map((slot, i) => link(i + 1, slot)) });
  const doc = dom();
  const buttons = [...doc.querySelectorAll('[data-action="central-calendar-see-each-athlete"]')];
  assert.deepEqual(buttons.map((b) => b.textContent), [
    "See each athlete · Before training (AM)", "See each athlete · Training (AM)", "See each athlete · Session (PM)",
    "See each athlete · After training", "See each athlete · Session",
  ]);
  assert.equal(new Set(buttons.map((b) => b.textContent)).size, 5);
  assert.deepEqual(buttons.map((b) => b.classList.contains("cc-primary")), [true, false, false, false, false]);
  const notes = [...doc.querySelectorAll(".cc-see-each .cc-panel-note")].map((n) => n.textContent);
  assert.match(notes[0], /^Opens Before training \(AM\), one athlete at a time, only the 5 of this event\.$/);
  assert.equal(notes.length, 5);
});

test("a link whose Builder session was deleted gets no button; a later link names a slot the first left unnamed", () => {
  const live = { amPm: "AM", bta: "T", name: "Ankle&Endurance" };
  const orphan = (n, slot) => ({ ...link(n, slot), state: "orphaned", sessionName: null, athleteId: null });
  const unnamedFirst = { ...link(1, { amPm: "AM", bta: "T", name: "" }), state: "linked" };
  world({ panelAthletes: [1, 2, 3].map((n) => A(n, `Athlete ${n}`)), links: [orphan(5, { amPm: "", bta: "T" }), orphan(6, { amPm: "PM", bta: "T" }), unnamedFirst, { ...link(2, live), state: "linked" }] });
  const buttons = [...dom().querySelectorAll('[data-action="central-calendar-see-each-athlete"]')];
  assert.deepEqual(buttons.map((b) => b.textContent), ["See each athlete"], "one live slot; the deleted ones are not offered");
  assert.match(dom().querySelector(".cc-see-each .cc-panel-note").textContent, /^Opens Ankle&Endurance · Training \(AM\),/);
  world({ panelAthletes: [1, 2].map((n) => A(n, `Athlete ${n}`)), links: [orphan(5, { amPm: "", bta: "T" })] });
  assert.match(dom().querySelector(".cc-see-each").textContent, /Open the week/, "only deleted links: the plain week button");
});

test("slots that would still read the same are numbered in slot order", async () => {
  const mod = await import("../central-calendar-switcher.js");
  assert.deepEqual(mod.centralCalendarSlotLabels([{ name: "", amPm: "", bta: "" }, { name: "", amPm: "", bta: "" }, { name: "Gym", amPm: "", bta: "" }]), ["Session 1", "Session 2", "Gym"]);
});

test("a reader gets Open the week and never the not-in-your-roster sentence", () => {
  world({ manager: false, panelAthletes: [A(1, "Athlete 1"), A(77, "Hidden Person")], links: [] });
  const html = dom().querySelector(".cc-see-each").textContent;
  assert.match(html, /Open the week/);
  assert.equal(/not in your roster/.test(html), false);
});

test("F-H4. a panel athlete not in the roster is not in the switcher; the sentence counts them, for a manager", async () => {
  const main = { amPm: "PM", bta: "T", name: "Main session" };
  world({ panelAthletes: [A(1, "Athlete 1"), A(2, "Athlete 2"), A(88, "Outsider One"), A(99, "Outsider Two")], links: [link(1, main)] });
  assert.match(dom().querySelector(".cc-see-each").textContent, /2 athletes of this event are not in your roster/);
  const opened = [];
  await handleCentralCalendarAction(fakeAction({ action: "central-calendar-see-each-athlete", slotIndex: "0" }), { render, openWeeklyPlanForAthleteOnDate: async (...args) => opened.push(args) });
  const flow = opened[0][2].flow;
  assert.deepEqual(flow.keys, [uuid(1), uuid(2)], "only roster athletes, in the panel's order");
  assert.equal(flow.hiddenCount, 2);
  assert.equal(opened[0][0], "R1", "the first athlete with a linked session opens");
  assert.deepEqual(flow.notInKeys, [uuid(2)], "a target without a link is 'not in this session' from the start");
  assert.deepEqual(flow.slot, { amPm: "PM", bta: "T" });
  assert.equal(opened[0][1], TODAY);
});

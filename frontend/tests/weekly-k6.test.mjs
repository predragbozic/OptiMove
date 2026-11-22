// K6-2 (docs/ai/central-calendar-k6-contract.md 3.2, S6): the next athlete's plan opens on the same day and slot, and
// below it the same domain, category and section by type and name. The weekly data and the node builders are the
// real ones (program-structure.js), the place logic is weekly-athlete-switcher.js. Synthetic names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.crypto ??= (await import("node:crypto")).webcrypto;
const { createNode, nextNodes, sessionNodes, structureNodes } = await import("../program-structure.js");
const w = await import("../weekly-athlete-switcher.js");
const { renderWeeklyAthleteSwitcherHtml } = w;

const DAY = "2026-10-12"; // a Monday
let nodeSeq = 0;
const makeNode = (type, label, items, options) => createNode(type, label, items, options);
const ex = (overrides) => ({ date: DAY, amPm: "", bta: "T", sessionName: "", title: `Exercise ${(nodeSeq += 1)}`, item_type: "exercise", ...overrides });
const week = (items) => ({ weeks: [{ weekStart: DAY, days: [{ date: DAY, slots: { AM: { B: [], T: items, A: [] }, PM: { B: [], T: [], A: [] } } }] }] });
const strength = (sections, extra = {}) => sections.map((section, i) => ex({ domain: "Strength", domain_node_id: `d-${extra.tag || ""}`, section, section_node_id: `s-${extra.tag || ""}-${i}`, ...extra }));

// A's place: drill from the week (a structure node of the slot), then down by name.
function drill(data, ...names) {
  const items = w.weeklyDayItems(data, DAY);
  const top = structureNodes(items.filter((item) => item.bta === "T"), makeNode);
  const stack = [top.find((node) => node.label === names[0])];
  for (const name of names.slice(1)) stack.push(nextNodes(stack.at(-1), makeNode).find((node) => node.label === name));
  return stack;
}
const place = (data, stack) => w.describeWeeklyPlace({ data, navStack: stack, selectedDay: DAY, makeNode });
const rebuild = (data, p) => w.rebuildWeeklyPlace({ data, place: p, makeNode });

test("1. the same slot with differently named sessions (labels differ) reaches the next athlete's slot", () => {
  const a = week(strength(["Power"], { tag: "a", sessionName: "Main session" }));
  const b = week(strength(["Power"], { tag: "b", sessionName: "Morning lift" }));
  const aBta = sessionNodes(w.weeklyDayItems(a, DAY), makeNode)[0];
  assert.equal(aBta.type, "bta");
  const result = rebuild(b, place(a, [aBta]));
  assert.equal(result.stop, null);
  assert.equal(result.navStack[0].type, "bta");
  assert.match(result.navStack[0].label, /Morning lift/, "B's own session");
});

test("2. S6: Strength › Power reaches B's Strength › Power, B's \" power \" (case and spaces differ) included; the kept line is in B's names", () => {
  const a = week(strength(["Power"], { tag: "a", sessionName: "Main session" }));
  const b = week(strength([" power "], { tag: "b", sessionName: "Main session" }));
  const result = rebuild(b, place(a, drill(a, "Strength", "Power")));
  assert.equal(result.stop, null);
  assert.deepEqual(result.navStack.map((node) => [node.type, node.label]), [["domain", "Strength"], ["section", "power"]]);
  assert.equal(w.weeklyKeptLine(place(a, []), result.navStack).replace(/^\S+ /, ""), "12.10 · Training · Main session · Strength · power");
  assert.equal(w.weeklyDayLabel(DAY), "Monday 12.10");
});

test("3. B's Strength has Speed and no Power: stops at Strength, never a different node; the line names the section and where, never \"on this day\"", () => {
  const a = week(strength(["Power"], { tag: "a" }));
  const b = week([...strength(["Speed"], { tag: "b" }), ex({ bta: "T", domain: "Gym", domain_node_id: "g", section: "Power", section_node_id: "gp" })]);
  const p = place(a, drill(a, "Strength", "Power"));
  const result = rebuild(b, p);
  assert.deepEqual(result.navStack.map((node) => node.type), ["domain"]);
  assert.equal(result.navStack[0].label, "Strength");
  assert.equal(result.navStack.some((node) => node.label === "Speed"), false);
  const line = w.weeklyStopLine(result.stop, { place: p, navStack: result.navStack, athleteName: "Ben", fromName: "Ana" });
  assert.equal(line, "Ben has no ‘Power’ section in Strength.");
  assert.doesNotMatch(line, /on this day/);
});

test("4. B with two Power sections: stops at Strength (ambiguous), never guesses; A with two: stops at the parent and names A", () => {
  const a = week(strength(["Power"], { tag: "a" }));
  const b = week(strength(["Power", "Power"], { tag: "b" }));
  const p = place(a, drill(a, "Strength", "Power"));
  const inB = rebuild(b, p);
  assert.deepEqual(inB.navStack.map((node) => node.label), ["Strength"]);
  assert.equal(w.weeklyStopLine(inB.stop, { place: p, navStack: inB.navStack, athleteName: "Ben", fromName: "Ana" }), "Ben has two ‘Power’ sections in Strength. Choose one below.");
  const a2 = week(strength(["Power", "Power"], { tag: "a" }));
  const p2 = place(a2, drill(a2, "Strength", "Power"));
  const fromA = rebuild(week(strength(["Power"], { tag: "b" })), p2);
  assert.deepEqual(fromA.navStack.map((node) => node.label), ["Strength"]);
  const line = w.weeklyStopLine(fromA.stop, { place: p2, navStack: fromA.navStack, athleteName: "Ben", fromName: "Ana" });
  assert.match(line, /^Ana has .*‘Power’ sections here, so Ben's plan opens at Strength\.$/);
  assert.doesNotMatch(line, /You have/);
});

test("5. a missing slot stops at the day and says so", () => {
  const a = week(strength(["Power"], { tag: "a", amPm: "PM" }));
  const b = week(strength(["Power"], { tag: "b", amPm: "AM" }));
  const aPm = sessionNodes(w.weeklyDayItems(a, DAY), makeNode).find((node) => node.type === "amPm");
  const p = place(a, [aPm, nextNodes(aPm, makeNode)[0]]);
  const result = rebuild(b, p);
  assert.deepEqual(result.navStack, []);
  assert.equal(w.weeklyStopLine(result.stop, { place: p, navStack: [], athleteName: "Ben", fromName: "Ana" }), "Ben has no PM session on Monday 12.10.");
});

test("6. the blank group across shapes: A's session node (a day with AM/PM) and B's one top-level bta(\"\", T) share the slot key", () => {
  const a = week([...strength(["Power"], { tag: "a" }), ex({ amPm: "AM", bta: "T", domain: "Run", domain_node_id: "r" })]);
  const aSession = sessionNodes(w.weeklyDayItems(a, DAY), makeNode).find((node) => node.type === "session");
  assert.ok(aSession, "A's blank group is a session node");
  const aBta = nextNodes(aSession, makeNode);
  // From A's structure node inside the blank group, B (no AM/PM at all) reaches the same structure node.
  const b = week(strength(["Power"], { tag: "b" }));
  const result = rebuild(b, place(a, [aBta.find((node) => node.label === "Strength")]));
  assert.equal(result.stop, null);
  assert.equal(result.navStack[0].label, "Strength");
});

test("7. a node name with markup is drawn as text in the line", () => {
  const html = renderWeeklyAthleteSwitcherHtml({ athletes: [{ key: "1", name: "Ana" }, { key: "2", name: "Ben" }], currentId: "1", stopLine: "Ben has no ‘<img src=x onerror=alert(1)>’ section in Strength." });
  const d = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  assert.equal(d.querySelector("img"), null);
  assert.match(d.querySelector(".weekly-k6-stop").textContent, /<img src=x onerror=alert\(1\)>/);
});

test("8. the header: Back to calendar, the athlete with N / M, the strip with Previous / Next athlete (never the node arrows' labels), No plan this week", () => {
  const html = renderWeeklyAthleteSwitcherHtml({ athletes: [{ key: "1", name: "Ana" }, { key: "2", name: "Ben", mark: "–", markLabel: "not in this session" }], currentId: "1", teamLabel: "U19", context: "in this event", noPlan: true });
  const d = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  assert.ok(d.querySelector('[data-action="weekly-back-to-calendar"]'));
  assert.equal(d.querySelector(".weekly-k6-head").textContent, "Ana · U19 · 1 / 2 in this event");
  assert.deepEqual([...d.querySelectorAll(".icon-button")].map((node) => node.getAttribute("aria-label")), ["Previous athlete", "Next athlete"]);
  assert.equal(d.querySelector('.builder-batch-pill[data-athlete-key="2"]').getAttribute("aria-label"), "Ben, not in this session");
  assert.match(d.querySelector(".weekly-k6-noplan").textContent, /No plan this week/);
  assert.ok(d.querySelector('.weekly-k6-noplan [data-action="weekly-create-plan"]'));
});

test("9. sameNodeName: trims, collapses spaces, lower-cases, keeps accents", () => {
  assert.equal(w.weeklySameNodeName("  Snaga   Gornji  "), "snaga gornji");
  assert.notEqual(w.weeklySameNodeName("Snága"), w.weeklySameNodeName("Snaga"));
});

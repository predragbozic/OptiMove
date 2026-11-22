// K6-2, the Weekly plan's athlete switcher (docs/ai/central-calendar-k6-contract.md section 3). When the coach opened
// the plan from the central calendar, ‹ › open the same place in the next athlete's plan: the same week and day, the
// same slot (AM/PM, B/T/A - never the session's label, which carries each athlete's own name and time), and below it
// the same domain, category and section matched by type and name (S6). Where the next athlete has no such node, or
// two, the path stops at the deepest clear match and one calm line says what is missing. Switching pushes no history
// entry (Q6). Pure functions: app.js holds the state and the renders.
import { renderAthleteSwitcherStripHtml } from "./athlete-switcher.js";
import { btaNodes, nextNodes, sessionNodes, structureNodes } from "./program-structure.js";
import { escapeHtml } from "./utils.js";
import { allSlotItems } from "./weekly-plan.js";

const SESSION_TYPES = new Set(["amPm", "bta", "session"]);
const STRUCTURE_WORDS = { domain: "domain", category: "category", section: "section" };
const BTA_LABELS = { B: "Before training", T: "Training", A: "After training", "": "Session" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const COUNT_WORDS = { 2: "two", 3: "three", 4: "four" };

const amPmOf = (item) => (item?.amPm === "AM" || item?.amPm === "PM" ? item.amPm : "");

// A structure node's name for matching (S6): trimmed, inner whitespace collapsed, lower-cased without a locale, so a
// device's language never changes the answer; accents kept. (sameNodePosition, the node footer's rule, is unchanged.)
export function weeklySameNodeName(label) {
  return String(label ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function weeklyDayItems(data, date) {
  for (const week of data?.weeks || []) {
    for (const day of week.days || []) if (day.date === date) return allSlotItems(day.slots);
  }
  return [];
}

// "Monday 12.10".
export function weeklyDayLabel(date) {
  const [year, month, day] = String(date || "").slice(0, 10).split("-");
  if (!day) return String(date || "");
  return `${WEEKDAYS[new Date(`${year}-${month}-${day}T12:00:00`).getDay()]} ${day}.${month}`;
}

// The slot a node of the session levels stands for, from its own items. A bta node of a day without AM/PM and the
// blank-AM/PM group of a day with AM/PM have the same key ("", bta), so the two shapes match each other.
function slotOf(node) {
  const item = node.items?.[0] || {};
  if (node.type === "amPm") return { amPm: amPmOf(item), bta: null };
  if (node.type === "session") return { amPm: "", bta: null };
  return { amPm: amPmOf(item), bta: item.bta || "" };
}

function slotItems(dayItems, slot) {
  return dayItems.filter((item) => amPmOf(item) === slot.amPm && (slot.bta === null || (item.bta || "") === slot.bta));
}

function slotLabel(slot) {
  const base = slot.bta === null ? (slot.amPm ? `${slot.amPm} session` : "Session") : BTA_LABELS[slot.bta] || "Session";
  return slot.bta !== null && slot.amPm ? `${base} (${slot.amPm})` : base;
}

// The candidates of one level, built the way the Weekly plan builds them. The first level's are the nodes of the
// slot on that day: the session node itself, or the structure nodes inside it.
function candidatesFor(level, index, parent, dayItems, makeNode) {
  if (index > 0) return nextNodes(parent, makeNode);
  const items = slotItems(dayItems, level.slot);
  if (!items.length) return null;
  if (level.type === "amPm" || level.type === "session") return sessionNodes(dayItems, makeNode).filter((node) => node.type === level.type);
  if (level.type === "bta") return btaNodes(items, makeNode);
  return structureNodes(items, makeNode);
}

function matchesOf(level, candidates) {
  if (SESSION_TYPES.has(level.type)) {
    return candidates.filter((node) => node.type === level.type && JSON.stringify(slotOf(node)) === JSON.stringify(level.slot));
  }
  return candidates.filter((node) => node.type === level.type && weeklySameNodeName(node.label) === level.name);
}

// A's place: the day, then each level of navStack (its slot or its type and name), each marked when A's own day has
// two of it at that level (then B's plan opens at the parent: never a guess).
export function describeWeeklyPlace({ data, navStack, selectedDay, makeNode }) {
  const date = navStack?.[0]?.items?.[0]?.date ? String(navStack[0].items[0].date).slice(0, 10) : selectedDay;
  const dayItems = weeklyDayItems(data, date);
  const levels = [];
  let parent = null;
  (navStack || []).forEach((node, index) => {
    const level = { type: node.type, label: node.label, name: weeklySameNodeName(node.label), slot: index === 0 ? slotOf(node) : null };
    if (index === 0 && !SESSION_TYPES.has(node.type)) level.slot = slotOf(node);
    const candidates = candidatesFor(level, index, parent, dayItems, makeNode) || [];
    level.ambiguousInA = !SESSION_TYPES.has(node.type) && matchesOf(level, candidates).length > 1;
    levels.push(level);
    parent = node;
  });
  return { date, levels };
}

// B's path for A's place: { navStack, stop } where stop says why it ended early (null when everything matched).
export function rebuildWeeklyPlace({ data, place, makeNode }) {
  const dayItems = weeklyDayItems(data, place.date);
  const path = [];
  let parent = null;
  for (let index = 0; index < place.levels.length; index += 1) {
    const level = place.levels[index];
    if (level.ambiguousInA) return { navStack: path, stop: { reason: "ambiguous_a", level, index } };
    const candidates = candidatesFor(level, index, parent, dayItems, makeNode);
    if (candidates === null) return { navStack: path, stop: { reason: "missing_slot", level, index } };
    const matches = matchesOf(level, candidates);
    if (matches.length !== 1) return { navStack: path, stop: { reason: matches.length ? "ambiguous_b" : "missing", level, index, count: matches.length } };
    path.push(matches[0]);
    parent = matches[0];
  }
  return { navStack: path, stop: null };
}

function sessionNameOf(items) {
  return (items || []).find((item) => item.sessionName)?.sessionName || "";
}

// The quiet line of what is kept, in B's own names: "Monday 12.10 · Training · Main session · Strength · Power".
export function weeklyKeptLine(place, navStack) {
  const parts = [weeklyDayLabel(place.date)];
  const first = navStack[0];
  if (first) {
    parts.push(slotLabel(slotOf(first)));
    const name = sessionNameOf(first.items);
    if (name) parts.push(name);
    for (const node of navStack) if (!SESSION_TYPES.has(node.type)) parts.push(node.label);
  }
  return parts.join(" · ");
}

// The calm line when the path stopped early; "" when it did not. Names are plain text here, escaped where drawn.
export function weeklyStopLine(stop, { place, navStack, athleteName, fromName }) {
  if (!stop) return "";
  const level = stop.level;
  const where = navStack.length ? navStack[navStack.length - 1].label : (level.slot ? slotLabel(level.slot) : weeklyDayLabel(place.date));
  const word = STRUCTURE_WORDS[level.type] || "session";
  if (stop.reason === "missing_slot") return `${athleteName} has no ${slotLabel(level.slot)} on ${weeklyDayLabel(place.date)}.`;
  if (stop.reason === "missing") {
    if (SESSION_TYPES.has(level.type)) return `${athleteName} has no ${slotLabel(level.slot || { amPm: "", bta: "" })} on ${weeklyDayLabel(place.date)}.`;
    return `${athleteName} has no ‘${level.label}’ ${word} in ${where}.`;
  }
  if (stop.reason === "ambiguous_b") return `${athleteName} has ${COUNT_WORDS[stop.count] || stop.count} ‘${level.label}’ ${word}s in ${where}. Choose one below.`;
  const opensAt = navStack.length ? navStack[navStack.length - 1].label : weeklyDayLabel(place.date);
  return `${fromName} has two or more ‘${level.label}’ ${word}s here, so ${athleteName}'s plan opens at ${opensAt}.`;
}

// The header above the week or the node (contract 3.1): Back to calendar, the current athlete with her place in the
// list, the strip, and the line of what is kept or missing.
export function renderWeeklyAthleteSwitcherHtml({ athletes, currentId, teamLabel = "", line = "", stopLine = "", noPlan = false, busy = false, context = "" }) {
  const index = athletes.findIndex((athlete) => athlete.key === currentId);
  const current = athletes[index];
  const head = current
    ? `<p class="weekly-k6-head"><strong>${escapeHtml(current.name)}</strong>${teamLabel ? ` · ${escapeHtml(teamLabel)}` : ""}${athletes.length > 1 ? ` · <span class="weekly-k6-count">${index + 1} / ${athletes.length}${context ? ` ${escapeHtml(context)}` : ""}</span>` : ""}</p>`
    : "";
  const strip = athletes.length > 1
    ? renderAthleteSwitcherStripHtml({ items: athletes, currentKey: currentId, action: "weekly-k6-athlete", keyAttr: "data-athlete-key", ariaLabel: "Athletes", wrapArrows: false })
    : "";
  return `<section class="weekly-k6${busy ? " is-busy" : ""}" aria-label="Athletes"${busy ? ' aria-busy="true"' : ""}>
      <button type="button" class="plain-button weekly-k6-back" data-action="weekly-back-to-calendar"><span class="button-icon" aria-hidden="true">←</span><span>Back to calendar</span></button>
      ${head}
      ${strip}
      ${line ? `<p class="weekly-k6-line">${escapeHtml(line)}</p>` : ""}
      ${stopLine ? `<p class="weekly-k6-stop" role="status">${escapeHtml(stopLine)}</p>` : ""}
      ${noPlan ? `<p class="weekly-k6-noplan">No plan this week <button type="button" class="plain-button cc-inline-button" data-action="weekly-create-plan">Plan it in the Builder</button></p>` : ""}
    </section>`;
}

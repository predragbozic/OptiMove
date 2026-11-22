// K6-2 / K6-3 (docs/ai/central-calendar-k6-contract.md, sections 3 and 4): the Weekly plan's athlete switcher.
// Pure functions: finding the same place in another athlete's plan, and the header's markup. The state it needs
// lives in `state.centralCalendar.weeklyFlow` (the calendar's slice: replaced on a workspace change), the loading
// and the navigation in app.js.
import { renderAthleteSwitcherStripHtml } from "./athlete-switcher.js";
import { btaNodes, createNode, nextNodes as childNodes, sessionNodes, structureNodes } from "./program-structure.js";
import { allSlotItems } from "./weekly-plan.js";
import { escapeAttr, escapeHtml, formatDayMonth } from "./utils.js";

const SLOT_TYPES = new Set(["amPm", "session", "bta"]);
const TYPE_WORDS = { domain: "domain", category: "category", section: "section", bta: "session", session: "session", amPm: "half-day" };
const BTA_WORDS = { B: "Before training", T: "Training", A: "After training", "": "Session" };

// The new, locale-free name compare of S6: the type equal, the label trimmed, inner whitespace collapsed,
// lower-cased (no locale, accents kept). Today's `sameNodePosition` (app.js) stays as it is for the node footer.
export function normalizedNodeName(label) {
  return String(label ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function sameNodeName(left, right) {
  return Boolean(left && right) && left.type === right.type && normalizedNodeName(left.label) === normalizedNodeName(right.label);
}

const itemAmPm = (item) => (item?.amPm === "AM" || item?.amPm === "PM" ? item.amPm : "");

// The slot key of a node, from its own items (never from its label or id): an amPm node by its half-day, a bta
// node by (half-day, B/T/A), the blank `session` group by ("", "").
export function slotKeyOfNode(node) {
  const first = (node?.items || [])[0] || {};
  if (node?.type === "amPm") return `${itemAmPm(first)}|`;
  if (node?.type === "session") return "|";
  if (node?.type === "bta") return `${itemAmPm(first)}|${first.bta || ""}`;
  return "";
}

// The slot (half-day, B/T/A) a structure node (domain, category, section) sits in, from its items.
function slotOfStructureNode(node) {
  const first = (node?.items || [])[0] || {};
  return { amPm: itemAmPm(first), bta: first.bta || "" };
}

export function slotWords(slot) {
  const word = BTA_WORDS[slot?.bta || ""] || "Session";
  return slot?.amPm ? `${word} (${slot.amPm})` : word;
}

// The day's items of a weekly answer.
export function weeklyDayItems(weeklyData, weekStart, date) {
  const week = (weeklyData?.weeks || []).find((entry) => entry.weekStart === weekStart) || (weeklyData?.weeks || []).find((entry) => (entry.days || []).some((day) => day.date === date));
  const day = (week?.days || []).find((entry) => entry.date === date);
  return day ? allSlotItems(day.slots) : [];
}

function topNodes(items) {
  return sessionNodes(items, createNode);
}

// The nodes one level below `parent` in A's or B's plan: the day's session nodes at the top, the structure nodes of
// a slot when the path starts below the session levels (a tap on a domain, category or section).
function siblingsOf(parent, items, slot) {
  if (parent) return childNodes(parent, createNode);
  if (slot) return structureNodes(items.filter((item) => itemAmPm(item) === slot.amPm && (item.bta || "") === slot.bta), createNode);
  return topNodes(items);
}

// What A's place is: the path of nodes the coach drilled into, each with whether A's own plan holds another node of
// the same type and name beside it (then B's plan opens at the parent, never a guess).
export function captureWeeklyPlace({ weekStart, day, navStack = [], dayItems = [] }) {
  const path = [];
  const first = navStack[0];
  const slot = first && !SLOT_TYPES.has(first.type) ? slotOfStructureNode(first) : null;
  let parent = null;
  navStack.forEach((node, index) => {
    const siblings = siblingsOf(parent, dayItems, index === 0 ? slot : null);
    const same = SLOT_TYPES.has(node.type)
      ? siblings.filter((other) => other.type === node.type && slotKeyOfNode(other) === slotKeyOfNode(node))
      : siblings.filter((other) => sameNodeName(other, node));
    path.push({ type: node.type, label: node.label, slotKey: slotKeyOfNode(node), ambiguousInA: same.length > 1 });
    parent = node;
  });
  return { weekStart, day, slot, path };
}

function dayLongLabel(date) {
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(new Date(`${String(date).slice(0, 10)}T12:00:00`));
  return `${weekday} ${formatDayMonth(date)}`;
}

// The same place in B's plan, level by level, stopping at the deepest level that matched: never a different node.
// Returns the path of B's own nodes, the plain `line` that says what is missing or ambiguous (escaped where it is
// drawn), and `kept`, the quiet line of what was kept.
export function matchWeeklyPlace(place, dayItems, { aName = "This athlete", bName = "This athlete" } = {}) {
  const result = { path: [], line: "", kept: "" };
  if (!place?.path?.length) return result;
  const dayLabel = dayLongLabel(place.day);
  const slot = place.slot;
  if (slot) {
    const inSlot = dayItems.filter((item) => itemAmPm(item) === slot.amPm && (item.bta || "") === slot.bta);
    if (!inSlot.length) {
      result.line = `${bName} has no ${slotWords(slot)} on ${dayLabel}.`;
      return result;
    }
  }
  let parent = null;
  let parentLabel = slot ? slotWords(slot) : "this day";
  let skipSessionBta = false;
  for (let index = 0; index < place.path.length; index += 1) {
    const target = place.path[index];
    if (skipSessionBta && target.type === "bta") {
      skipSessionBta = false;
      continue;
    }
    const word = TYPE_WORDS[target.type] || "node";
    const quoted = `‘${String(target.label ?? "")}’`;
    if (target.ambiguousInA) {
      result.line = `${aName} has two ${quoted} ${word}s here, so ${bName}'s plan opens at ${parentLabel}.`;
      break;
    }
    const siblings = siblingsOf(parent, dayItems, index === 0 ? slot : null);
    let matches;
    if (SLOT_TYPES.has(target.type)) {
      matches = siblings.filter((node) => node.type === target.type && slotKeyOfNode(node) === target.slotKey);
      // The blank group across shapes: A's `session` node is B's single top-level blank-half-day bta node, and the
      // reverse (a blank bta of A is inside B's `session` node).
      if (!matches.length && target.type === "session") {
        const blanks = siblings.filter((node) => node.type === "bta" && slotKeyOfNode(node).startsWith("|"));
        if (blanks.length === 1) {
          matches = blanks;
          skipSessionBta = true;
        } else if (blanks.length > 1) {
          result.line = `${bName} has several sessions without a half-day on ${dayLabel}. Choose one below.`;
          break;
        }
      }
      if (!matches.length && target.type === "bta" && !parent) {
        const session = siblings.filter((node) => node.type === "session");
        if (session.length === 1) {
          result.path.push(session[0]);
          parent = session[0];
          const inside = childNodes(session[0], createNode).filter((node) => node.type === "bta" && slotKeyOfNode(node) === target.slotKey);
          matches = inside;
        }
      }
    } else {
      matches = siblings.filter((node) => sameNodeName({ type: target.type, label: target.label }, node));
    }
    if (!matches.length) {
      result.line = SLOT_TYPES.has(target.type)
        ? `${bName} has no ${slotWords({ amPm: target.slotKey.split("|")[0], bta: target.slotKey.split("|")[1] || "" })} on ${dayLabel}.`
        : `${bName} has no ${quoted} ${word} in ${parentLabel}.`;
      break;
    }
    if (matches.length > 1) {
      result.line = `${bName} has two ${quoted} ${word}s in ${parentLabel}. Choose one below.`;
      break;
    }
    result.path.push(matches[0]);
    parent = matches[0];
    parentLabel = matches[0].label;
  }
  if (result.path.length && !result.line) {
    const slotWord = slot ? slotWords(slot) : "";
    result.kept = [dayLabel, ...(slotWord ? [slotWord] : []), ...result.path.map((node) => node.label)].join(" · ");
  } else if (result.path.length) {
    result.kept = [dayLabel, ...result.path.map((node) => node.label)].join(" · ");
  }
  return result;
}

// K6-3: the nodes that open an event's linked slot on a day (amPm or session, then the bta node), by the same
// builders the tap uses. Empty when the athlete's day has no node of the slot.
export function slotPathFor(dayItems, slot) {
  if (!slot) return [];
  const items = dayItems.filter((item) => itemAmPm(item) === (slot.amPm || "") && (item.bta || "") === (slot.bta || ""));
  if (!items.length) return [];
  const tops = topNodes(dayItems);
  const hasHalves = tops.some((node) => node.type === "amPm" || node.type === "session");
  if (!hasHalves) return btaNodes(dayItems, createNode).filter((node) => slotKeyOfNode(node) === `|${slot.bta || ""}`);
  const top = tops.find((node) => (node.type === "amPm" && slotKeyOfNode(node) === `${slot.amPm || ""}|`) || (node.type === "session" && !slot.amPm));
  if (!top) return [];
  const bta = btaNodes(top.items, createNode).find((node) => slotKeyOfNode(node).split("|")[1] === (slot.bta || ""));
  return bta ? [top, bta] : [];
}

// --- The header ----------------------------------------------------------------

// `flow` is `state.centralCalendar.weeklyFlow`; `items` are the strip's ({ key, name, imageUrl, notInSession }).
export function renderWeeklySwitcherHtml({ flow, items, currentKey, groupsHtml = "", teamLabel = "", hiddenNote = "", noPlan = false, stripHidden = false }) {
  if (!flow || !items || !items.length) return "";
  const index = items.findIndex((item) => item.key === currentKey);
  const current = index >= 0 ? items[index] : null;
  const back = `<button type="button" class="plain-button weekly-k6-back" data-action="weekly-back-to-calendar">&lsaquo; ${flow.origin === "home" ? "Back to Home" : "Back to calendar"}</button>`;
  if (items.length < 2) return `<section class="weekly-k6" aria-label="Athletes">${back}</section>`;
  const position = index >= 0 ? `${index + 1} / ${items.length}${flow.listLabel ? ` ${flow.listLabel}` : flow.eventKey ? " in this event" : ""}` : "";
  const strip = renderAthleteSwitcherStripHtml({ items, currentKey, action: "weekly-k6-pick", keyAttr: "data-athlete-key", ariaLabel: "Athletes", wrapArrows: false });
  const summary = current ? `<p class="weekly-k6-summary"><strong>${escapeHtml(current.name)}</strong>${teamLabel ? ` · ${escapeHtml(teamLabel)}` : ""}${position ? ` · <span>${escapeHtml(position)}</span>` : ""}</p>` : "";
  const notice = flow.line ? `<p class="weekly-k6-line" role="status">${escapeHtml(flow.line)}</p>` : flow.kept ? `<p class="weekly-k6-kept">${escapeHtml(flow.kept)}</p>` : "";
  const notIn = flow.notInKeys?.includes(currentKey) && flow.eventKey ? `<p class="weekly-k6-line" role="status"><strong>Not in this session</strong> · ${escapeHtml(flow.notInLine || "")}</p>` : "";
  const plan = noPlan ? `<p class="weekly-k6-line" role="status">No plan this week</p><button type="button" class="plain-button cc-primary" data-action="weekly-create-plan" aria-label="Plan it in the Builder">Plan it in the Builder</button>` : "";
  // K6 follow-up: the strip can be hidden (remembered per user); who is chosen and the one control to show it stay.
  const toggle = `<button type="button" class="plain-button weekly-k6-strip-toggle" data-action="weekly-k6-strip-toggle" aria-expanded="${stripHidden ? "false" : "true"}">${stripHidden ? "Show athletes" : "Hide athletes"}</button>`;
  return `<section class="weekly-k6${stripHidden ? " is-collapsed" : ""}" aria-label="Athletes">
      ${back}
      ${stripHidden ? "" : groupsHtml}
      <div class="weekly-k6-controls"${flow.busy ? ` inert aria-busy="true"` : ""}><div class="weekly-k6-head">${summary}${toggle}</div>${stripHidden ? "" : strip}</div>
      ${hiddenNote ? `<p class="weekly-k6-hidden">${escapeHtml(hiddenNote)}</p>` : ""}${flow.scopeNote ? `<p class="weekly-k6-hidden weekly-k6-scope">${escapeHtml(flow.scopeNote)}</p>` : ""}${notice}${notIn}${plan}
    </section>`;
}

export const weeklyK6Key = (value) => escapeAttr(String(value ?? ""));

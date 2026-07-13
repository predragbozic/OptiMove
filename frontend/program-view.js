import { renderImage } from "./media.js";
import { btaNodes, sessionNodes, structureNodes } from "./program-structure.js";
import {
  allSlotItems,
} from "./weekly-plan.js";
import {
  countLabel,
  escapeAttr,
  escapeHtml,
  formatDate,
  formatDayMonth,
  formatWeekday,
  localDateIso,
} from "./utils.js";

export function renderWeekCalendarDayHtml(day, selectedDate) {
  const classes = [
    "week-calendar-day",
    day.isOutside ? "is-outside" : "",
    day.hasItems ? "has-items" : "",
    day.date === localDateIso() ? "is-today" : "",
    day.date === selectedDate ? "is-active-week" : "",
  ].filter(Boolean).join(" ");
  const content = `
    <span class="week-calendar-day-number">${escapeHtml(String(day.dayNumber))}</span>
    ${day.hasItems ? `<span class="week-calendar-dot"></span><span class="week-calendar-count">${day.itemCount}</span>` : ""}
  `;
  if (!day.hasItems) {
    return `<span class="${classes}" aria-label="${escapeAttr(day.date)}">${content}</span>`;
  }
  return `
    <button class="${classes}" data-action="week-day-select" data-date="${escapeAttr(day.date)}" aria-label="${escapeAttr(`${formatDate(day.date)}, ${day.itemCount} items`)}">
      ${content}
    </button>
  `;
}

export function renderDayEntryHtml(day, makeNode) {
  const items = allSlotItems(day.slots);
  const isToday = day.date === localDateIso();
  return `
    <article class="calendar-day ${isToday ? "is-today" : ""}" data-date="${escapeAttr(day.date)}">
      <div class="calendar-day-head">
        <span class="calendar-weekday">${escapeHtml(formatWeekday(day.date))}</span>
        <span class="calendar-date">${escapeHtml(formatDayMonth(day.date))}${isToday ? " · Today" : ""}</span>
      </div>
      ${day.dayNote ? `<div class="calendar-note">${escapeHtml(day.dayNote)}</div>` : ""}
      <div class="calendar-events">
        ${items.length ? renderCalendarHierarchyHtml(items, makeNode) : `<div class="calendar-empty">No entries</div>`}
      </div>
    </article>
  `;
}

export function renderCalendarHierarchyHtml(items, makeNode) {
  return sessionNodes(items, makeNode).map((node) => renderCalendarSessionHtml(node, makeNode)).join("");
}

export function renderCalendarSessionHtml(node, makeNode) {
  if (node.type === "amPm" || node.type === "session") {
    return `
      <div class="calendar-session">
        <div class="calendar-session-label">${escapeHtml(node.label)}</div>
        ${renderCalendarBtaGroupsHtml(node.items, makeNode)}
      </div>
    `;
  }

  if (node.type === "bta") return renderCalendarBtaGroupHtml(node, makeNode);
  return renderCalendarEventHtml(node);
}

export function renderCalendarBtaGroupsHtml(items, makeNode) {
  const nodes = btaNodes(items, makeNode);
  if (nodes.length) return nodes.map((node) => renderCalendarBtaGroupHtml(node, makeNode)).join("");
  const directNodes = structureNodes(items, makeNode);
  return directNodes.length ? directNodes.map(renderCalendarEventHtml).join("") : "";
}

export function renderCalendarBtaGroupHtml(node, makeNode) {
  const children = structureNodes(node.items, makeNode);
  const eventNodes = children.length ? children : [node];
  return `
    <div class="calendar-bta">
      <div class="calendar-bta-label">${escapeHtml(node.label)}</div>
      <div class="calendar-bta-events">
        ${eventNodes.map(renderCalendarEventHtml).join("")}
      </div>
    </div>
  `;
}

export function renderCalendarEventHtml(node) {
  if (!node.items.length) return "";
  const shortNote = node.shortNote || node.note || "";
  return `
    <button class="calendar-event" data-action="node" data-node-id="${escapeAttr(node.id)}" style="${node.color ? `--node-color:${escapeAttr(node.color)}` : ""}">
      <span class="calendar-event-head">
        ${node.icon ? `${renderImage(node.icon, "calendar-event-icon")}<span class="calendar-event-dot calendar-event-dot-fallback"></span>` : `<span class="calendar-event-dot"></span>`}
        <span class="calendar-event-title">${escapeHtml(node.label)}</span>
      </span>
      ${shortNote ? `<span class="calendar-event-note">${escapeHtml(shortNote)}</span>` : ""}
      <span class="calendar-event-count">${escapeHtml(node.subtitle || countLabel(node.items))}</span>
    </button>
  `;
}

export function renderProgramDayCardHtml(node, makeNode) {
  return `
    <article class="program-day-card">
      <div class="program-day-head">
        <div>
          <h4>${escapeHtml(node.label)}</h4>
        </div>
        <span class="item-badge">${escapeHtml(node.subtitle || countLabel(node.items))}</span>
      </div>
      <div class="calendar-events">
        ${node.items.length ? renderCalendarHierarchyHtml(node.items, makeNode) : `<div class="calendar-empty">No entries</div>`}
      </div>
    </article>
  `;
}

export function renderNodeButtonHtml(node) {
  if (!node.items.length) return "";
  return `
    <button class="node-card" data-action="node" data-node-id="${escapeAttr(node.id)}" style="${node.color ? `--node-color:${escapeAttr(node.color)}` : ""}">
      <span class="node-card-head">
        ${node.icon ? `${renderImage(node.icon, "node-icon")}<span class="node-dot node-dot-fallback"></span>` : `<span class="node-dot"></span>`}
        <span>
          <span class="node-title">${escapeHtml(node.label)}</span>
          <span class="node-sub">${escapeHtml(node.subtitle || countLabel(node.items))}</span>
        </span>
      </span>
      ${node.note ? `<span class="node-note-short">${escapeHtml(node.note)}</span>` : ""}
    </button>
  `;
}

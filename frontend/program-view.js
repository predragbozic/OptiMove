import { renderImage } from "./media.js";
import { isAthleteMode } from "./access.js";
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
  truncate,
} from "./utils.js";

const ICON_NEW_PLAN = `
  <svg viewBox="0 0 24 24" class="rail-icon" aria-hidden="true">
    <path d="M6 3.5h8l4 4v11a1.5 1.5 0 0 1-1.5 1.5h-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    <path d="M6 3.5A1.5 1.5 0 0 0 4.5 5v14A1.5 1.5 0 0 0 6 20.5h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    <path d="M8.5 9h6M8.5 12.5h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
    <circle cx="17.5" cy="17.5" r="4.5" fill="currentColor"></circle>
    <path d="M17.5 15.3v4.4M15.3 17.5h4.4" stroke="var(--surface, #fff)" stroke-width="1.4" stroke-linecap="round"></path>
  </svg>
`;

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
  const label = day.hasItems ? `${formatDate(day.date)}, ${day.itemCount} items` : formatDate(day.date);
  return `
    <button class="${classes}" data-action="week-day-select" data-date="${escapeAttr(day.date)}" aria-label="${escapeAttr(label)}">
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
  const shortNote = truncate(node.shortNote || node.note || "", 40);
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

export function renderWeeklyRootHtml({
  activeWeek,
  copyPlanModal,
  makeNode,
  renderPlanMoreMenu,
  weekSelectorMarkup,
}) {
  const weekRange = `${formatDate(activeWeek.weekStart)} - ${formatDate(activeWeek.weekEnd)}`;
  return `
    <div class="content-section">
      <div class="week-nav-wrap">
      <section class="week-nav-panel">
        <button class="plain-button week-arrow-button" data-action="week-prev" aria-label="Previous week">‹</button>
        <button class="week-title-button" type="button" data-action="week-toggle" aria-expanded="${Boolean(weekSelectorMarkup)}" aria-label="Choose weekly plan date">
          <strong>${escapeHtml(weekRange)}</strong>
        </button>
        <button class="plain-button week-today-button" data-action="week-today">Today</button>
        <button class="plain-button week-arrow-button" data-action="week-next" aria-label="Next week">›</button>
        ${activeWeek.planId ? renderPlanMoreMenu(activeWeek.planId, "weekly") : isAthleteMode() ? "" : `<button class="plain-button icon-button week-new-plan-button" type="button" data-action="weekly-create-plan" aria-label="Create weekly plan" title="Create weekly plan">${ICON_NEW_PLAN}</button>`}
      </section>
      ${weekSelectorMarkup}
      </div>
      <section class="panel">
        <div class="calendar-grid">
          ${(activeWeek.days || []).map((day) => renderDayEntryHtml(day, makeNode)).join("")}
        </div>
      </section>
    </div>
    ${copyPlanModal}
  `;
}

export function renderProgramToolbarHtml(programs, selectedProgramId, renderPlanMoreMenu) {
  return `
    <div class="chip-row program-toolbar">
      ${programs.map((program) => `
        <button class="chip ${program.id === selectedProgramId ? "is-active" : ""}" data-program-id="${escapeAttr(program.id)}">
          ${escapeHtml(program.name)}
        </button>
      `).join("")}
      ${selectedProgramId ? renderPlanMoreMenu(selectedProgramId, "program") : ""}
    </div>
  `;
}

// hotfix/athlete-mobile-navigation: athlete-mode only - the rail of
// program cards (athlete-programs-view.js) and this detail both live on
// the same screen (master-detail, not a separate route), so there's
// normally nothing to "go back" from. On mobile, once the detail is long
// enough to scroll, the rail scrolls out of view above it - this bar gives
// a one-tap way back up to it without a re-fetch (data-action="athlete-
// program-back" just scrolls to the top of the page, see handleContentClick
// in app.js; the rail/search state was never torn down). Desktop hides it
// via CSS (.athlete-program-open-header below) since the rail is already
// visible there without scrolling.
function renderProgramOpenHeaderHtml(program) {
  if (!isAthleteMode()) return "";
  return `
    <div class="athlete-program-open-header">
      <button class="athlete-program-back-button" type="button" data-action="athlete-program-back" aria-label="Back to Specific programs">
        <span class="button-icon">←</span> Back
      </button>
      <span class="athlete-program-open-name">${escapeHtml(program.name)}</span>
    </div>
  `;
}

export function renderProgramRootHtml({
  copyPlanModal,
  data,
  groups,
  isMicrocycle,
  program,
  renderNodeButton,
  renderPlanMoreMenu,
  renderProgramDayCard,
}) {
  return `
    ${renderProgramOpenHeaderHtml(program)}
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Specific program</p>
          <h3>${escapeHtml(program.name)}</h3>
        </div>
        <div class="builder-source-actions"><span class="item-badge">${data.rows?.length || 0} items</span>${renderPlanMoreMenu(program.id, "program")}</div>
      </div>
      ${isMicrocycle
        ? `<div class="node-grid">${groups.map(renderNodeButton).join("")}</div>`
        : `<div class="program-day-grid">${groups.map(renderProgramDayCard).join("")}</div>`}
    </section>
    ${copyPlanModal}
  `;
}

export function renderNodeDetailHtml({ crumbs, next, node, renderNodeButton, siblingState, terminalHtml }) {
  return `
    <section class="panel node-detail-panel">
      <div class="drill-header">
        <div>
          <p class="eyebrow">${escapeHtml(node.typeLabel || node.type)}</p>
          <h3>${escapeHtml(node.label)}</h3>
          <div class="breadcrumb">${crumbs.map(escapeHtml).join(" / ")}</div>
        </div>
      </div>
      <div class="node-detail-body">
        ${node.note ? `<p class="node-note">${escapeHtml(node.note)}</p>` : ""}
        ${next.length
          ? `<div class="node-grid">${next.map(renderNodeButton).join("")}</div>`
          : terminalHtml}
      </div>
      <nav class="node-detail-footer">
        <button class="footer-nav-button" type="button" data-action="back"><span class="button-icon">←</span><span>Back</span></button>
        ${siblingState.hasSiblings ? `<button class="footer-nav-button" type="button" data-action="node-prev" ${siblingState.canGoPrevious ? "" : "disabled"}><span class="button-icon">‹</span><span>Previous</span></button>` : ""}
        ${siblingState.hasSiblings ? `<span class="exercise-position">${siblingState.index + 1} / ${siblingState.total}</span>` : ""}
        ${siblingState.hasSiblings ? `<button class="footer-nav-button" type="button" data-action="node-next" ${siblingState.canGoNext ? "" : "disabled"}><span class="button-icon">›</span><span>Next</span></button>` : ""}
        <button class="footer-nav-button" type="button" data-action="home"><span class="button-icon">⌂</span><span>Home</span></button>
      </nav>
    </section>
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

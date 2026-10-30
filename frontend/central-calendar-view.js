import { CENTRAL_CALENDAR_KINDS } from "./central-calendar-data.js";
import { addDaysIso, escapeAttr, escapeHtml, monthLabel, monthWeeksIso, weekMondayIso } from "./utils.js";

// Central calendar (K1b) - the screen over GET /api/calendar, read-only
// (docs/ai/central-calendar-k1b-plan.md). Pure template strings: the
// toolbar, the Groups and Types chips, a month, a week (the server's slot
// order as a list, or a time grid on a wide screen) or a day, the card and
// the item panel. The server groups (D16) and orders (D13) - nothing here
// regroups or re-sorts a day's items; the chips only hide whole cards.
// `layout` is "phone" (<= 760 px), "medium" (761-1023 px) or "wide"
// (>= 1024 px), decided by the actions module from window.matchMedia.

export const CENTRAL_CALENDAR_KIND_LABELS = Object.freeze({ planned: "Training", activity: "Activities", external: "Events", test: "Tests" });
// Eight fixed colours by the team's position in the answer's teams[] (D11:
// the club picks its own in K2). Their values are the --cc-team-N tokens
// in styles.css; a card or a chip only names the index.
export const CENTRAL_CALENDAR_PALETTE_SIZE = 8;
const BTA_WORDS = Object.freeze({ B: "Before", T: "Training", A: "After" });
const EVENT_TYPE_LABELS = Object.freeze({
  match: "Match", friendly: "Friendly match", tournament: "Tournament", training: "Training", travel: "Travel",
  meeting: "Meeting", camp: "Camp", recovery: "Recovery", rest: "Rest", other: "Event",
});
const DAY_GRID_START_HOUR = 6;
const DAY_GRID_END_HOUR = 21;
const MONTH_CELL_CARDS = 3;

function dateAtNoon(iso) {
  return new Date(`${String(iso).slice(0, 10)}T12:00:00`);
}

export function centralCalendarLongDate(iso) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(dateAtNoon(iso));
}

function shortDate(iso, { year = false } = {}) {
  const options = { day: "numeric", month: "short" };
  if (year) options.year = "numeric";
  return new Intl.DateTimeFormat("en-GB", options).format(dateAtNoon(iso));
}

function weekdayShort(iso) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(dateAtNoon(iso));
}

function dayNumber(iso) {
  return Number(String(iso).slice(8, 10));
}

// The toolbar's label: "October 2026", "26 Oct - 1 Nov 2026", "Thursday 30 October 2026".
export function centralCalendarPeriodLabel(view, anchor) {
  if (view === "month") return monthLabel(`${anchor.slice(0, 7)}-01`);
  if (view === "day") return centralCalendarLongDate(anchor);
  const monday = weekMondayIso(anchor);
  const sunday = addDaysIso(monday, 6);
  const sameYear = monday.slice(0, 4) === sunday.slice(0, 4);
  return `${shortDate(monday, { year: !sameYear })} - ${shortDate(sunday, { year: true })}`;
}

// The days a view shows: the month grid's weeks, the anchor's week, or the one day.
export function centralCalendarDisplayedDays(view, anchor) {
  if (view === "month") return monthWeeksIso(anchor.slice(0, 7)).flat();
  if (view === "day") return [anchor];
  const monday = weekMondayIso(anchor);
  return Array.from({ length: 7 }, (_, index) => addDaysIso(monday, index));
}

export function centralCalendarItemsByDate(data) {
  const byDate = new Map();
  for (const day of data?.days || []) byDate.set(day.date, Array.isArray(day.items) ? day.items : []);
  return byDate;
}

// Decision A: a card is hidden when it carries none of the chosen teams or
// its kind is not chosen. Nothing inside a card changes.
export function centralCalendarVisibleItems(items, filters) {
  const teamIds = filters?.teamIds || [];
  const kinds = filters?.kinds || [];
  return (items || []).filter((item) => {
    if (kinds.length && !kinds.includes(item.kind)) return false;
    if (teamIds.length && !(item.teamIds || []).some((id) => teamIds.includes(id))) return false;
    return true;
  });
}

// The chips' counts over the displayed days, from the unfiltered answer.
export function centralCalendarChipCounts(byDate, days) {
  const teams = new Map();
  const kinds = Object.fromEntries(CENTRAL_CALENDAR_KINDS.map((kind) => [kind, 0]));
  for (const date of days) {
    for (const item of byDate.get(date) || []) {
      if (item.kind in kinds) kinds[item.kind] += 1;
      for (const teamId of item.teamIds || []) teams.set(teamId, (teams.get(teamId) || 0) + 1);
    }
  }
  return { teams, kinds };
}

export function centralCalendarTeamIndex(teamId, teams) {
  const index = (teams || []).findIndex((team) => team.teamId === teamId);
  return index < 0 ? -1 : index % CENTRAL_CALENDAR_PALETTE_SIZE;
}

function teamColorStyle(teamId, teams) {
  const index = centralCalendarTeamIndex(teamId, teams);
  return index < 0 ? "" : ` style="--cc-team-color: var(--cc-team-${index})"`;
}

function teamName(teamId, teams) {
  return (teams || []).find((team) => team.teamId === teamId)?.name || "Team";
}

function eventTypeLabel(eventType) {
  if (!eventType) return "";
  return EVENT_TYPE_LABELS[eventType] || String(eventType).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function centralCalendarTitle(item) {
  if (item.title) return item.title;
  if (item.kind === "planned") return "Training session";
  if (item.kind === "activity") return "Activity";
  if (item.kind === "external") return eventTypeLabel(item.eventType) || "Event";
  if (item.kind === "test") return "Test";
  return "Item";
}

function athleteCountLabel(count) {
  return `${count} athlete${count === 1 ? "" : "s"}`;
}

// The small word under the title: what kind of thing the card is.
export function centralCalendarKindLabel(item) {
  const count = Number(item.athleteCount) || 0;
  if (item.kind === "planned") return `Training · ${athleteCountLabel(count)}`;
  if (item.kind === "activity") {
    const word = item.origin === "api_import" || item.origin === "source_import" ? "Imported activity" : "Activity";
    return count ? `${word} · ${athleteCountLabel(count)}` : word;
  }
  if (item.kind === "external") {
    const type = eventTypeLabel(item.eventType);
    return `Event${type && type !== "Event" && type !== item.title ? ` · ${type}` : ""}${count ? ` · ${athleteCountLabel(count)}` : ""}`;
  }
  if (item.kind === "test") return `Test${count ? ` · ${athleteCountLabel(count)}` : ""}`;
  return "";
}

// A start time when the item has one, else the slot words (AM/PM, then
// Before/Training/After); `slot.order` is never shown.
export function centralCalendarWhenLabel(item) {
  if (item.startTime) return String(item.startTime).slice(0, 5);
  const slot = item.slot;
  if (!slot) return "";
  const parts = [];
  if (slot.amPm) parts.push(slot.amPm);
  if (slot.bta && BTA_WORDS[slot.bta]) parts.push(BTA_WORDS[slot.bta]);
  return parts.join(" · ");
}

// D14's words, D15 for what is awaited. Nothing for `none` and `planned`.
export function centralCalendarStatusBadge(item) {
  const expects = item.expects || [];
  switch (item.status) {
    case "done":
      return { label: "Done", tone: "done" };
    case "awaiting_entry":
      if (expects.includes("rpe") && item.rpe && item.rpe.submitted < item.rpe.asked) return { label: "Awaiting RPE", tone: "awaiting" };
      if (expects.includes("test_result") && item.results && item.results.completed < item.results.expected) return { label: "Awaiting result", tone: "awaiting" };
      if (item.attendance && item.attendance.needsState > 0) return { label: "Awaiting attendance", tone: "awaiting" };
      return { label: "Awaiting entry", tone: "awaiting" };
    case "missed":
      return { label: "Missed", tone: "missed" };
    case "not_opened":
      return { label: "Not opened", tone: "muted" };
    case "cancelled":
      return { label: "Cancelled", tone: "cancelled" };
    default:
      return null;
  }
}

// The one count a card shows (D14): RPE x/y, x/y present, Results x/y.
export function centralCalendarCountLabel(item) {
  if (item.kind === "activity") {
    if (item.attendance) return `${item.attendance.present}/${item.attendance.roster} present`;
    if (item.rpe) return `RPE ${item.rpe.submitted}/${item.rpe.asked}`;
    return "";
  }
  if (item.kind === "test") return item.results ? `Results ${item.results.completed}/${item.results.expected}` : "";
  return item.rpe ? `RPE ${item.rpe.submitted}/${item.rpe.asked}` : "";
}

// One sentence under the badge in the panel.
export function centralCalendarStatusSentence(item) {
  const expects = item.expects || [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  switch (item.status) {
    case "done":
      if (expects.includes("rpe") && item.rpe) return "Every athlete who was asked has entered their RPE.";
      if (expects.includes("test_result")) return "Every expected result is in.";
      if (item.attendance) return "Attendance is complete: every athlete on the roster has a state.";
      return "Everything expected is in.";
    case "awaiting_entry":
      if (expects.includes("rpe") && item.rpe && item.rpe.submitted < item.rpe.asked) {
        return `The day has passed and ${plural(item.rpe.asked - item.rpe.submitted, "RPE entry is", "RPE entries are")} still missing.`;
      }
      if (expects.includes("test_result") && item.results && item.results.completed < item.results.expected) {
        return `The day has passed and ${plural(item.results.expected - item.results.completed, "result is", "results are")} still missing.`;
      }
      if (item.attendance && item.attendance.needsState > 0) {
        return `Attendance is not complete: ${plural(item.attendance.needsState, "athlete still needs", "athletes still need")} a state.`;
      }
      return "The day has passed and an entry is still missing.";
    case "missed":
      return "The day has passed and the missing entries can no longer be made.";
    case "not_opened":
      return "Nobody was asked on this day: the check-in was never created.";
    case "cancelled":
      return "This item was cancelled.";
    case "planned":
      // An imported activity of today is recorded, not planned.
      return item.kind === "activity" ? "Nothing is due yet: the day has not passed." : "Planned: nothing is due yet.";
    case "none":
      return "Nothing was asked for this item, so there is nothing to wait for.";
    default:
      return "";
  }
}

function athleteStateLabel(athlete) {
  const rpe = athlete?.rpe;
  if (rpe === "submitted") return "RPE entered";
  if (rpe === "missing") return "RPE missing";
  if (rpe === "missed") return "RPE missed";
  if (rpe === "not_asked") return "Not asked";
  const result = athlete?.result;
  if (result === "completed") return "Result entered";
  if (result === "missing") return "Result missing";
  if (result === "missed") return "Result missed";
  if (result === "not_asked") return "Not asked";
  return "";
}

function renderBadgeHtml(item, className = "cc-badge") {
  const badge = centralCalendarStatusBadge(item);
  if (!badge) return "";
  return `<span class="${className} ${className}-${badge.tone}">${escapeHtml(badge.label)}</span>`;
}

function renderTeamDotsHtml(item, teams) {
  const ids = (item.teamIds || []).slice(1);
  if (!ids.length) return "";
  return `<span class="cc-card-teams" aria-label="${escapeAttr(`Also ${ids.map((id) => teamName(id, teams)).join(", ")}`)}">${ids.map((id) => `<span class="cc-team-dot"${teamColorStyle(id, teams)} title="${escapeAttr(teamName(id, teams))}"></span>`).join("")}</span>`;
}

function cardAriaLabel(item, teams) {
  const parts = [centralCalendarTitle(item), centralCalendarKindLabel(item)];
  const when = centralCalendarWhenLabel(item);
  if (when) parts.push(when);
  const badge = centralCalendarStatusBadge(item);
  if (badge) parts.push(badge.label);
  const count = centralCalendarCountLabel(item);
  if (count) parts.push(count);
  const names = (item.teamIds || []).map((id) => teamName(id, teams));
  if (names.length) parts.push(names.join(", "));
  return parts.join(", ");
}

export function renderCentralCalendarCardHtml(item, { teams, openKey = "" } = {}) {
  const when = centralCalendarWhenLabel(item);
  const count = centralCalendarCountLabel(item);
  const firstTeam = (item.teamIds || [])[0];
  const classes = ["cc-card", `cc-card-${escapeAttr(item.kind)}`];
  if (item.cancelled) classes.push("is-cancelled");
  if (openKey && openKey === item.key) classes.push("is-open");
  if (!firstTeam) classes.push("cc-card-no-team");
  return `<button type="button" class="${classes.join(" ")}" data-action="central-calendar-open-item" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}"${teamColorStyle(firstTeam, teams)} aria-label="${escapeAttr(cardAriaLabel(item, teams))}" aria-pressed="${openKey === item.key ? "true" : "false"}">
      <span class="cc-card-stripe" aria-hidden="true"></span>
      <span class="cc-card-body">
        <span class="cc-card-top">${when ? `<span class="cc-card-when">${escapeHtml(when)}</span>` : ""}<span class="cc-card-kind">${escapeHtml(centralCalendarKindLabel(item))}</span></span>
        <span class="cc-card-title">${escapeHtml(centralCalendarTitle(item))}</span>
        <span class="cc-card-meta">${renderBadgeHtml(item)}${count ? `<span class="cc-card-count">${escapeHtml(count)}</span>` : ""}${renderTeamDotsHtml(item, teams)}</span>
      </span>
    </button>`;
}

// The month cell's compact card: the team colour, the title and the status.
function renderMiniCardHtml(item, teams, openKey) {
  const badge = centralCalendarStatusBadge(item);
  const firstTeam = (item.teamIds || [])[0];
  return `<button type="button" class="cc-mini cc-mini-${escapeAttr(item.kind)}${item.cancelled ? " is-cancelled" : ""}${openKey === item.key ? " is-open" : ""}" data-action="central-calendar-open-item" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}"${teamColorStyle(firstTeam, teams)} aria-label="${escapeAttr(cardAriaLabel(item, teams))}" aria-pressed="${openKey === item.key ? "true" : "false"}">
        <span class="cc-mini-dot" aria-hidden="true"></span>
        <span class="cc-mini-title">${escapeHtml(centralCalendarTitle(item))}</span>
        ${badge ? `<span class="cc-mini-status cc-mini-status-${badge.tone}" aria-hidden="true"></span>` : ""}
      </button>`;
}

function renderChipHtml({ action, dataAttr, value, label, count, active, style = "", dot = false }) {
  return `<button type="button" class="cc-chip${active ? " is-active" : ""}" data-action="${action}" ${dataAttr}="${escapeAttr(value)}" aria-pressed="${active ? "true" : "false"}"${style}>${dot ? `<span class="cc-chip-dot" aria-hidden="true"></span>` : ""}<span class="cc-chip-label">${escapeHtml(label)}</span><span class="cc-chip-count">${escapeHtml(String(count))}</span></button>`;
}

function renderFiltersHtml(cal, counts, teams) {
  if (!cal.data) return "";
  const active = cal.filters.teamIds.length + cal.filters.kinds.length > 0;
  const groups = teams.length
    ? `<div class="cc-chip-row" role="group" aria-label="Groups">
        <span class="cc-chip-row-label">Groups</span>
        ${teams.map((team) => renderChipHtml({
          action: "central-calendar-toggle-team", dataAttr: "data-team-id", value: team.teamId, label: team.name || "Team",
          count: counts.teams.get(team.teamId) || 0, active: cal.filters.teamIds.includes(team.teamId), style: teamColorStyle(team.teamId, teams), dot: true,
        })).join("")}
      </div>`
    : "";
  const types = `<div class="cc-chip-row" role="group" aria-label="Types">
        <span class="cc-chip-row-label">Types</span>
        ${CENTRAL_CALENDAR_KINDS.map((kindKey) => renderChipHtml({
          action: "central-calendar-toggle-kind", dataAttr: "data-kind", value: kindKey, label: CENTRAL_CALENDAR_KIND_LABELS[kindKey],
          count: counts.kinds[kindKey] || 0, active: cal.filters.kinds.includes(kindKey),
        })).join("")}
        ${active ? `<button type="button" class="plain-button cc-clear-filters" data-action="central-calendar-clear-filters">Clear filters</button>` : ""}
      </div>`;
  return `<div class="cc-filters">${groups}${types}</div>`;
}

function renderToolbarHtml(cal, layout) {
  const unit = cal.view === "month" ? "month" : cal.view === "day" ? "day" : "week";
  const segment = (value, label, action, attr, current) => `<button type="button" class="cc-segment${current === value ? " is-active" : ""}" data-action="${action}" ${attr}="${value}" aria-pressed="${current === value ? "true" : "false"}">${label}</button>`;
  const modeSwitch = layout === "wide" && cal.view === "week"
    ? `<div class="cc-segmented cc-mode-switch" role="group" aria-label="Week layout">
          ${segment("list", "List", "central-calendar-mode", "data-mode", cal.weekMode || "list")}
          ${segment("grid", "Time grid", "central-calendar-mode", "data-mode", cal.weekMode || "list")}
        </div>`
    : "";
  return `<div class="cc-toolbar">
      <div class="cc-nav">
        <button type="button" class="plain-button cc-nav-arrow" data-action="central-calendar-prev" aria-label="Previous ${unit}">&lsaquo;</button>
        <h3 class="cc-period" aria-live="polite">${escapeHtml(centralCalendarPeriodLabel(cal.view, cal.anchor))}</h3>
        <button type="button" class="plain-button cc-nav-arrow" data-action="central-calendar-next" aria-label="Next ${unit}">&rsaquo;</button>
        <button type="button" class="plain-button cc-today" data-action="central-calendar-today">Today</button>
      </div>
      <div class="cc-switches">
        <div class="cc-segmented cc-view-switch" role="group" aria-label="View">
          ${segment("month", "Month", "central-calendar-view", "data-view", cal.view)}
          ${segment("week", "Week", "central-calendar-view", "data-view", cal.view)}
          ${segment("day", "Day", "central-calendar-view", "data-view", cal.view)}
        </div>
        ${modeSwitch}
      </div>
    </div>`;
}

function renderStateHtml(cal) {
  if (cal.error) {
    const extra = cal.errorCode === "forbidden" ? `<p class="cc-state-hint">Choose a club, team or private coaching in the workspace menu.</p>` : "";
    const detail = cal.errorDetail ? `<details class="cc-technical"><summary>Technical details</summary><p>${escapeHtml(cal.errorDetail)}</p></details>` : "";
    return `<div class="cc-state cc-state-error" role="alert">
        <p class="cc-state-text">${escapeHtml(cal.error)}</p>
        ${extra}${detail}
        <button type="button" class="plain-button cc-retry" data-action="central-calendar-retry">Try again</button>
      </div>`;
  }
  return `<p class="cc-state cc-state-loading" role="status">Loading calendar…</p>`;
}

function renderEmptyHtml(cal, scope) {
  const filtered = cal.filters.teamIds.length + cal.filters.kinds.length > 0;
  return `<div class="cc-empty">
      <p class="cc-empty-text">${filtered ? "Nothing matches these filters." : `Nothing planned or recorded ${scope}.`}</p>
      ${filtered ? `<button type="button" class="plain-button cc-clear-filters" data-action="central-calendar-clear-filters">Clear filters</button>` : ""}
    </div>`;
}

function renderDayCardsHtml(items, teams, openKey, { emptyText = "—" } = {}) {
  if (!items.length) return `<p class="cc-day-empty">${escapeHtml(emptyText)}</p>`;
  return items.map((item) => renderCentralCalendarCardHtml(item, { teams, openKey })).join("");
}

function dayHeadHtml(date, today, count, { button = true } = {}) {
  const label = `${centralCalendarLongDate(date)}${date === today ? ", today" : ""}${count ? `, ${count} item${count === 1 ? "" : "s"}` : ""}`;
  const inner = `<span class="cc-day-name">${escapeHtml(weekdayShort(date))}</span><span class="cc-day-number">${dayNumber(date)}</span>${count ? `<span class="cc-day-count">${count}</span>` : ""}`;
  if (!button) return `<div class="cc-day-head" aria-label="${escapeAttr(label)}">${inner}</div>`;
  return `<button type="button" class="cc-day-head" data-action="central-calendar-open-day" data-date="${escapeAttr(date)}" aria-label="${escapeAttr(`Open ${label}`)}">${inner}</button>`;
}

// Week as columns (medium and wide): the server's order inside each day.
function renderWeekColumnsHtml(days, byDate, cal, teams, today) {
  const columns = days.map((date) => {
    const items = centralCalendarVisibleItems(byDate.get(date), cal.filters);
    return `<section class="cc-day-column${date === today ? " is-today" : ""}" aria-label="${escapeAttr(centralCalendarLongDate(date))}">
        ${dayHeadHtml(date, today, items.length)}
        <div class="cc-day-cards">${renderDayCardsHtml(items, teams, cal.panel.key)}</div>
      </section>`;
  });
  return `<div class="cc-week" role="group" aria-label="Week of ${escapeAttr(shortDate(days[0], { year: true }))}">${columns.join("")}</div>`;
}

function hourOf(item) {
  const match = /^(\d{2}):(\d{2})/.exec(String(item.startTime || ""));
  return match ? Number(match[1]) : null;
}

// Week as a time grid (wide only): rows by hour, a "No time" band for the
// slot-only cards; a card sits at its start hour with one fixed height (the
// start is the only time K1 knows - no end, no duration).
function renderWeekGridHtml(days, byDate, cal, teams, today) {
  const visible = new Map(days.map((date) => [date, centralCalendarVisibleItems(byDate.get(date), cal.filters)]));
  let start = DAY_GRID_START_HOUR;
  let end = DAY_GRID_END_HOUR;
  for (const items of visible.values()) {
    for (const item of items) {
      const hour = hourOf(item);
      if (hour === null) continue;
      if (hour < start) start = hour;
      if (hour > end) end = hour;
    }
  }
  const hours = Array.from({ length: end - start + 1 }, (_, index) => start + index);
  const heads = days.map((date) => `<div class="cc-timegrid-head${date === today ? " is-today" : ""}">${dayHeadHtml(date, today, visible.get(date).length)}</div>`).join("");
  const untimed = days.map((date) => {
    const items = visible.get(date).filter((item) => hourOf(item) === null);
    return `<div class="cc-timegrid-cell cc-timegrid-untimed${date === today ? " is-today" : ""}">${items.map((item) => renderCentralCalendarCardHtml(item, { teams, openKey: cal.panel.key })).join("")}</div>`;
  }).join("");
  const rows = hours.map((hour) => {
    const label = `${String(hour).padStart(2, "0")}:00`;
    const cells = days.map((date) => {
      const items = visible.get(date).filter((item) => hourOf(item) === hour);
      return `<div class="cc-timegrid-cell${date === today ? " is-today" : ""}" data-hour="${hour}">${items.map((item) => renderCentralCalendarCardHtml(item, { teams, openKey: cal.panel.key })).join("")}</div>`;
    }).join("");
    return `<div class="cc-timegrid-row"><span class="cc-timegrid-hour">${label}</span>${cells}</div>`;
  }).join("");
  return `<div class="cc-timegrid" role="group" aria-label="Week of ${escapeAttr(shortDate(days[0], { year: true }))}, by hour">
      <div class="cc-timegrid-row cc-timegrid-heads"><span class="cc-timegrid-hour" aria-hidden="true"></span>${heads}</div>
      <div class="cc-timegrid-row cc-timegrid-untimed-row"><span class="cc-timegrid-hour">No set time</span>${untimed}</div>
      ${rows}
    </div>`;
}

// A phone's week: the seven-day strip over the selected day's list.
function renderStripHtml(days, byDate, cal, today) {
  const selected = days.includes(cal.selectedDate) ? cal.selectedDate : days[0];
  return `<div class="cc-strip" role="group" aria-label="Select a day">
      ${days.map((date) => {
        const count = centralCalendarVisibleItems(byDate.get(date), cal.filters).length;
        const isSelected = date === selected;
        return `<button type="button" class="cc-strip-day${isSelected ? " is-selected" : ""}${date === today ? " is-today" : ""}" data-action="central-calendar-select-day" data-date="${escapeAttr(date)}" aria-pressed="${isSelected ? "true" : "false"}"${date === today ? ' aria-current="date"' : ""} aria-label="${escapeAttr(`${centralCalendarLongDate(date)}${date === today ? ", today" : ""}${count ? `, ${count} item${count === 1 ? "" : "s"}` : ""}`)}">
          <span class="cc-strip-name">${escapeHtml(weekdayShort(date))}</span>
          <span class="cc-strip-number">${dayNumber(date)}</span>
          ${count ? `<span class="cc-strip-count" aria-hidden="true">${count}</span>` : ""}
        </button>`;
      }).join("")}
    </div>`;
}

function renderSelectedDayListHtml(date, byDate, cal, teams, today, { heading = true } = {}) {
  const items = centralCalendarVisibleItems(byDate.get(date), cal.filters);
  return `<section class="cc-day-list" aria-label="${escapeAttr(centralCalendarLongDate(date))}">
      ${heading ? `<h4 class="cc-day-title">${escapeHtml(centralCalendarLongDate(date))}${date === today ? ` <span class="cc-day-today-tag">Today</span>` : ""}</h4>` : ""}
      <div class="cc-day-cards">${renderDayCardsHtml(items, teams, cal.panel.key, { emptyText: cal.filters.teamIds.length + cal.filters.kinds.length ? "Nothing matches these filters on this day." : "Nothing on this day." })}</div>
    </section>`;
}

// The month grid: on a wide or medium screen each cell holds up to three
// compact cards and "+n more"; on a phone a cell is one button with the
// day's count and the selected day's list follows the grid.
function renderMonthHtml(days, byDate, cal, teams, today, layout) {
  const monthIso = cal.anchor.slice(0, 7);
  const weeks = [];
  for (let index = 0; index < days.length; index += 7) weeks.push(days.slice(index, index + 7));
  const selected = days.includes(cal.selectedDate) ? cal.selectedDate : cal.anchor;
  const phone = layout === "phone";
  const cell = (date) => {
    const items = centralCalendarVisibleItems(byDate.get(date), cal.filters);
    const classes = ["cc-month-cell"];
    if (date.slice(0, 7) !== monthIso) classes.push("is-outside");
    if (date === today) classes.push("is-today");
    if (phone && date === selected) classes.push("is-selected");
    const label = `${centralCalendarLongDate(date)}${date === today ? ", today" : ""}${items.length ? `, ${items.length} item${items.length === 1 ? "" : "s"}` : ""}`;
    if (phone) {
      return `<button type="button" class="${classes.join(" ")}" data-action="central-calendar-select-day" data-date="${escapeAttr(date)}" aria-pressed="${date === selected ? "true" : "false"}"${date === today ? ' aria-current="date"' : ""} aria-label="${escapeAttr(label)}">
          <span class="cc-month-number">${dayNumber(date)}</span>
          ${items.length ? `<span class="cc-month-count" aria-hidden="true">${items.length}</span>` : ""}
        </button>`;
    }
    const shown = items.slice(0, MONTH_CELL_CARDS);
    const more = items.length - shown.length;
    return `<div class="${classes.join(" ")}">
        <button type="button" class="cc-month-number" data-action="central-calendar-open-day" data-date="${escapeAttr(date)}"${date === today ? ' aria-current="date"' : ""} aria-label="${escapeAttr(`Open ${label}`)}">${dayNumber(date)}</button>
        <div class="cc-month-cards">
          ${shown.map((item) => renderMiniCardHtml(item, teams, cal.panel.key)).join("")}
          ${more > 0 ? `<button type="button" class="cc-month-more" data-action="central-calendar-open-day" data-date="${escapeAttr(date)}" aria-label="${escapeAttr(`${more} more on ${centralCalendarLongDate(date)}`)}">+${more} more</button>` : ""}
        </div>
      </div>`;
  };
  return `<div class="cc-month" role="group" aria-label="${escapeAttr(monthLabel(`${monthIso}-01`))}">
      <div class="cc-month-weekdays" aria-hidden="true">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name) => `<span>${name}</span>`).join("")}</div>
      ${weeks.map((week) => `<div class="cc-month-week">${week.map(cell).join("")}</div>`).join("")}
    </div>
    ${phone ? renderSelectedDayListHtml(selected, byDate, cal, teams, today) : ""}`;
}

function renderBodyHtml(cal, layout, today) {
  if (!cal.data) return renderStateHtml(cal);
  const teams = cal.data.teams || [];
  const byDate = centralCalendarItemsByDate(cal.data);
  const days = centralCalendarDisplayedDays(cal.view, cal.anchor);
  const anyVisible = days.some((date) => centralCalendarVisibleItems(byDate.get(date), cal.filters).length > 0);
  const scope = cal.view === "month" ? "this month" : cal.view === "day" ? "on this day" : "this week";
  if (cal.view === "month") return renderMonthHtml(days, byDate, cal, teams, today, layout) + (anyVisible ? "" : renderEmptyHtml(cal, scope));
  if (cal.view === "day") return renderSelectedDayListHtml(days[0], byDate, cal, teams, today, { heading: false });
  if (layout === "phone") {
    const selected = days.includes(cal.selectedDate) ? cal.selectedDate : days[0];
    return renderStripHtml(days, byDate, cal, today) + renderSelectedDayListHtml(selected, byDate, cal, teams, today);
  }
  const grid = layout === "wide" && cal.weekMode === "grid";
  return (grid ? renderWeekGridHtml(days, byDate, cal, teams, today) : renderWeekColumnsHtml(days, byDate, cal, teams, today)) + (anyVisible ? "" : renderEmptyHtml(cal, scope));
}

// `roster` maps an athlete UUID to the rail roster's athlete_id, the id the
// weekly plan's route reads (central-calendar-actions.js
// centralCalendarRosterIndex). An athlete outside it has no drill-in here.
function renderPanelAthletesHtml(item, cal, roster) {
  const panel = cal.panel;
  const count = Number(item.athleteCount) || 0;
  // An imported activity's athletes are its recorded participants; who
  // still needs an attendance state is the Roster tab's knowledge (K1a
  // gives no per-athlete roster state), so the head says what the list is.
  const recorded = item.kind === "activity" && Boolean(item.attendance);
  const head = `<h4 class="cc-panel-subtitle">${recorded ? "Recorded athletes" : "Athletes"}${count ? ` (${count})` : ""}</h4>`;
  if (panel.loading) return `${head}<p class="cc-panel-note" role="status">Loading athletes…</p>`;
  if (panel.error === "changed") return `${head}<p class="cc-panel-note">This item has changed since the calendar was loaded.</p><button type="button" class="plain-button cc-panel-button" data-action="central-calendar-retry">Refresh the calendar</button>`;
  if (panel.error) return `${head}<p class="cc-panel-note">Athlete names could not be loaded.</p><button type="button" class="plain-button cc-panel-button" data-action="central-calendar-retry-athletes">Try again</button>`;
  const athletes = [...(panel.athletes || [])].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  if (!athletes.length) return `${head}<p class="cc-panel-note">${count ? "No athlete names were returned." : "No athletes on this item."}</p>`;
  const teams = cal.data?.teams || [];
  const rosterNote = recorded && item.attendance.needsState > 0
    ? `<p class="cc-panel-note">Who still needs an attendance state is on the Roster tab — use Open in Training Load above.</p>`
    : "";
  return `${head}<ul class="cc-athletes" role="list">
      ${athletes.map((athlete) => {
        const stateLabel = athleteStateLabel(athlete);
        const names = (athlete.teamIds || []).map((id) => teamName(id, teams)).join(", ");
        const side = `<span class="cc-athlete-side">${names ? `<span class="cc-athlete-teams">${escapeHtml(names)}</span>` : ""}${stateLabel ? `<span class="cc-athlete-state cc-athlete-state-${escapeAttr(athlete.rpe || athlete.result || "none")}">${escapeHtml(stateLabel)}</span>` : ""}`;
        if (!roster?.has(String(athlete.athleteId))) {
          return `<li><div class="cc-athlete cc-athlete-static">
            <span class="cc-athlete-name">${escapeHtml(athlete.name || "Athlete")}</span>
            ${side}<span class="cc-athlete-note">Not in this workspace's roster</span></span>
          </div></li>`;
        }
        return `<li><button type="button" class="cc-athlete" data-action="central-calendar-open-athlete" data-athlete-id="${escapeAttr(athlete.athleteId)}" data-date="${escapeAttr(item.date)}" aria-label="${escapeAttr(`${athlete.name || "Athlete"}, open the weekly plan on ${centralCalendarLongDate(item.date)}`)}">
            <span class="cc-athlete-name">${escapeHtml(athlete.name || "Athlete")}</span>
            ${side}</span>
          </button></li>`;
      }).join("")}
    </ul>${rosterNote}`;
}

function panelItemOf(cal) {
  if (!cal.panel.open || !cal.data) return null;
  return centralCalendarItemsByDate(cal.data).get(cal.panel.date)?.find((entry) => entry.key === cal.panel.key) || null;
}

function renderPanelHtml(cal, layout, today, roster) {
  const panel = cal.panel;
  const item = panelItemOf(cal);
  if (!item) return "";
  const teams = cal.data.teams || [];
  const when = centralCalendarWhenLabel(item);
  const sentence = centralCalendarStatusSentence(item);
  const count = centralCalendarCountLabel(item);
  const activityIds = item.links?.activityIds || [];
  const thing = item.kind === "external" ? "event" : "training";
  const singularNote = item.kind === "planned" || item.kind === "external" ? `<p class="cc-panel-note">1 activity is recorded for this ${thing}.</p>` : "";
  const trainingLoad = activityIds.length === 1
    ? `<button type="button" class="plain-button cc-panel-button" data-action="central-calendar-open-training-load" data-activity-id="${escapeAttr(activityIds[0])}" data-date="${escapeAttr(item.date)}">Open in Training Load</button>${singularNote}`
    : activityIds.length > 1
      ? `<button type="button" class="plain-button cc-panel-button" data-action="central-calendar-open-training-load" data-date="${escapeAttr(item.date)}">Open the day in Training Load</button><p class="cc-panel-note">${activityIds.length} activities are recorded for this ${thing}.</p>`
      : "";
  const body = `<header class="cc-panel-head">
        <h3 class="cc-panel-title" id="ccPanelTitle">${escapeHtml(centralCalendarTitle(item))}</h3>
        <button type="button" class="plain-button icon-button cc-panel-close" data-action="central-calendar-close-panel" aria-label="Close">&times;</button>
      </header>
      <p class="cc-panel-kind">${escapeHtml(centralCalendarKindLabel(item))}</p>
      <p class="cc-panel-when">${escapeHtml(centralCalendarLongDate(item.date))}${item.date === today ? " (today)" : ""}${when ? ` · ${escapeHtml(when)}` : ""}</p>
      ${(item.teamIds || []).length ? `<p class="cc-panel-teams">${item.teamIds.map((id) => `<span class="cc-panel-team"${teamColorStyle(id, teams)}><span class="cc-team-dot" aria-hidden="true"></span>${escapeHtml(teamName(id, teams))}</span>`).join("")}</p>` : ""}
      ${renderBadgeHtml(item) || count || sentence ? `<div class="cc-panel-status">${renderBadgeHtml(item)}${count ? `<span class="cc-panel-count">${escapeHtml(count)}</span>` : ""}${sentence ? `<p class="cc-panel-sentence">${escapeHtml(sentence)}</p>` : ""}</div>` : ""}
      ${trainingLoad}
      <section class="cc-panel-athletes">${renderPanelAthletesHtml(item, cal, roster)}</section>`;
  if (layout === "wide") return `<aside class="cc-panel" aria-labelledby="ccPanelTitle">${body}</aside>`;
  return `<button type="button" class="cc-sheet-backdrop" data-action="central-calendar-close-panel" aria-label="Close" tabindex="-1"></button>
    <aside class="cc-panel cc-sheet" role="dialog" aria-modal="true" aria-labelledby="ccPanelTitle">${body}</aside>`;
}

export function renderCentralCalendarHtml(cal, { today, layout = "wide", roster = new Map() } = {}) {
  const teams = cal.data?.teams || [];
  const byDate = centralCalendarItemsByDate(cal.data);
  const days = cal.anchor ? centralCalendarDisplayedDays(cal.view, cal.anchor) : [];
  const counts = centralCalendarChipCounts(byDate, days);
  // The panel column exists only while the open item is really in the answer.
  const panelOpen = Boolean(panelItemOf(cal));
  return `<section class="central-calendar cc-layout-${escapeAttr(layout)} cc-view-${escapeAttr(cal.view)}${panelOpen ? " cc-panel-open" : ""}" aria-label="Calendar">
      ${cal.anchor ? renderToolbarHtml(cal, layout) : ""}
      ${renderFiltersHtml(cal, counts, teams)}
      ${cal.refreshError ? `<p class="cc-refresh-note" role="status">${escapeHtml(cal.refreshError)} <button type="button" class="plain-button cc-inline-button" data-action="central-calendar-retry">Try again</button></p>` : ""}
      ${cal.notice ? `<p class="cc-refresh-note" role="status">${escapeHtml(cal.notice)}</p>` : ""}
      <div class="cc-body">
        <div class="cc-main">${cal.anchor ? renderBodyHtml(cal, layout, today) : renderStateHtml(cal)}</div>
        ${renderPanelHtml(cal, layout, today, roster)}
      </div>
    </section>`;
}

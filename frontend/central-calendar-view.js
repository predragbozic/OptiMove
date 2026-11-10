import { calendarColorIndex, calendarTeamColorIndexes } from "./calendar-colors.js";
import { CENTRAL_CALENDAR_EVENT_KINDS, CENTRAL_CALENDAR_KINDS } from "./central-calendar-data.js";
import {
  centralCalendarCatalogOf,
  renderCentralCalendarEventDetailsHtml,
  renderCentralCalendarEventPlaceHtml,
} from "./central-calendar-event-details.js";
import { CENTRAL_CALENDAR_EXPECT_SHORT, renderCentralCalendarEventFormHtml } from "./central-calendar-event-form.js";
import { isLibraryKey, renderIconSvg } from "./icon-render.js";
import { addDaysIso, escapeAttr, escapeHtml, monthLabel, monthWeeksIso, weekMondayIso } from "./utils.js";

// Central calendar (K1b, K2a-2) - the screen over GET /api/calendar
// (docs/ai/central-calendar-k1b-plan.md, docs/ai/central-calendar-k2a-2-plan.md).
// Pure template strings: the toolbar, the collapsible Filters panel (Groups,
// Types, Event types), a month, a week (the server's slot order as a list,
// or a time grid on a wide screen) or a day, the card, the item panel and,
// in its place, the event form (central-calendar-event-form.js). The server
// groups (D16) and orders (D13); the chips only hide whole cards. One
// departure from that order: the selected day's list (a phone's week and
// month, the Day view) moves the cards with neither a time nor a slot after
// the others, under "No time" - the server puts them first, and the wide
// week's time grid keeps them in a band above the hours. Within each part
// the server's order stays. The owner's choice (plan section 8).
// `layout` is "phone" (<= 760 px), "medium" (761-1023 px) or "wide"
// (>= 1024 px), decided by the actions module from window.matchMedia.

// The Types chips (choice 9.10 of the K2a plan: `external` is "RPE requests"
// now that events have their own chip; the Builder's sessions are "Planned
// training" beside an event of type Training).
// The Tests module's cards are "Scheduled tests", beside an event of type Test.
export const CENTRAL_CALENDAR_KIND_LABELS = Object.freeze({ event: "Events", planned: "Planned training", activity: "Activities", external: "RPE requests", test: "Scheduled tests" });
// The Event types chips: an event's kind (D2), in the seeded types' words.
export const CENTRAL_CALENDAR_EVENT_KIND_LABELS = Object.freeze({ training: "Training", match: "Match", test: "Test", travel: "Travel", meeting: "Meeting", day_off: "Day off", camp: "Camp" });
// One icon of icon-library.js per type: an event by its kind (the base-kind
// defaults; K2b makes a type's icon editable), every other card by its kind.
export const CENTRAL_CALENDAR_EVENT_KIND_ICONS = Object.freeze({ training: "run", match: "trophy", test: "clipboard", travel: "route", meeting: "team", day_off: "bed", camp: "mountain" });
export const CENTRAL_CALENDAR_KIND_ICONS = Object.freeze({ event: "calendar-event", planned: "barbell", activity: "activity", external: "gauge", test: "stopwatch" });
// A team's colour (D11, K2b-1c): the one its club chose under Settings ->
// Calendar (`teams[].colorKey`), else the next automatic colour by the
// team's position in the answer's teams[] (calendar-colors.js). Their values
// are the --cc-team-N tokens in styles.css; a card or a chip only names the
// palette index. With no choice made, team N wears automatic colour N mod 8.
const BTA_WORDS = Object.freeze({ B: "Before", T: "Training", A: "After" });
const EVENT_TYPE_LABELS = Object.freeze({
  match: "Match", friendly: "Friendly match", tournament: "Tournament", training: "Training", travel: "Travel",
  meeting: "Meeting", camp: "Camp", recovery: "Recovery", rest: "Rest", other: "Event",
});
// The time grid's default hour rows, 06:00 to 21:00: the last row takes the
// 21:xx starts, so the grid covers 06:00-22:00; an earlier or later start
// widens it (plan section 4).
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
// its type is not chosen. A type is a kind (Events, Planned training, …) or,
// for an event, its kind (Match, Travel, …): an event passes when Events is
// chosen or its own kind is (K2a-2). Nothing inside a card changes.
export function centralCalendarVisibleItems(items, filters) {
  const teamIds = filters?.teamIds || [];
  const kinds = filters?.kinds || [];
  const eventKinds = filters?.eventKinds || [];
  return (items || []).filter((item) => {
    if ((kinds.length || eventKinds.length) && !kinds.includes(item.kind) && !(item.kind === "event" && eventKinds.includes(item.eventKind))) return false;
    if (teamIds.length && !(item.teamIds || []).some((id) => teamIds.includes(id))) return false;
    return true;
  });
}

export function centralCalendarFiltersActive(filters) {
  return (filters?.teamIds?.length || 0) + (filters?.kinds?.length || 0) + (filters?.eventKinds?.length || 0) > 0;
}

// The chips' counts over the displayed days of the unfiltered answer (a
// month's grid, the week, or the one day of the Day view): what a chip
// would show or hide on this screen, whatever else is chosen. `total` is
// what All groups and All types count.
export function centralCalendarChipCounts(byDate, days) {
  const teams = new Map();
  const kinds = Object.fromEntries(CENTRAL_CALENDAR_KINDS.map((kind) => [kind, 0]));
  const eventKinds = new Map();
  let total = 0;
  for (const date of days) {
    for (const item of byDate.get(date) || []) {
      total += 1;
      if (item.kind in kinds) kinds[item.kind] += 1;
      if (item.kind === "event" && item.eventKind) eventKinds.set(item.eventKind, (eventKinds.get(item.eventKind) || 0) + 1);
      for (const teamId of item.teamIds || []) teams.set(teamId, (teams.get(teamId) || 0) + 1);
    }
  }
  return { teams, kinds, eventKinds, total };
}

// The workspace's event types by id (the catalog the calendar holds, set on
// every render): a manager's event card carries its `eventTypeId`, and shows
// that type's icon and colour (K2b-1d, Q1 (a)). A reader's card names no type
// and keeps its kind's icon (K2b-1d2 adds the icon to every card).
let cardTypes = new Map();

export function centralCalendarCardType(item, types = cardTypes) {
  if (item?.kind !== "event" || item.canManage !== true || !item.eventTypeId) return null;
  return types.get(String(item.eventTypeId)) || null;
}

export function centralCalendarItemIconKey(item, types = cardTypes) {
  if (item?.kind === "event") {
    const type = centralCalendarCardType(item, types);
    if (type && isLibraryKey(type.iconKey)) return type.iconKey;
    return CENTRAL_CALENDAR_EVENT_KIND_ICONS[item.eventKind] || CENTRAL_CALENDAR_KIND_ICONS.event;
  }
  return CENTRAL_CALENDAR_KIND_ICONS[item?.kind] || CENTRAL_CALENDAR_KIND_ICONS.event;
}

// The type's colour on its icon (the stripe stays the team's colour).
function typeColorStyle(item) {
  const index = calendarColorIndex(centralCalendarCardType(item)?.colorKey);
  return index < 0 ? null : `--cc-type-color: var(--cc-team-${index})`;
}

function itemIconHtml(item, className = "cc-card-icon", size = 16) {
  const color = typeColorStyle(item);
  const svg = renderIconSvg(centralCalendarItemIconKey(item), { size, className: color ? `${className} has-type-color` : className });
  return color ? `<span class="cc-type-tint" style="${color}">${svg}</span>` : svg;
}

function eventKindWord(item) {
  return item.eventTypeLabel || CENTRAL_CALENDAR_EVENT_KIND_LABELS[item.eventKind] || "Event";
}

// A referenced schedule that reaches athletes the event does not list stays
// its own card beside the event (K2a-1a round 4, `scheduleFold`: "separate");
// the event card says so instead of showing its numbers.
export function centralCalendarScheduleSeparate(item) {
  return item?.kind === "event" && (item.scheduleFold?.external === "separate" || item.scheduleFold?.test === "separate");
}
const SEPARATE_WORDS = "Linked schedule shown separately";

export function centralCalendarTeamIndex(teamId, teams) {
  return calendarTeamColorIndexes(teams).get(teamId) ?? -1;
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
  if (item.kind === "event") return eventKindWord(item);
  if (item.kind === "planned") return "Training session";
  if (item.kind === "activity") return "Activity";
  if (item.kind === "external") return eventTypeLabel(item.eventType) || "RPE request";
  if (item.kind === "test") return "Test";
  return "Item";
}

function athleteCountLabel(count) {
  return `${count} athlete${count === 1 ? "" : "s"}`;
}

// The small word under the title: what kind of thing the card is.
export function centralCalendarKindLabel(item) {
  const count = Number(item.athleteCount) || 0;
  if (item.kind === "event") {
    // The type's word only when the title is not that word already.
    const word = eventKindWord(item);
    return `Event${item.title && item.title !== word ? ` · ${word}` : ""}${count ? ` · ${athleteCountLabel(count)}` : ""}`;
  }
  if (item.kind === "planned") return `Planned training · ${athleteCountLabel(count)}`;
  if (item.kind === "activity") {
    const word = item.origin === "api_import" || item.origin === "source_import" ? "Imported activity" : "Activity";
    return count ? `${word} · ${athleteCountLabel(count)}` : word;
  }
  if (item.kind === "external") {
    const type = eventTypeLabel(item.eventType);
    return `RPE request${type && type !== "Event" && type !== item.title ? ` · ${type}` : ""}${count ? ` · ${athleteCountLabel(count)}` : ""}`;
  }
  if (item.kind === "test") return `Scheduled test${count ? ` · ${athleteCountLabel(count)}` : ""}`;
  return "";
}

// "Day 2 of 3" on each day's card of a multi-day event (D22); "" otherwise.
export function centralCalendarSpanLabel(item) {
  const span = item?.span;
  if (!span?.from || !span?.to || span.to <= span.from || !item.date) return "";
  const day = (iso) => Date.parse(`${iso}T00:00:00Z`);
  const total = Math.round((day(span.to) - day(span.from)) / 86_400_000) + 1;
  const index = Math.round((day(item.date) - day(span.from)) / 86_400_000) + 1;
  return index >= 1 && index <= total ? `Day ${index} of ${total}` : "";
}

// A start time (with an event's end time) when the item has one, else the
// slot words (AM/PM, then Before/Training/After); `slot.order` is never shown.
export function centralCalendarWhenLabel(item) {
  if (item.startTime) return `${String(item.startTime).slice(0, 5)}${item.endTime ? `–${String(item.endTime).slice(0, 5)}` : ""}`;
  const slot = item.slot;
  if (!slot) return "";
  const parts = [];
  if (slot.amPm) parts.push(slot.amPm);
  if (slot.bta && BTA_WORDS[slot.bta]) parts.push(BTA_WORDS[slot.bta]);
  return parts.join(" · ");
}

// D14's words, D15 for what is awaited; the owner's status pill (K2a-2):
// "Planned" shows too, and an event that expects nothing reads Planned until
// its day (`today`; the server says `none` for it on every day). Nothing for
// `none` otherwise.
export function centralCalendarStatusBadge(item, today = "") {
  const expects = item.expects || [];
  switch (item.status) {
    case "done":
      return { label: "Done", tone: "done" };
    case "awaiting_entry":
      if (expects.includes("rpe") && item.rpe && item.rpe.submitted < item.rpe.asked) return { label: "Awaiting RPE", tone: "awaiting" };
      if (expects.includes("test_result") && item.results && item.results.completed < item.results.expected) return { label: "Awaiting result", tone: "awaiting" };
      if (item.attendance && item.attendance.needsState > 0) return { label: "Awaiting attendance", tone: "awaiting" };
      if (detailsMissing(item) > 0) return { label: "Awaiting details", tone: "awaiting" };
      // An event's unmet GPS / device data (K2a plan 3.2): the import is the coach's next step.
      if (item.kind === "event" && expects.includes("device_data")) return { label: "Awaiting device data", tone: "awaiting" };
      return { label: "Awaiting entry", tone: "awaiting" };
    case "planned":
      // An imported activity of today is recorded, not planned (no pill, as K1b).
      return item.kind === "activity" ? null : { label: "Planned", tone: "planned" };
    case "none":
      return item.kind === "event" && !item.cancelled && today && item.date >= today ? { label: "Planned", tone: "planned" } : null;
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

// A manager's event card counts its chosen details (K2b-1b): the required
// ones still empty, and "Details 2/3" whenever it has any (Q4).
function detailsMissing(item) {
  const details = item?.kind === "event" ? item.details : null;
  return details ? Math.max(0, (Number(details.required) || 0) - (Number(details.filledRequired) || 0)) : 0;
}

function detailsCountLabel(item) {
  const details = item?.kind === "event" ? item.details : null;
  return details && details.selected > 0 ? `Details ${details.filled}/${details.selected}` : "";
}

// The one count a card shows (D14): RPE x/y, x/y present, Results x/y; an
// event with chosen details also "Details x/y" (K2b-1d).
export function centralCalendarCountLabel(item) {
  if (item.kind === "activity") {
    if (item.attendance) return `${item.attendance.present}/${item.attendance.roster} present`;
    if (item.rpe) return `RPE ${item.rpe.submitted}/${item.rpe.asked}`;
    return "";
  }
  if (item.kind === "test") return item.results ? `Results ${item.results.completed}/${item.results.expected}` : "";
  return [item.rpe ? `RPE ${item.rpe.submitted}/${item.rpe.asked}` : "", detailsCountLabel(item)].filter(Boolean).join(" · ");
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
      if (detailsMissing(item) > 0) {
        return `The event has ended and ${plural(detailsMissing(item), "required detail is", "required details are")} still empty.`;
      }
      if (item.kind === "event" && expects.includes("device_data")) return "The day has passed and no imported activity is linked to this event yet.";
      return "The day has passed and an entry is still missing.";
    case "missed":
      return "The day has passed and the missing entries can no longer be made.";
    case "not_opened":
      return "Nobody was asked on this day: the check-in was never created.";
    case "cancelled":
      return item.kind === "event" ? "This event was cancelled." : "This item was cancelled.";
    case "planned":
      // An imported activity of today is recorded, not planned.
      return item.kind === "activity" ? "Nothing is due yet: the day has not passed." : "Planned: nothing is due yet.";
    case "none":
      if (item.kind === "event") {
        if (expects.length) return "Nothing is being collected: see the note below.";
        if (item.details?.required > 0) return "Its required details are due after the event.";
        if (item.details?.selected > 0) return "Nothing is required after this event; its details are optional.";
        return "Nothing is expected after this event.";
      }
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

function renderBadgeHtml(item, today, className = "cc-badge") {
  const badge = centralCalendarStatusBadge(item, today);
  if (!badge) return "";
  return `<span class="${className} ${className}-${badge.tone}">${escapeHtml(badge.label)}</span>`;
}

function renderTeamDotsHtml(item, teams) {
  const ids = (item.teamIds || []).slice(1);
  if (!ids.length) return "";
  return `<span class="cc-card-teams" aria-label="${escapeAttr(`Also ${ids.map((id) => teamName(id, teams)).join(", ")}`)}">${ids.map((id) => `<span class="cc-team-dot"${teamColorStyle(id, teams)} title="${escapeAttr(teamName(id, teams))}"></span>`).join("")}</span>`;
}

// The owner's team pill (K2a-2): the first team's colour and name.
function renderTeamPillHtml(teamId, teams) {
  if (!teamId) return "";
  return `<span class="cc-team-pill"${teamColorStyle(teamId, teams)}><span class="cc-team-dot" aria-hidden="true"></span><span class="cc-team-pill-name">${escapeHtml(teamName(teamId, teams))}</span></span>`;
}

function cardAriaLabel(item, teams, today) {
  const parts = [centralCalendarTitle(item), centralCalendarKindLabel(item)];
  const when = centralCalendarWhenLabel(item);
  if (when) parts.push(when);
  const span = centralCalendarSpanLabel(item);
  if (span) parts.push(span);
  if (item.kind === "event" && eventPlaceText(item)) parts.push(eventPlaceText(item));
  if (centralCalendarScheduleSeparate(item)) parts.push(SEPARATE_WORDS);
  const badge = centralCalendarStatusBadge(item, today);
  if (badge) parts.push(badge.label);
  const count = centralCalendarCountLabel(item);
  if (count) parts.push(count);
  const names = (item.teamIds || []).map((id) => teamName(id, teams));
  if (names.length) parts.push(names.join(", "));
  return parts.join(", ");
}

// The place a card names: a library place's name, a one-off text, else the
// legacy `location` (K2b-1b's `place`; the address is the panel's).
function eventPlaceText(item) {
  const place = item.place;
  if (place?.source === "library" && place.name) return place.name;
  if (place?.source === "one_off" && place.text) return place.text;
  return item.location || "";
}

export function renderCentralCalendarCardHtml(item, { teams, openKey = "", today = "" } = {}) {
  const when = centralCalendarWhenLabel(item);
  const count = centralCalendarCountLabel(item);
  const span = centralCalendarSpanLabel(item);
  const firstTeam = (item.teamIds || [])[0];
  const place = item.kind === "event" ? eventPlaceText(item) : "";
  const classes = ["cc-card", `cc-card-${escapeAttr(item.kind)}`];
  if (item.cancelled) classes.push("is-cancelled");
  if (openKey && openKey === item.key) classes.push("is-open");
  if (!firstTeam) classes.push("cc-card-no-team");
  return `<button type="button" class="${classes.join(" ")}" data-action="central-calendar-open-item" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}"${teamColorStyle(firstTeam, teams)} aria-label="${escapeAttr(cardAriaLabel(item, teams, today))}" aria-pressed="${openKey === item.key ? "true" : "false"}">
      <span class="cc-card-stripe" aria-hidden="true"></span>
      <span class="cc-card-body">
        <span class="cc-card-top">${itemIconHtml(item)}${when ? `<span class="cc-card-when">${escapeHtml(when)}</span>` : ""}<span class="cc-card-kind" title="${escapeAttr(centralCalendarKindLabel(item))}">${escapeHtml(centralCalendarKindLabel(item))}</span>${span ? `<span class="cc-card-span">${escapeHtml(span)}</span>` : ""}</span>
        <span class="cc-card-title">${escapeHtml(centralCalendarTitle(item))}</span>
        ${place ? `<span class="cc-card-place">${escapeHtml(place)}</span>` : ""}
        ${centralCalendarScheduleSeparate(item) ? `<span class="cc-card-note">${SEPARATE_WORDS}</span>` : ""}
        <span class="cc-card-meta">${renderTeamPillHtml(firstTeam, teams)}${renderBadgeHtml(item, today)}${count ? `<span class="cc-card-count">${escapeHtml(count)}</span>` : ""}${renderTeamDotsHtml(item, teams)}</span>
      </span>
    </button>`;
}

// The month cell's compact card: the team colour, the type's icon, the
// title and the status.
function renderMiniCardHtml(item, teams, openKey, today) {
  const badge = centralCalendarStatusBadge(item, today);
  const firstTeam = (item.teamIds || [])[0];
  return `<button type="button" class="cc-mini cc-mini-${escapeAttr(item.kind)}${item.cancelled ? " is-cancelled" : ""}${openKey === item.key ? " is-open" : ""}" data-action="central-calendar-open-item" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}"${teamColorStyle(firstTeam, teams)} aria-label="${escapeAttr(cardAriaLabel(item, teams, today))}" aria-pressed="${openKey === item.key ? "true" : "false"}">
        <span class="cc-mini-dot" aria-hidden="true"></span>
        <span class="cc-mini-title">${itemIconHtml(item, "cc-mini-icon", 12)}${escapeHtml(centralCalendarTitle(item))}</span>
        ${badge ? `<span class="cc-mini-status cc-mini-status-${badge.tone}" aria-hidden="true"></span>` : ""}
      </button>`;
}

function renderChipHtml({ action, dataAttr = "", value = "", label, count, active, style = "", dot = false, icon = "" }) {
  const data = dataAttr ? ` ${dataAttr}="${escapeAttr(value)}"` : "";
  return `<button type="button" class="cc-chip${active ? " is-active" : ""}" data-action="${action}"${data} aria-pressed="${active ? "true" : "false"}" aria-label="${escapeAttr(`${label}, ${count}`)}"${style}>${dot ?`<span class="cc-chip-dot" aria-hidden="true"></span>` : ""}${icon ? renderIconSvg(icon, { size: 14, className: "cc-chip-icon" }) : ""}<span class="cc-chip-label">${escapeHtml(label)}</span><span class="cc-chip-count">${escapeHtml(String(count))}</span></button>`;
}

// The collapsed panel's one line: "All groups · all types", or the chosen
// names (two at most, then a count).
export function centralCalendarFiltersSummary(filters, teams) {
  const names = (list, label, plural) => (list.length <= 2 ? list.join(", ") : `${list.length} ${plural}`) || label;
  const groups = names((filters.teamIds || []).map((id) => teamName(id, teams)), "All groups", "groups");
  const types = [
    ...(filters.kinds || []).map((kind) => CENTRAL_CALENDAR_KIND_LABELS[kind] || kind),
    ...(filters.eventKinds || []).map((kind) => CENTRAL_CALENDAR_EVENT_KIND_LABELS[kind] || kind),
  ];
  return `${groups} · ${names(types, "all types", "types")}`;
}

// The Filters panel (the owner's design): one button that folds the chips
// away with a summary line; the chips stay in the markup (hidden) so their
// sideways scroll and the focus survive a repaint. Groups: All groups and a
// chip per team with its colour dot; Types: All types and the five kinds;
// Event types: a chip per event kind on the displayed days (or chosen).
function renderFiltersHtml(cal, counts, teams) {
  if (!cal.data) return "";
  const filters = cal.filters;
  const active = centralCalendarFiltersActive(filters);
  const open = Boolean(cal.filtersOpen);
  const groups = teams.length
    ? `<div class="cc-chip-row" role="group" aria-label="Groups">
        <span class="cc-chip-row-label">Groups</span>
        ${renderChipHtml({ action: "central-calendar-all-groups", label: "All groups", count: counts.total, active: !filters.teamIds.length })}
        ${teams.map((team) => renderChipHtml({
          action: "central-calendar-toggle-team", dataAttr: "data-team-id", value: team.teamId, label: team.name || "Team",
          count: counts.teams.get(team.teamId) || 0, active: filters.teamIds.includes(team.teamId), style: teamColorStyle(team.teamId, teams), dot: true,
        })).join("")}
      </div>`
    : "";
  const types = `<div class="cc-chip-row" role="group" aria-label="Types">
        <span class="cc-chip-row-label">Types</span>
        ${renderChipHtml({ action: "central-calendar-all-types", label: "All types", count: counts.total, active: !filters.kinds.length && !filters.eventKinds.length })}
        ${CENTRAL_CALENDAR_KINDS.map((kindKey) => renderChipHtml({
          action: "central-calendar-toggle-kind", dataAttr: "data-kind", value: kindKey, label: CENTRAL_CALENDAR_KIND_LABELS[kindKey],
          count: counts.kinds[kindKey] || 0, active: filters.kinds.includes(kindKey), icon: CENTRAL_CALENDAR_KIND_ICONS[kindKey],
        })).join("")}
      </div>`;
  const eventKinds = CENTRAL_CALENDAR_EVENT_KINDS.filter((kind) => counts.eventKinds.get(kind) || filters.eventKinds.includes(kind));
  const eventTypes = eventKinds.length
    ? `<div class="cc-chip-row" role="group" aria-label="Event types">
        <span class="cc-chip-row-label">Event types</span>
        ${eventKinds.map((kind) => renderChipHtml({
          action: "central-calendar-toggle-event-kind", dataAttr: "data-event-kind", value: kind, label: CENTRAL_CALENDAR_EVENT_KIND_LABELS[kind],
          count: counts.eventKinds.get(kind) || 0, active: filters.eventKinds.includes(kind), icon: CENTRAL_CALENDAR_EVENT_KIND_ICONS[kind],
        })).join("")}
      </div>`
    : "";
  return `<div class="cc-filters${open ? " is-open" : ""}">
      <div class="cc-filters-bar">
        <button type="button" class="cc-filters-toggle" data-action="central-calendar-toggle-filters" aria-expanded="${open ? "true" : "false"}" aria-controls="ccFiltersBody">
          ${renderIconSvg("adjust", { size: 18, className: "cc-filters-icon" })}<span class="cc-filters-word">Filters</span><span class="cc-filters-summary">${escapeHtml(centralCalendarFiltersSummary(filters, teams))}</span><span class="cc-filters-chevron" aria-hidden="true"></span>
        </button>
        ${active ? `<button type="button" class="plain-button cc-clear-filters" data-action="central-calendar-clear-filters">Clear filters</button>` : ""}
      </div>
      <div class="cc-filters-body" id="ccFiltersBody"${open ? "" : " hidden"}>${groups}${types}${eventTypes}</div>
    </div>`;
}

// The view and week-layout switches are icon buttons (owner, 2026-10-30) in
// the app's own icon-tab pattern - TRAINING_LOAD_TAB_ICONS
// (training-load-view.js): 24 x 24
// strokes in the text colour, local path data, the name in aria-label and
// title. Time grid is the icon library's clock and Day its calendar-event
// square (icon-library.js); Month, Week and List are drawn on the same
// calendar frame so the three views read as one family.
const CALENDAR_FRAME = `<rect x="4" y="5" width="16" height="16" rx="2"></rect><path d="M16 3v4"></path><path d="M8 3v4"></path><path d="M4 11h16"></path>`;
export const CENTRAL_CALENDAR_SWITCH_ICONS = Object.freeze({
  month: `${CALENDAR_FRAME}<path d="M4 16h16"></path><path d="M9.33 11v10"></path><path d="M14.67 11v10"></path>`,
  week: `${CALENDAR_FRAME}<rect x="5" y="14" width="14" height="3.5" rx="1"></rect>`,
  day: `${CALENDAR_FRAME}<rect x="8" y="14" width="4" height="4" rx="1"></rect>`,
  list: `<path d="M9 6h11"></path><path d="M9 12h11"></path><path d="M9 18h11"></path><path d="M5 6h.01"></path><path d="M5 12h.01"></path><path d="M5 18h.01"></path>`,
  grid: `<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path>`,
});

function renderSwitchIcon(value) {
  return `<svg class="cc-switch-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${CENTRAL_CALENDAR_SWITCH_ICONS[value] || ""}</svg>`;
}

function renderToolbarHtml(cal, layout, { canCreate = false } = {}) {
  const unit = cal.view === "month" ? "month" : cal.view === "day" ? "day" : "week";
  // K2a-2: New event only where this workspace may create one (a club, a
  // team, a private coach); the server decides again on the write.
  const newEvent = canCreate
    ? `<button type="button" class="plain-button cc-primary cc-new-event" data-action="central-calendar-new-event"${cal.form ? " disabled" : ""}>${renderIconSvg("calendar-event", { size: 18 })}<span>New event</span></button>`
    : "";
  const segment = (value, label, action, attr, current) => `<button type="button" class="cc-segment${current === value ? " is-active" : ""}" data-action="${action}" ${attr}="${value}" aria-pressed="${current === value ? "true" : "false"}" aria-label="${label}" title="${label}">${renderSwitchIcon(value)}</button>`;
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
        ${newEvent}
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
  const filtered = centralCalendarFiltersActive(cal.filters);
  return `<div class="cc-empty">
      <p class="cc-empty-text">${filtered ? "Nothing matches these filters." : `Nothing planned or recorded ${scope}.`}</p>
      ${filtered ? `<button type="button" class="plain-button cc-clear-filters" data-action="central-calendar-clear-filters">Clear filters</button>` : ""}
    </div>`;
}

function renderDayCardsHtml(items, teams, openKey, today, { emptyText = "—", emptyAction = "" } = {}) {
  if (!items.length && emptyAction) return `<div class="om-empty cc-day-empty" role="status"><p class="om-empty__text">${escapeHtml(emptyText)}</p><div class="om-empty__actions">${emptyAction}</div></div>`;
  if (!items.length) return `<p class="cc-day-empty">${escapeHtml(emptyText)}</p>`;
  return items.map((item) => renderCentralCalendarCardHtml(item, { teams, openKey, today })).join("");
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
        <div class="cc-day-cards">${renderDayCardsHtml(items, teams, cal.panel.key, today)}</div>
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
    return `<div class="cc-timegrid-cell cc-timegrid-untimed${date === today ? " is-today" : ""}">${items.map((item) => renderCentralCalendarCardHtml(item, { teams, openKey: cal.panel.key, today })).join("")}</div>`;
  }).join("");
  const rows = hours.map((hour) => {
    const label = `${String(hour).padStart(2, "0")}:00`;
    const cells = days.map((date) => {
      const items = visible.get(date).filter((item) => hourOf(item) === hour);
      return `<div class="cc-timegrid-cell${date === today ? " is-today" : ""}" data-hour="${hour}">${items.map((item) => renderCentralCalendarCardHtml(item, { teams, openKey: cal.panel.key, today })).join("")}</div>`;
    }).join("");
    return `<div class="cc-timegrid-row"><span class="cc-timegrid-hour">${label}</span>${cells}</div>`;
  }).join("");
  return `<div class="cc-timegrid" role="group" aria-label="Week of ${escapeAttr(shortDate(days[0], { year: true }))}, by hour">
      <div class="cc-timegrid-row cc-timegrid-heads"><span class="cc-timegrid-hour" aria-hidden="true"></span>${heads}</div>
      <div class="cc-timegrid-row cc-timegrid-untimed-row"><span class="cc-timegrid-hour">No set time</span>${untimed}</div>
      ${rows}
    </div>`;
}

// The teams with a visible card on a day, in the answer's teams[] order (the
// strip's dots); `limit` keeps a phone's narrow day readable.
export function centralCalendarDayTeamIds(items, teams, limit = Infinity) {
  const present = new Set();
  for (const item of items || []) for (const id of item.teamIds || []) present.add(id);
  return (teams || []).map((team) => team.teamId).filter((id) => present.has(id)).slice(0, limit);
}

// A phone's week: the seven-day strip over the selected day's list; under
// each day one team-colour dot per team with a visible card (K2a-2).
function renderStripHtml(days, byDate, cal, today, teams) {
  const selected = days.includes(cal.selectedDate) ? cal.selectedDate : days[0];
  return `<div class="cc-strip" role="group" aria-label="Select a day">
      ${days.map((date) => {
        const items = centralCalendarVisibleItems(byDate.get(date), cal.filters);
        const count = items.length;
        const isSelected = date === selected;
        const allIds = centralCalendarDayTeamIds(items, teams);
        // Four marks at most in a phone's narrow day: four dots, or three and "+N".
        const dotIds = allIds.slice(0, allIds.length > 4 ? 3 : 4);
        const names = allIds.map((id) => teamName(id, teams)).join(", ");
        return `<button type="button" class="cc-strip-day${isSelected ? " is-selected" : ""}${date === today ? " is-today" : ""}" data-action="central-calendar-select-day" data-date="${escapeAttr(date)}" aria-pressed="${isSelected ? "true" : "false"}"${date === today ? ' aria-current="date"' : ""} aria-label="${escapeAttr(`${centralCalendarLongDate(date)}${date === today ? ", today" : ""}${count ? `, ${count} item${count === 1 ? "" : "s"}` : ""}${names ? `, ${names}` : ""}`)}">
          <span class="cc-strip-name">${escapeHtml(weekdayShort(date))}</span>
          <span class="cc-strip-number">${dayNumber(date)}</span>
          ${count ? `<span class="cc-strip-count" aria-hidden="true">${count}</span>` : ""}
          ${dotIds.length ? `<span class="cc-strip-dots" aria-hidden="true">${dotIds.map((id) => `<span class="cc-team-dot"${teamColorStyle(id, teams)}></span>`).join("")}${allIds.length > dotIds.length ? `<span class="cc-strip-more">+${allIds.length - dotIds.length}</span>` : ""}</span>` : ""}
        </button>`;
      }).join("")}
    </div>`;
}

// The selected day's row per team (the owner's design): "U19 · 1 item",
// "U13 · 0 items" over the day's visible cards; the chosen teams only while
// the Groups chips choose some. One team alone would only repeat the day's
// count: no row then.
function renderDayTeamsHtml(items, cal, teams) {
  const shown = cal.filters.teamIds.length ? teams.filter((team) => cal.filters.teamIds.includes(team.teamId)) : teams;
  if (shown.length < 2) return "";
  return `<ul class="cc-day-teams" role="list" aria-label="Per group on this day">
      ${shown.map((team) => {
        const count = items.filter((item) => (item.teamIds || []).includes(team.teamId)).length;
        return `<li class="cc-team-pill${count ? "" : " is-empty"}"${teamColorStyle(team.teamId, teams)}><span class="cc-team-dot" aria-hidden="true"></span><span class="cc-team-pill-name">${escapeHtml(`${team.name || "Team"} · ${count} item${count === 1 ? "" : "s"}`)}</span></li>`;
      }).join("")}
    </ul>`;
}

// The cards with a time or a slot, then the ones with neither under "No time"
// (K2a-2): the untimed cards move from the server's place for them (first)
// to the end; each part keeps the server's order (plan section 8).
function renderDayListCardsHtml(items, teams, openKey, today, emptyText, emptyAction = "") {
  if (!items.length) return `<div class="cc-day-cards">${renderDayCardsHtml(items, teams, openKey, today, { emptyText, emptyAction })}</div>`;
  const untimed = items.filter((item) => !item.startTime && !item.slot);
  const timed = items.filter((item) => item.startTime || item.slot);
  return `${timed.length ? `<div class="cc-day-cards">${renderDayCardsHtml(timed, teams, openKey, today)}</div>` : ""}
      ${untimed.length ? `<h5 class="cc-day-section">No time</h5><div class="cc-day-cards cc-day-cards-untimed">${renderDayCardsHtml(untimed, teams, openKey, today)}</div>` : ""}`;
}

function renderSelectedDayListHtml(date, byDate, cal, teams, today, { heading = true } = {}) {
  const items = centralCalendarVisibleItems(byDate.get(date), cal.filters);
  const filtered = centralCalendarFiltersActive(cal.filters);
  const emptyText = filtered ? "Nothing matches these filters on this day." : "Nothing on this day.";
  // A filtered empty day offers the one way back: the same Clear filters as the filter bar.
  const emptyAction = filtered ? `<button type="button" class="om-btn cc-clear-filters" data-action="central-calendar-clear-filters">Clear filters</button>` : "";
  return `<section class="cc-day-list" aria-label="${escapeAttr(centralCalendarLongDate(date))}">
      ${heading ? `<h4 class="cc-day-title">${escapeHtml(centralCalendarLongDate(date))}${date === today ? ` <span class="cc-day-today-tag">Today</span>` : ""}</h4>` : ""}
      ${renderDayTeamsHtml(items, cal, teams)}
      ${renderDayListCardsHtml(items, teams, cal.panel.key, today, emptyText, emptyAction)}
    </section>`;
}

// The month grid: on a wide or medium screen each cell holds up to three
// compact cards and "+n more"; on a phone a cell is one button with the
// day's count and the selected day's list follows the grid.
function renderMonthHtml(days, byDate, cal, teams, today, layout, { dayList = true } = {}) {
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
          ${shown.map((item) => renderMiniCardHtml(item, teams, cal.panel.key, today)).join("")}
          ${more > 0 ? `<button type="button" class="cc-month-more" data-action="central-calendar-open-day" data-date="${escapeAttr(date)}" aria-label="${escapeAttr(`${more} more on ${centralCalendarLongDate(date)}`)}">+${more} more</button>` : ""}
        </div>
      </div>`;
  };
  return `<div class="cc-month" role="group" aria-label="${escapeAttr(monthLabel(`${monthIso}-01`))}">
      <div class="cc-month-weekdays" aria-hidden="true">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name) => `<span>${name}</span>`).join("")}</div>
      ${weeks.map((week) => `<div class="cc-month-week">${week.map(cell).join("")}</div>`).join("")}
    </div>
    ${phone && dayList ? renderSelectedDayListHtml(selected, byDate, cal, teams, today) : ""}`;
}

function renderBodyHtml(cal, layout, today) {
  if (!cal.data) return renderStateHtml(cal);
  const teams = cal.data.teams || [];
  const byDate = centralCalendarItemsByDate(cal.data);
  const days = centralCalendarDisplayedDays(cal.view, cal.anchor);
  const anyVisible = days.some((date) => centralCalendarVisibleItems(byDate.get(date), cal.filters).length > 0);
  const scope = cal.view === "month" ? "this month" : cal.view === "day" ? "on this day" : "this week";
  // A month with nothing to show says so once: a phone then skips the
  // selected day's own "Nothing on this day." under the grid.
  if (cal.view === "month") return renderMonthHtml(days, byDate, cal, teams, today, layout, { dayList: anyVisible }) + (anyVisible ? "" : renderEmptyHtml(cal, scope));
  if (cal.view === "day") return renderSelectedDayListHtml(days[0], byDate, cal, teams, today, { heading: false });
  if (layout === "phone") {
    const selected = days.includes(cal.selectedDate) ? cal.selectedDate : days[0];
    return renderStripHtml(days, byDate, cal, today, teams) + renderSelectedDayListHtml(selected, byDate, cal, teams, today);
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

// A declared expectation with no channel (K2a plan 3.2): a quiet note, never
// a badge. K2a-1b's attach makes the channels.
const GAP_NOTES = Object.freeze({
  rpe: "RPE is expected, but nothing attached to this event asks the athletes for it yet.",
  test_result: "A test result is expected, but no test is attached to this event yet.",
});

function eventDatesText(item) {
  const span = item.span;
  if (span?.from && span?.to && span.to !== span.from) {
    return `${centralCalendarLongDate(span.from)} - ${centralCalendarLongDate(span.to)}`;
  }
  return centralCalendarLongDate(item.date);
}

// The event's own facts in its panel (K2a-2): the days, the place, what it
// expects, the gaps, the notes (a manager's view only carries them); K2b-1d:
// the place from the card's `place`, and a manager's details below.
function renderEventFactsHtml(item) {
  const expects = item.expects || [];
  const gaps = (item.gaps || []).map((gap) => GAP_NOTES[gap]).filter(Boolean);
  if (item.scheduleFold?.external === "separate") gaps.push("The linked RPE request reaches athletes this event does not list, so it is shown as its own card on this day, with its own counts.");
  if (item.scheduleFold?.test === "separate") gaps.push("The linked test reaches athletes this event does not list, so it is shown as its own card on this day, with its own counts.");
  const multiDay = item.span?.from && item.span?.to && item.span.to !== item.span.from;
  return `${multiDay ? `<p class="cc-panel-note">${escapeHtml(`${eventDatesText(item)} (${centralCalendarSpanLabel(item).toLowerCase()})`)}</p>` : ""}
      ${renderCentralCalendarEventPlaceHtml(item)}
      ${expects.length ? `<p class="cc-panel-note">${escapeHtml(`Collects: ${expects.map((expect) => CENTRAL_CALENDAR_EXPECT_SHORT[expect] || expect).join(", ")}.`)}</p>` : ""}
      ${gaps.map((note) => `<p class="cc-panel-note cc-panel-gap">${escapeHtml(note)}</p>`).join("")}
      ${item.notes ? `<div class="cc-panel-notes"><h4 class="cc-panel-subtitle">Notes <span class="cc-field-optional">(coaches only)</span></h4><p class="cc-panel-notes-text">${escapeHtml(item.notes)}</p></div>` : ""}`;
}

// Edit and Cancel only where the card says the server would take them
// (`canManage`, D18) and the event is not cancelled. K2a-1b: "Attach a
// training" and "Attach an activity" join this row (the attach routes).
function renderEventActionsHtml(item) {
  if (item.kind !== "event" || item.canManage !== true || item.cancelled) return "";
  return `<div class="cc-panel-actions">
      <button type="button" class="plain-button cc-panel-button" data-action="central-calendar-edit-event" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}">Edit</button>
      <button type="button" class="plain-button cc-panel-button cc-danger-outline" data-action="central-calendar-cancel-event" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}">Cancel event</button>
    </div>`;
}

function panelHost(body, layout) {
  if (layout === "wide") return `<aside class="cc-panel" aria-labelledby="ccPanelTitle">${body}</aside>`;
  return `<button type="button" class="cc-sheet-backdrop" data-action="central-calendar-close-panel" aria-label="Close" tabindex="-1"></button>
    <aside class="cc-panel cc-sheet" role="dialog" aria-modal="true" aria-labelledby="ccPanelTitle">${body}</aside>`;
}

function renderPanelHtml(cal, layout, today, roster, formCtx) {
  // The event form takes the panel's place (K2a-2); the item's panel comes
  // back when the form closes.
  if (cal.form) return panelHost(renderCentralCalendarEventFormHtml(cal.form, { ...formCtx, longDate: centralCalendarLongDate }), layout);
  const panel = cal.panel;
  const item = panelItemOf(cal);
  if (!item) return "";
  const teams = cal.data.teams || [];
  const when = centralCalendarWhenLabel(item);
  const sentence = centralCalendarStatusSentence(item);
  const count = centralCalendarCountLabel(item);
  const activityIds = item.links?.activityIds || [];
  const thing = item.kind === "event" ? "event" : item.kind === "external" ? "RPE request" : "training";
  const singularNote = item.kind === "planned" || item.kind === "external" || item.kind === "event" ? `<p class="cc-panel-note">1 activity is recorded for this ${thing}.</p>` : "";
  const trainingLoad = activityIds.length === 1
    ? `<button type="button" class="plain-button cc-panel-button" data-action="central-calendar-open-training-load" data-activity-id="${escapeAttr(activityIds[0])}" data-date="${escapeAttr(item.date)}">Open in Training Load</button>${singularNote}`
    : activityIds.length > 1
      ? `<button type="button" class="plain-button cc-panel-button" data-action="central-calendar-open-training-load" data-date="${escapeAttr(item.date)}">Open the day in Training Load</button><p class="cc-panel-note">${activityIds.length} activities are recorded for this ${thing}.</p>`
      : "";
  const body = `<header class="cc-panel-head">
        <h3 class="cc-panel-title" id="ccPanelTitle">${escapeHtml(centralCalendarTitle(item))}</h3>
        <button type="button" class="plain-button icon-button cc-panel-close" data-action="central-calendar-close-panel" aria-label="Close">&times;</button>
      </header>
      <p class="cc-panel-kind">${itemIconHtml(item, "cc-panel-icon")}<span>${escapeHtml(centralCalendarKindLabel(item))}</span></p>
      <p class="cc-panel-when">${escapeHtml(centralCalendarLongDate(item.date))}${item.date === today ? " (today)" : ""}${when ? ` · ${escapeHtml(when)}` : ""}</p>
      ${(item.teamIds || []).length ? `<p class="cc-panel-teams">${item.teamIds.map((id) => `<span class="cc-panel-team"${teamColorStyle(id, teams)}><span class="cc-team-dot" aria-hidden="true"></span>${escapeHtml(teamName(id, teams))}</span>`).join("")}</p>` : ""}
      ${renderBadgeHtml(item, today) || count || sentence ? `<div class="cc-panel-status">${renderBadgeHtml(item, today)}${count ? `<span class="cc-panel-count">${escapeHtml(count)}</span>` : ""}${sentence ? `<p class="cc-panel-sentence">${escapeHtml(sentence)}</p>` : ""}</div>` : ""}
      ${item.kind === "event" ? renderEventFactsHtml(item) : ""}
      ${item.kind === "event" ? renderCentralCalendarEventDetailsHtml(item, cal.panelEvent) : ""}
      ${renderEventActionsHtml(item)}
      ${trainingLoad}
      <section class="cc-panel-athletes">${renderPanelAthletesHtml(item, cal, roster)}</section>`;
  return panelHost(body, layout);
}

// The event saves the coach left while their result was not known (the
// actions module's memory, this workspace's only): one line with a Check
// result per save, which opens its "Check the earlier result". Not while a
// form is open (the form holds the panel).
function renderUncertainWritesHtml(cal, writes) {
  if (cal.form || !writes?.length) return "";
  const label = (entry) => {
    const title = String(entry.eventTitle || "").replace(/\s+/g, " ").trim() || (entry.mode === "create" ? "the new event" : "the event");
    if (entry.mode === "values") return `Check the details of “${title}”`;
    return entry.mode === "create" ? `Check “${title}”` : entry.mode === "cancel" ? `Check cancelling “${title}”` : `Check the change to “${title}”`;
  };
  return `<div class="cc-refresh-note cc-uncertain-line" role="status">
      <span>${writes.length === 1 ? "1 save of an event is not confirmed." : `${writes.length} saves of events are not confirmed.`}</span>
      ${writes.map((entry) => `<button type="button" class="plain-button cc-inline-button" data-action="central-calendar-event-pending" data-request-key="${escapeAttr(entry.requestKey)}">${escapeHtml(label(entry))}</button>`).join("")}
    </div>`;
}

// `canCreate`: the active workspace may create events (a club, a team, a
// private coach - the actions module decides from the answer's workspace);
// `eventRoster`: the workspace's athletes for the form's targets ({ id, name });
// `uncertainWrites`: the event saves left unconfirmed in this workspace.
export function renderCentralCalendarHtml(cal, { today, layout = "wide", roster = new Map(), canCreate = false, eventRoster = [], uncertainWrites = [] } = {}) {
  const teams = cal.data?.teams || [];
  const byDate = centralCalendarItemsByDate(cal.data);
  const days = cal.anchor ? centralCalendarDisplayedDays(cal.view, cal.anchor) : [];
  const counts = centralCalendarChipCounts(byDate, days);
  // The panel column exists only while the open item is really in the answer,
  // or while the event form is open.
  const panelOpen = Boolean(cal.form) || Boolean(panelItemOf(cal));
  cardTypes = new Map((cal.eventTypes || []).map((type) => [String(type.id), type]));
  const formCtx = { types: cal.eventTypes || [], teams, roster: eventRoster, catalog: centralCalendarCatalogOf(cal) };
  return `<section class="central-calendar cc-layout-${escapeAttr(layout)} cc-view-${escapeAttr(cal.view)}${panelOpen ? " cc-panel-open" : ""}" aria-label="Calendar">
      ${cal.anchor ? renderToolbarHtml(cal, layout, { canCreate }) : ""}
      ${renderFiltersHtml(cal, counts, teams)}
      ${cal.refreshError ? `<p class="cc-refresh-note" role="status">${escapeHtml(cal.refreshError)} <button type="button" class="plain-button cc-inline-button" data-action="central-calendar-retry">Try again</button></p>` : ""}
      ${cal.notice ? `<p class="cc-refresh-note" role="status">${escapeHtml(cal.notice)}</p>` : ""}
      ${renderUncertainWritesHtml(cal, uncertainWrites)}
      <div class="cc-body">
        <div class="cc-main">${cal.anchor ? renderBodyHtml(cal, layout, today) : renderStateHtml(cal)}</div>
        ${renderPanelHtml(cal, layout, today, roster, formCtx)}
      </div>
    </section>`;
}

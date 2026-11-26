import { calendarColorIndex, calendarTeamColorIndexes } from "./calendar-colors.js";
import { CENTRAL_CALENDAR_EVENT_KINDS, CENTRAL_CALENDAR_SHOW_ONLY, centralCalendarShownData, centralCalendarTeamLabel } from "./central-calendar-data.js";
import {
  centralCalendarCatalogOf,
  centralCalendarEventDetailsParts,
  renderCentralCalendarEventPlaceHtml,
} from "./central-calendar-event-details.js";
import { CENTRAL_CALENDAR_EXPECT_SHORT, renderCentralCalendarEventFormHtml } from "./central-calendar-event-form.js";
import { renderK2c3FormBandHtml, renderK3PanelHtml, renderK3SheetHtml } from "./central-calendar-k3-view.js";
import {
  CENTRAL_CALENDAR_ADD_TO_EVENT_HINT,
  CENTRAL_CALENDAR_ADD_TO_EVENT_NONE,
  CENTRAL_CALENDAR_ALIGN_NOT_ALLOWED,
  CENTRAL_CALENDAR_LINK_EMPTY,
  CENTRAL_CALENDAR_LINKED_HINT,
  CENTRAL_CALENDAR_LINKS_LOAD_FAILED,
  CENTRAL_CALENDAR_ORPHANED_META,
  centralCalendarActivityLinksOf,
  centralCalendarAddToEventKind,
  centralCalendarAddToEventName,
  centralCalendarAddToEventOffers,
  centralCalendarAddToEventQuestion,
  centralCalendarAlignLine,
  centralCalendarDeleteEventQuestion,
  centralCalendarDeleteRefusedKey,
  centralCalendarEventLinkable,
  centralCalendarEventsForPlanned,
  centralCalendarLinkBusyWord,
  centralCalendarLinkSuggestions,
  centralCalendarOrphanedLine,
  centralCalendarPartialLine,
  centralCalendarPlannedPartialLine,
  centralCalendarResultsQuestion,
  centralCalendarSessionLinkGroups,
} from "./central-calendar-links.js";
import { CC_WAITING_SENTENCE, ccPanelAskOffered, ccPanelQuestionList, ccPanelQuestionsWaiting, renderCentralCalendarQuestionsHtml } from "./central-calendar-questions.js";
import { centralCalendarGridHours, centralCalendarMinutesOf, centralCalendarTimeLayout } from "./central-calendar-timegrid.js";
import {
  ccAnswerEntries,
  ccAnswersReadable,
  ccAnswersSummary,
  ccAnswersSummaryParts,
  ccAnswersSummarySpoken,
  ccAnswersWanted,
  ccAthleteAnswerText,
  ccChangedAtOf,
  ccChangedText,
  ccSpokenAnswerText,
} from "./central-calendar-answers.js";
import { gpsReviewMark, gpsReviewMarksShown, gpsReviewWords } from "./central-calendar-gps-review.js";
import { isLibraryKey, renderIconSvg } from "./icon-render.js";
import {
  buildCentralCalendarSwitcherModel,
  centralCalendarChosenAthlete,
  renderCentralCalendarSeeEachHtml,
  renderCentralCalendarShowingLineHtml,
  renderCentralCalendarSwitcherHtml,
} from "./central-calendar-switcher.js";
import { state } from "./state.js";
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
// K5-2 (Q7): one icon per kind everywhere - a test is `clipboard`, as in the approved mockups.
export const CENTRAL_CALENDAR_KIND_ICONS = Object.freeze({ event: "calendar-event", planned: "barbell", activity: "activity", external: "gauge", test: "clipboard" });
// *Show only* (contract 2.5): the pills' words and icons, one client kind each.
export const CENTRAL_CALENDAR_SHOW_ONLY_LABELS = Object.freeze({
  event: "Events", planned: "Planned training", gps: "GPS imports", other_activity: "Other activities", external: "RPE requests", test: "Scheduled tests",
});
export const CENTRAL_CALENDAR_SHOW_ONLY_ICONS = Object.freeze({
  event: "calendar-event", planned: "barbell", gps: "gps", other_activity: "activity", external: "gauge", test: "clipboard",
});
// H4 (contract 2.3): what an event holds, as marks in this order; the words for its label.
const MARK_ICONS = Object.freeze({ rpe: "gauge", gps: "gps", test: "clipboard" });
const MARK_WORDS = Object.freeze({ rpe: "RPE", gps: "GPS data", test: "a test" });
// The server's IMPORTED_ORIGINS (backend/src/calendarQuery.js).
const IMPORTED_ORIGINS = Object.freeze(["api_import", "source_import"]);
// H5 (contract 2.4): what is in no event shows as a small chip under its day.
const DAY_CHIP_KINDS = Object.freeze(["test", "external", "activity"]);
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

// K5-2 (contract 2.1): an imported activity, or an event, planned or RPE card that holds one (`holdsImport`, a
// coach's or a reader's answer only).
export function centralCalendarItemImported(item) {
  if (item?.kind === "activity") return IMPORTED_ORIGINS.includes(item.origin);
  if (item?.kind === "event" || item?.kind === "planned" || item?.kind === "external") return item.holdsImport === true;
  return false;
}

// *Show only*'s match for one client kind (contract 2.5).
export function centralCalendarShowOnlyMatches(item, only) {
  switch (only) {
    case "gps": return centralCalendarItemImported(item);
    case "other_activity": return item?.kind === "activity" && !centralCalendarItemImported(item);
    default: return item?.kind === only;
  }
}

// Decision A: a card is hidden when it carries none of the chosen teams or does not match *Show only* (K5-2: at most
// one kind). Event types narrow events only (choosing one sets *Show only* to Events). Nothing inside a card changes.
export function centralCalendarVisibleItems(items, filters) {
  const teamIds = filters?.teamIds || [];
  const only = (filters?.kinds || [])[0] || "";
  const eventKinds = filters?.eventKinds || [];
  return (items || []).filter((item) => {
    if (only && !centralCalendarShowOnlyMatches(item, only)) return false;
    if (eventKinds.length && !(item.kind === "event" && eventKinds.includes(item.eventKind))) return false;
    if (teamIds.length && !(item.teamIds || []).some((id) => teamIds.includes(id))) return false;
    return true;
  });
}

// H4 (contract 2.3): the marks of what a card holds, in this order. An event: RPE (its folded RPE request, or RPE
// expected while no request stands beside it), GPS (an import), test (likewise). A planned or RPE card: only GPS.
// Nothing on a cancelled card or any other kind (the athlete's reduced card has none of these fields).
export function centralCalendarCardMarks(item) {
  if (!item || item.cancelled) return [];
  if (item.kind === "planned" || item.kind === "external") return item.holdsImport === true ? ["gps"] : [];
  if (item.kind !== "event") return [];
  const expects = item.expects || [];
  const fold = item.scheduleFold || {};
  const marks = [];
  if (fold.external === "folded" || (expects.includes("rpe") && fold.external !== "separate")) marks.push("rpe");
  if (item.holdsImport === true) marks.push("gps");
  if (fold.test === "folded" || (expects.includes("test_result") && fold.test !== "separate")) marks.push("test");
  return marks;
}

// "Holds RPE, GPS data and a test"; "" without marks.
export function centralCalendarMarksLabel(marks) {
  const words = (marks || []).map((mark) => MARK_WORDS[mark]).filter(Boolean);
  if (!words.length) return "";
  return `Holds ${words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`}`;
}

function renderMarksHtml(item, size = 14) {
  const marks = centralCalendarCardMarks(item);
  if (!marks.length) return "";
  return `<span class="cc-card-marks" role="img" aria-label="${escapeAttr(centralCalendarMarksLabel(marks))}">${marks.map((mark) => renderIconSvg(MARK_ICONS[mark], { size, className: `cc-mark cc-mark-${mark}` })).join("")}</span>`;
}

// H5: a test, an RPE request or an activity is a small chip under its day (contract 2.4).
export function centralCalendarIsDayChip(item) {
  return DAY_CHIP_KINDS.includes(item?.kind);
}

// The chip's short text: "CMJ test", "RPE · Gym", "GPS 10:05" / "GPS", or the activity's title.
export function centralCalendarDayChipText(item) {
  if (item.kind === "external") return `RPE · ${centralCalendarTitle(item)}`;
  if (item.kind === "activity" && centralCalendarItemImported(item)) return item.startTime ? `GPS ${String(item.startTime).slice(0, 5)}` : "GPS";
  return centralCalendarTitle(item);
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
  // K5-2: the *Show only* kinds; GPS imports also counts the event, planned and RPE cards holding an import (Q11).
  const kinds = Object.fromEntries(CENTRAL_CALENDAR_SHOW_ONLY.map((kind) => [kind, 0]));
  const eventKinds = new Map();
  let total = 0;
  for (const date of days) {
    for (const item of byDate.get(date) || []) {
      total += 1;
      for (const kind of CENTRAL_CALENDAR_SHOW_ONLY) if (centralCalendarShowOnlyMatches(item, kind)) kinds[kind] += 1;
      if (item.kind === "event" && item.eventKind) eventKinds.set(item.eventKind, (eventKinds.get(item.eventKind) || 0) + 1);
      for (const teamId of item.teamIds || []) teams.set(teamId, (teams.get(teamId) || 0) + 1);
    }
  }
  return { teams, kinds, eventKinds, total };
}

// K2b-1d3 (plan 24.1): every event card - a manager's, a reader's and the
// athlete's - carries its type's look (K2b-1d2: `eventTypeIconKey` /
// `eventTypeColorKey`, null when the type is not shown under D41), so the
// cards read no catalog. A key outside the icon library falls back to the
// kind's icon; a colour outside the palette gives no tint.
export function centralCalendarItemIconKey(item) {
  if (item?.kind === "event") {
    if (isLibraryKey(item.eventTypeIconKey)) return item.eventTypeIconKey;
    return CENTRAL_CALENDAR_EVENT_KIND_ICONS[item.eventKind] || CENTRAL_CALENDAR_KIND_ICONS.event;
  }
  // K5-2: an imported activity is `gps` everywhere (card, chip, month, panel).
  if (item?.kind === "activity" && centralCalendarItemImported(item)) return "gps";
  return CENTRAL_CALENDAR_KIND_ICONS[item?.kind] || CENTRAL_CALENDAR_KIND_ICONS.event;
}

// The type's palette index for an event card, -1 for none.
export function centralCalendarItemColorIndex(item) {
  if (item?.kind !== "event") return -1;
  return calendarColorIndex(item.eventTypeColorKey);
}

// The type's colour on its icon (the stripe stays the team's colour).
function typeColorStyle(item) {
  const index = centralCalendarItemColorIndex(item);
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
  return centralCalendarTeamLabel((teams || []).find((team) => team.teamId === teamId));
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
    const word = centralCalendarItemImported(item) ? "Imported activity" : "Activity";
    return count ? `${word} · ${athleteCountLabel(count)}` : word;
  }
  if (item.kind === "external") {
    const type = eventTypeLabel(item.eventType);
    return `RPE request${type && type !== "Event" && type !== item.title ? ` · ${type}` : ""}${count ? ` · ${athleteCountLabel(count)}` : ""}`;
  }
  if (item.kind === "test") return `Scheduled test${count ? ` · ${athleteCountLabel(count)}` : ""}`;
  return "";
}

// The card's type line in a wide week column (the manager's decision, 2026-11-10): an event shows
// its type word and count without the "Event ·" prefix ("Team training · 12 athletes"); a title
// that already is the type word leaves the count, and nothing at all leaves "Event". Every other
// kind keeps its own word, which is what tells it apart. The whole label stays the card's title.
export function centralCalendarShortKindLabel(item) {
  if (item?.kind !== "event") return centralCalendarKindLabel(item);
  const word = eventKindWord(item);
  const count = Number(item.athleteCount) || 0;
  const parts = [item.title && item.title !== word ? word : "", count ? athleteCountLabel(count) : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Event";
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

// K7 (2.1): a multi-day event's times in the time grid's band - "from 10:00" on its first day, "until 16:00" on its
// last, nothing on the days between (its "Day 2 of 3" says where it is).
export function centralCalendarSpanWhenLabel(item) {
  const span = item?.span;
  if (!span?.from || !span?.to || span.to <= span.from) return centralCalendarWhenLabel(item);
  if (item.date === span.from && item.startTime) return `from ${String(item.startTime).slice(0, 5)}`;
  if (item.date === span.to && item.endTime) return `until ${String(item.endTime).slice(0, 5)}`;
  return "";
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

function cardAriaLabel(item, teams, today, { spanWhen = false } = {}) {
  const parts = [centralCalendarTitle(item), centralCalendarKindLabel(item)];
  const marks = centralCalendarMarksLabel(centralCalendarCardMarks(item));
  if (marks) parts.push(marks);
  const when = spanWhen ? centralCalendarSpanWhenLabel(item) : centralCalendarWhenLabel(item);
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

// K7, the time grid: `spanWhen` (the band) shows a multi-day event's times as "from 10:00" / "until 16:00";
// `gridBox` (a positioned box) splits the time so the end can hide when the box itself is narrow (a container query
// in styles.css), and gives the whole time and title as the card's tooltip. The label always keeps the whole time.
export function renderCentralCalendarCardHtml(item, { teams, openKey = "", today = "", shortKind = false, spanWhen = false, gridBox = false } = {}) {
  const fullWhen = spanWhen ? centralCalendarSpanWhenLabel(item) : centralCalendarWhenLabel(item);
  const when = fullWhen;
  const titleAttr = gridBox ? ` title="${escapeAttr([fullWhen, centralCalendarTitle(item)].filter(Boolean).join(" "))}"` : "";
  const start = String(item.startTime || "").slice(0, 5);
  const whenHtml = gridBox && item.startTime && item.endTime && fullWhen.startsWith(start)
    ? `${escapeHtml(start)}<span class="cc-card-when-end">${escapeHtml(fullWhen.slice(start.length))}</span>`
    : escapeHtml(when);
  const count = centralCalendarCountLabel(item);
  const span = centralCalendarSpanLabel(item);
  const firstTeam = (item.teamIds || [])[0];
  const place = item.kind === "event" ? eventPlaceText(item) : "";
  // H4: what the card holds. In a time-grid box the marks follow the title - the time, then the title, then the marks
  // (K7 keeps the time first; a one-line box reads "10:00 Title... marks"); elsewhere they follow the type's icon
  // (K5-2 contract 2.3).
  const marks = renderMarksHtml(item);
  const classes = ["cc-card", `cc-card-${escapeAttr(item.kind)}`];
  if (item.cancelled) classes.push("is-cancelled");
  if (openKey && openKey === item.key) classes.push("is-open");
  if (!firstTeam) classes.push("cc-card-no-team");
  return `<button type="button" class="${classes.join(" ")}" data-action="central-calendar-open-item" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}"${teamColorStyle(firstTeam, teams)}${titleAttr} aria-label="${escapeAttr(cardAriaLabel(item, teams, today, { spanWhen }))}" aria-pressed="${openKey === item.key ? "true" : "false"}">
      <span class="cc-card-stripe" aria-hidden="true"></span>
      <span class="cc-card-body">
        <span class="cc-card-top">${itemIconHtml(item)}${gridBox ? "" : marks}${when ? `<span class="cc-card-when">${whenHtml}</span>` : ""}<span class="cc-card-kind" title="${escapeAttr(centralCalendarKindLabel(item))}">${escapeHtml(shortKind ? centralCalendarShortKindLabel(item) : centralCalendarKindLabel(item))}</span>${span ? `<span class="cc-card-span">${escapeHtml(span)}</span>` : ""}</span>
        <span class="cc-card-title">${escapeHtml(centralCalendarTitle(item))}</span>${gridBox ? marks : ""}
        ${place ? `<span class="cc-card-place">${escapeHtml(place)}</span>` : ""}
        ${centralCalendarScheduleSeparate(item) ? `<span class="cc-card-note">${SEPARATE_WORDS}</span>` : ""}
        <span class="cc-card-meta">${renderTeamPillHtml(firstTeam, teams)}${renderBadgeHtml(item, today)}${count ? `<span class="cc-card-count">${escapeHtml(count)}</span>` : ""}${renderTeamDotsHtml(item, teams)}</span>
      </span>
    </button>`;
}

// The month cell's compact card: the team colour, the type's icon, the
// title and the status.
function renderMiniCardHtml(item, teams, openKey, today, { mobileTimeline = false } = {}) {
  const badge = centralCalendarStatusBadge(item, today);
  const firstTeam = (item.teamIds || [])[0];
  return `<button type="button" class="cc-mini cc-mini-${escapeAttr(item.kind)}${item.cancelled ? " is-cancelled" : ""}${openKey === item.key ? " is-open" : ""}" data-action="central-calendar-open-item" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}"${teamColorStyle(firstTeam, teams)} aria-label="${escapeAttr(cardAriaLabel(item, teams, today))}" aria-pressed="${openKey === item.key ? "true" : "false"}">
        <span class="cc-mini-dot" aria-hidden="true"></span>
        <span class="cc-mini-title">${itemIconHtml(item, "cc-mini-icon", 12)}${renderMarksHtml(item, 12)}${mobileTimeline ? `<span class="cc-mini-name">${escapeHtml(centralCalendarTitle(item))}</span>` : escapeHtml(centralCalendarTitle(item))}</span>
        ${badge ? `<span class="cc-mini-status cc-mini-status-${badge.tone}" aria-hidden="true"></span>` : ""}
      </button>`;
}

// H5 (contract 2.4): the day chip of a test, an RPE request or an activity - its kind's icon, short text, the GPS mark
// of an RPE request that holds an import, and the status as a dot; the full sentence is its aria-label. A click opens
// its panel, as a card does.
function renderDayChipHtml(item, teams, openKey, today) {
  const badge = centralCalendarStatusBadge(item, today);
  const firstTeam = (item.teamIds || [])[0];
  const classes = ["cc-daychip", `cc-daychip-${escapeAttr(item.kind)}`];
  if (centralCalendarItemImported(item)) classes.push("is-imported");
  if (item.cancelled) classes.push("is-cancelled");
  if (openKey && openKey === item.key) classes.push("is-open");
  // The tooltip: the whole name (a narrow column cuts it) and the status the dot stands for.
  const tooltip = `${centralCalendarDayChipText(item)}${badge ? ` · ${badge.label}` : ""}`;
  return `<button type="button" class="${classes.join(" ")}" data-action="central-calendar-open-item" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}"${teamColorStyle(firstTeam, teams)} title="${escapeAttr(tooltip)}" aria-label="${escapeAttr(cardAriaLabel(item, teams, today))}" aria-pressed="${openKey === item.key ? "true" : "false"}">${itemIconHtml(item, "cc-daychip-icon", 14)}${renderMarksHtml(item)}<span class="cc-daychip-text">${escapeHtml(centralCalendarDayChipText(item))}</span>${badge ? `<span class="cc-daychip-status cc-mini-status-${badge.tone}" aria-hidden="true"></span>` : ""}</button>`;
}

// One item in a day's list: a full card, or a chip (H5).
function renderDayItemHtml(item, teams, openKey, today, shortKind = false) {
  return centralCalendarIsDayChip(item) ? renderDayChipHtml(item, teams, openKey, today) : renderCentralCalendarCardHtml(item, { teams, openKey, today, shortKind });
}

// A day's items in the list layouts: its cards first, then its chips, each part in the server's order (E4).
function renderCardsThenChipsHtml(items, teams, openKey, today, shortKind = false) {
  const cards = items.filter((item) => !centralCalendarIsDayChip(item));
  const chips = items.filter((item) => centralCalendarIsDayChip(item));
  return `${cards.map((item) => renderCentralCalendarCardHtml(item, { teams, openKey, today, shortKind })).join("")}${chips.length ? `<div class="cc-daychips">${chips.map((item) => renderDayChipHtml(item, teams, openKey, today)).join("")}</div>` : ""}`;
}

function renderChipHtml({ action, dataAttr = "", value = "", label, count, active, style = "", dot = false, icon = "" }) {
  const data = dataAttr ? ` ${dataAttr}="${escapeAttr(value)}"` : "";
  return `<button type="button" class="cc-chip${active ? " is-active" : ""}" data-action="${action}"${data} aria-pressed="${active ? "true" : "false"}" aria-label="${escapeAttr(`${label}, ${count}`)}"${style}>${dot ?`<span class="cc-chip-dot" aria-hidden="true"></span>` : ""}${icon ? renderIconSvg(icon, { size: 14, className: "cc-chip-icon" }) : ""}<span class="cc-chip-label">${escapeHtml(label)}</span><span class="cc-chip-count">${escapeHtml(String(count))}</span></button>`;
}

// *More filters*' one line (K5-2: the kinds are the *Show only* row's): "All groups · all event types", or the chosen
// names (two at most, then a count).
export function centralCalendarFiltersSummary(filters, teams) {
  const names = (list, label, plural) => (list.length <= 2 ? list.join(", ") : `${list.length} ${plural}`) || label;
  const groups = names((filters.teamIds || []).map((id) => teamName(id, teams)), "All groups", "groups");
  const types = (filters.eventKinds || []).map((kind) => CENTRAL_CALENDAR_EVENT_KIND_LABELS[kind] || kind);
  return `${groups} · ${names(types, "all event types", "event types")}`;
}

// *Show only* (contract 2.5, H3): one row of pills, a radio group - All and the six client kinds, each with its icon
// and the displayed days' count. One tap shows only that kind; another switches straight over.
function renderShowOnlyHtml(cal, counts) {
  const only = (cal.filters.kinds || [])[0] || "";
  const pill = (kind, label, count, icon) => {
    const on = kind === only;
    return `<button type="button" class="cc-chip cc-showonly-pill${on ? " is-active" : ""}${kind ? ` cc-showonly-${kind}` : ""}" role="radio" aria-checked="${on ? "true" : "false"}" tabindex="${on ? "0" : "-1"}" data-action="central-calendar-show-only" data-kind="${escapeAttr(kind)}" aria-label="${escapeAttr(`${label}, ${count}`)}">${icon ? renderIconSvg(icon, { size: 16, className: "cc-chip-icon" }) : ""}<span class="cc-chip-label">${escapeHtml(label)}</span><span class="cc-chip-count">${escapeHtml(String(count))}</span></button>`;
  };
  return `<div class="cc-showonly" role="radiogroup" aria-label="Show only">
      ${pill("", "All", counts.total, "")}
      ${CENTRAL_CALENDAR_SHOW_ONLY.map((kind) => pill(kind, CENTRAL_CALENDAR_SHOW_ONLY_LABELS[kind], counts.kinds[kind] || 0, CENTRAL_CALENDAR_SHOW_ONLY_ICONS[kind])).join("")}
    </div>`;
}

// The green line while *Show only* is not All (E10): "Showing only GPS imports · 5 this week · Show all".
function renderShowOnlyLineHtml(cal, counts) {
  const only = (cal.filters.kinds || [])[0] || "";
  if (!only) return "";
  // Events narrowed by event types counts the events of those types, as the screen shows them.
  const eventKinds = only === "event" ? cal.filters.eventKinds || [] : [];
  const count = eventKinds.length ? eventKinds.reduce((sum, kind) => sum + (counts.eventKinds.get(kind) || 0), 0) : counts.kinds[only] || 0;
  const scope = cal.view === "month" ? "this month" : cal.view === "day" ? "on this day" : "this week";
  return `<p class="cc-showonly-line" role="status">${renderIconSvg(CENTRAL_CALENDAR_SHOW_ONLY_ICONS[only], { size: 16, className: "cc-showonly-line-icon" })}<span>Showing only <strong>${escapeHtml(CENTRAL_CALENDAR_SHOW_ONLY_LABELS[only] || only)}</strong> · ${count} ${scope}</span><button type="button" class="plain-button cc-inline-button cc-showonly-all" data-action="central-calendar-all-types">Show all</button></p>`;
}

// The filters (the owner's design, K5-2): the green line and the *Show only* row stay in view; *More filters* folds
// the Groups and Event types chips away with a summary line. The folded chips stay in the markup (hidden) so their
// sideways scroll and the focus survive a repaint. Groups: All groups and a chip per team with its colour dot; Event
// types: a chip per event kind on the displayed days (or chosen).
function renderFiltersHtml(cal, counts, teams, { compact = false } = {}) {
  if (!cal.data) return "";
  const filters = cal.filters;
  // *Clear filters* beside More filters only while a group or an event type is chosen: Show only alone is reset by
  // the green line's Show all (one button per question).
  // K6 (contract 2.2): the Groups chips moved into the switcher box above the grid; Clear filters clears the athlete too.
  const active = (filters.teamIds?.length || 0) + (filters.eventKinds?.length || 0) + (cal.switcher?.athleteKey ? 1 : 0) > 0;
  const open = Boolean(cal.filtersOpen);
  const groups = "";
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
      ${renderShowOnlyLineHtml(cal, counts)}
      ${compact ? "" : renderShowOnlyHtml(cal, counts)}
      <div class="cc-filters-bar">
        <button type="button" class="cc-filters-toggle" data-action="central-calendar-toggle-filters" aria-expanded="${open ? "true" : "false"}" aria-controls="ccFiltersBody">
          ${renderIconSvg("adjust", { size: 18, className: "cc-filters-icon" })}<span class="cc-filters-word">More filters</span><span class="cc-filters-summary">${escapeHtml(centralCalendarFiltersSummary(filters, teams))}</span><span class="cc-filters-chevron" aria-hidden="true"></span>
        </button>
        ${active ? `<button type="button" class="plain-button cc-clear-filters" data-action="central-calendar-clear-filters">Clear filters</button>` : ""}
      </div>
      <div class="cc-filters-body" id="ccFiltersBody"${open ? "" : " hidden"}>${compact ? renderShowOnlyHtml(cal, counts) : ""}${groups}${eventTypes}</div>
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

function renderNewEventHtml(cal, canCreate) {
  // K2a-2: New event only where this workspace may create one (a club, a
  // team, a private coach); the server decides again on the write.
  return canCreate
    ? `<button type="button" class="plain-button cc-primary cc-new-event" data-action="central-calendar-new-event"${cal.form || cal.linkWrite ? " disabled" : ""}>${renderIconSvg("calendar-event", { size: 18 })}<span>New event</span></button>`
    : "";
}

function renderToolbarHtml(cal, layout, { canCreate = false } = {}) {
  const unit = cal.view === "month" ? "month" : cal.view === "day" ? "day" : "week";
  const newEvent = layout === "phone" ? "" : renderNewEventHtml(cal, canCreate);
  const segment = (value, label, action, attr, current) => `<button type="button" class="cc-segment${current === value ? " is-active" : ""}" data-action="${action}" ${attr}="${value}" aria-pressed="${current === value ? "true" : "false"}" aria-label="${label}" title="${label}">${renderSwitchIcon(value)}</button>`;
  // K7 (Q1): the Day view on wide has the same switch, one choice for both; it shows List while "+N more"'s list is open.
  const mode = cal.view === "day" && cal.dayList ? "list" : cal.weekMode || "list";
  const modeSwitch = (layout === "wide" || layout === "phone") && (cal.view === "week" || cal.view === "day")
    ? `<div class="cc-segmented cc-mode-switch" role="group" aria-label="${cal.view === "day" ? "Day layout" : "Week layout"}">
          ${segment("list", "List", "central-calendar-mode", "data-mode", mode)}
          ${segment("grid", "Time grid", "central-calendar-mode", "data-mode", mode)}
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

// K5-4 (docs/ai/central-calendar-k5-4-contract.md 2.1): a day's GPS mark, "N GPS sessions to review". It is not an
// item: no panel, no key, never in the visible items; its click opens Imports on the day. A mini mark (the month grid)
// shows the icon and the number only.
function gpsMarkFor(cal, date) {
  return gpsReviewMarksShown(cal) ? gpsReviewMark(cal, date) : null;
}

function renderGpsMarkHtml(cal, date, { mini = false } = {}) {
  const mark = gpsMarkFor(cal, date);
  if (!mark) return "";
  const words = gpsReviewWords(mark);
  // A mini mark: the icon and the number; an uncertain one "?" (its label says "GPS sessions may be waiting").
  const shown = mini ? (mark.uncertain ? "?" : `${mark.count}${mark.plus ? "+" : ""}`) : words;
  return `<button type="button" class="cc-daymark cc-daymark-gps${mini ? " cc-daymark-mini" : ""}" data-action="central-calendar-gps-review" data-date="${escapeAttr(date)}" aria-label="${escapeAttr(`${words} on ${centralCalendarLongDate(date)}, open Imports`)}">${renderIconSvg("gps", { size: 16, className: "cc-daymark-icon" })}${shown ? `<span class="cc-daymark-words">${escapeHtml(shown)}</span>` : ""}</button>`;
}

// Where a day is one button (a phone's strip and month cells), the mark is a sign inside it and part of its label;
// the mark itself is in the selected day's list.
function gpsMarkLabel(cal, date) {
  const mark = gpsMarkFor(cal, date);
  return mark ? `, ${gpsReviewWords(mark)}` : "";
}

function gpsMarkSignHtml(cal, date) {
  return gpsMarkFor(cal, date) ? `<span class="cc-daymark-sign" aria-hidden="true">${renderIconSvg("gps", { size: 12, className: "cc-daymark-icon" })}</span>` : "";
}

function renderDayCardsHtml(items, teams, openKey, today, { emptyText = "—", emptyAction = "", shortKind = false } = {}) {
  if (!items.length && emptyAction) return `<div class="om-empty cc-day-empty" role="status"><p class="om-empty__text">${escapeHtml(emptyText)}</p><div class="om-empty__actions">${emptyAction}</div></div>`;
  if (!items.length) return `<p class="cc-day-empty">${escapeHtml(emptyText)}</p>`;
  return renderCardsThenChipsHtml(items, teams, openKey, today, shortKind);
}

function dayHeadHtml(date, today, count, { button = true } = {}) {
  const label = `${centralCalendarLongDate(date)}${date === today ? ", today" : ""}${count ? `, ${count} item${count === 1 ? "" : "s"}` : ""}`;
  const inner = `<span class="cc-day-name">${escapeHtml(weekdayShort(date))}</span><span class="cc-day-number">${dayNumber(date)}</span>${count ? `<span class="cc-day-count">${count}</span>` : ""}`;
  if (!button) return `<div class="cc-day-head" aria-label="${escapeAttr(label)}">${inner}</div>`;
  return `<button type="button" class="cc-day-head" data-action="central-calendar-open-day" data-date="${escapeAttr(date)}" aria-label="${escapeAttr(`Open ${label}`)}">${inner}</button>`;
}

// Week as columns (medium and wide): the server's order inside each day. A wide column shows the
// short type line (centralCalendarShortKindLabel).
function renderWeekColumnsHtml(days, byDate, cal, teams, today, layout = "") {
  const columns = days.map((date) => {
    const items = centralCalendarVisibleItems(byDate.get(date), cal.filters);
    return `<section class="cc-day-column${date === today ? " is-today" : ""}" aria-label="${escapeAttr(centralCalendarLongDate(date))}">
        ${dayHeadHtml(date, today, items.length)}
        ${items.length || !gpsMarkFor(cal, date) ? `<div class="cc-day-cards">${renderDayCardsHtml(items, teams, cal.panel.key, today, { shortKind: layout === "wide" })}</div>` : ""}
        ${renderGpsMarkHtml(cal, date)}
      </section>`;
  });
  return `<div class="cc-week" role="group" aria-label="Week of ${escapeAttr(shortDate(days[0], { year: true }))}">${columns.join("")}</div>`;
}

// K7 (docs/ai/central-calendar-k7-timegrid-contract.md 2.1): a multi-day event's card per day (span.from < span.to)
// is never timed: it goes in the band, on each of its days.
function isMultiDay(item) {
  return Boolean(item?.span?.from && item?.span?.to && item.span.from < item.span.to);
}

// The timed part of a day: an item with a start time that is not a multi-day event's day.
function timedEntryOf(item) {
  if (isMultiDay(item)) return null;
  const start = centralCalendarMinutesOf(item.startTime);
  if (start == null) return null;
  return { item, start, end: centralCalendarMinutesOf(item.endTime), minor: centralCalendarIsDayChip(item) };
}

// The band "No set time" (2.4), per day in this order: multi-day events, cards without a start time, chips without
// one. At most BAND_ITEMS, then "+N more".
const BAND_ITEMS = 3;
function bandItemsOf(items) {
  const untimed = items.filter((item) => !timedEntryOf(item));
  const multi = untimed.filter((item) => isMultiDay(item));
  const rest = untimed.filter((item) => !isMultiDay(item));
  return [...multi, ...rest.filter((item) => !centralCalendarIsDayChip(item)), ...rest.filter((item) => centralCalendarIsDayChip(item))];
}

// "+N more" (2.3): opens the day as the Day view's list, where every item of the day is listed in the server's order.
function renderTimeGridMoreHtml(date, count, { from = "", pair = null } = {}) {
  const title = pair ? `2 overlapping events: ${pair.map(centralCalendarTitle).join(", ")}` : `${count} more item${count === 1 ? "" : "s"}`;
  const label = `${title}, ${centralCalendarLongDate(date)}${from ? `, from ${from}` : ""}: open the day`;
  const contents = pair
    ? `<span class="cc-tg-pair-icons" aria-hidden="true">${pair.map((item) => itemIconHtml(item, "cc-tg-pair-icon", 14)).join("")}</span><span class="cc-tg-pair-count" aria-hidden="true">2</span>`
    : `+${count}<span class="cc-tg-more-word"> more</span>`;
  // In a narrow column only "+3" shows (a container query); the label keeps the whole sentence.
  return `<button type="button" class="cc-tg-more${pair ? " cc-tg-more-pair" : ""}" data-action="central-calendar-open-day" data-day-list="1" data-date="${escapeAttr(date)}" aria-label="${escapeAttr(label)}">${contents}</button>`;
}

const clockOf = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// One positioned box of a day column (2.2, section 4): top and height from the grid's start in minutes, left and width
// as fractions of the column.
function boxStyle({ top, height, column, columns, span = 1 }) {
  return `--cc-tg-top:${top};--cc-tg-height:${height};--cc-tg-left:${column / columns};--cc-tg-width:${span / columns}`;
}

// The time grid (K7): the week on wide (Time grid), or one day (the Day view on wide with Time grid). The heads, the
// band and the day columns; each column is a list of its items laid out by centralCalendarTimeLayout, day by day in
// reading order (section 5).
function renderTimeGridHtml(days, byDate, cal, teams, today, { dayView = false, phone = false } = {}) {
  const openKey = cal.panel.key;
  const visible = new Map(days.map((date) => [date, centralCalendarVisibleItems(byDate.get(date), cal.filters)]));
  const entriesByDay = new Map(days.map((date) => [date, visible.get(date).map(timedEntryOf).filter(Boolean)]));
  const { startHour, endHour } = centralCalendarGridHours([...entriesByDay.values()].flat(), { startHour: DAY_GRID_START_HOUR, endHour: DAY_GRID_END_HOUR + 1 });
  const hours = endHour - startHour;
  const heads = days.map((date) => `<div class="cc-timegrid-head${date === today ? " is-today" : ""}">${dayHeadHtml(date, today, visible.get(date).length)}</div>`).join("");
  const band = days.map((date) => {
    // 2.4: the band's entries in order, K5-4's GPS mark last; more than BAND_ITEMS show BAND_ITEMS and "+N more".
    const entries = bandItemsOf(visible.get(date)).map((item) => (phone && !dayView
      ? renderMiniCardHtml(item, teams, openKey, today, { mobileTimeline: true })
      : isMultiDay(item)
      ? renderCentralCalendarCardHtml(item, { teams, openKey, today, spanWhen: true })
      : renderDayItemHtml(item, teams, openKey, today)));
    const mark = renderGpsMarkHtml(cal, date);
    if (mark) entries.push(mark);
    const shown = entries.length > BAND_ITEMS ? entries.slice(0, BAND_ITEMS) : entries;
    const more = entries.length > shown.length ? renderTimeGridMoreHtml(date, entries.length - shown.length) : "";
    return `<div class="cc-timegrid-cell cc-timegrid-untimed${date === today ? " is-today" : ""}">${shown.join("")}${more}</div>`;
  }).join("");
  const gutter = Array.from({ length: hours }, (_, index) => `<span class="cc-tg-hour" style="--cc-tg-top:${index * 60}">${String(startHour + index).padStart(2, "0")}:00</span>`).join("");
  const columns = days.map((date) => {
    const maxColumns = phone ? (dayView ? 3 : 1) : (dayView ? 6 : 3);
    const { placed, more } = centralCalendarTimeLayout(entriesByDay.get(date), { startHour, maxColumns });
    const count = visible.get(date).length;
    let html = "";
    let next = 0;
    const moreHtml = (block) => `<div class="cc-tg-box cc-tg-box-more" role="listitem" style="${boxStyle(block)}">${renderTimeGridMoreHtml(date, block.items.length, {
      from: clockOf(block.top + startHour * 60), pair: phone && !dayView && block.items.length === 2 ? block.items : null,
    })}</div>`;
    placed.forEach((box, index) => {
      const classes = ["cc-tg-box"];
      if (box.openEnd) classes.push("is-open-end");
      if (box.minor) classes.push("is-chip");
      if (box.span < box.columns) classes.push("is-narrow");
      // Under 45 minutes high the time and title share one line (2.1: "10:00 Title").
      if (box.height < 45) classes.push("is-short");
      // H4: 45 to 59 minutes high holds two lines (the time, then the title with the marks at its end).
      else if (box.height < 60) classes.push("is-two-line");
      // H4: 75 minutes or more holds a third line (the marks under the title in a box too narrow for both on one).
      else if (box.height >= 75) classes.push("is-tall");
      // 2.2.5: a narrow card keeps its stripe and its start first (the end hides only when the box itself is narrow,
      // a container query); the whole time and title in its tooltip and label.
      const inner = box.minor ? renderDayChipHtml(box.item, teams, openKey, today) : renderCentralCalendarCardHtml(box.item, { teams, openKey, today, gridBox: true });
      html += `<div class="${classes.join(" ")}" role="listitem" style="${boxStyle(box)}">${inner}</div>`;
      while (next < more.length && more[next].after === index + 1) html += moreHtml(more[next++]);
    });
    while (next < more.length) html += moreHtml(more[next++]);
    return `<div class="cc-tg-col${date === today ? " is-today" : ""}" role="list" aria-label="${escapeAttr(`${centralCalendarLongDate(date)}, ${count} item${count === 1 ? "" : "s"}`)}">${html}</div>`;
  }).join("");
  const label = dayView ? `${centralCalendarLongDate(days[0])}, by hour` : `Week of ${shortDate(days[0], { year: true })}, by hour`;
  return `<div class="cc-timegrid${dayView ? " cc-timegrid-day" : ""}" role="group" aria-label="${escapeAttr(label)}">
      <div class="cc-timegrid-row cc-timegrid-heads"><span class="cc-timegrid-hour" aria-hidden="true"></span>${heads}</div>
      <div class="cc-timegrid-row cc-timegrid-untimed-row"><span class="cc-timegrid-hour">No set time</span>${band}</div>
      <div class="cc-timegrid-row cc-timegrid-body" style="--cc-tg-hours:${hours}"><div class="cc-tg-gutter" aria-hidden="true">${gutter}</div>${columns}</div>
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
        return `<button type="button" class="cc-strip-day${isSelected ? " is-selected" : ""}${date === today ? " is-today" : ""}" data-action="central-calendar-select-day" data-date="${escapeAttr(date)}" aria-pressed="${isSelected ? "true" : "false"}"${date === today ? ' aria-current="date"' : ""} aria-label="${escapeAttr(`${centralCalendarLongDate(date)}${date === today ? ", today" : ""}${count ? `, ${count} item${count === 1 ? "" : "s"}` : ""}${names ? `, ${names}` : ""}${gpsMarkLabel(cal, date)}`)}">
          <span class="cc-strip-name">${escapeHtml(weekdayShort(date))}</span>
          <span class="cc-strip-number">${dayNumber(date)}</span>
          ${count ? `<span class="cc-strip-count" aria-hidden="true">${count}</span>` : ""}
          ${gpsMarkSignHtml(cal, date)}
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
        return `<li class="cc-team-pill${count ? "" : " is-empty"}"${teamColorStyle(team.teamId, teams)}><span class="cc-team-dot" aria-hidden="true"></span><span class="cc-team-pill-name">${escapeHtml(`${centralCalendarTeamLabel(team)} · ${count} item${count === 1 ? "" : "s"}`)}</span></li>`;
      }).join("")}
    </ul>`;
}

// The cards with a time or a slot, then the ones with neither under "No time"
// (K2a-2): the untimed cards move from the server's place for them (first)
// to the end; each part keeps the server's order (plan section 8).
function renderDayListCardsHtml(items, teams, openKey, today, emptyText, emptyAction = "") {
  if (!items.length) return `<div class="cc-day-cards">${renderDayCardsHtml(items, teams, openKey, today, { emptyText, emptyAction })}</div>`;
  // K5-2 (E4): the "No time" split is the cards'; the chips follow them all.
  const cards = items.filter((item) => !centralCalendarIsDayChip(item));
  const chips = items.filter((item) => centralCalendarIsDayChip(item));
  const untimed = cards.filter((item) => !item.startTime && !item.slot);
  const timed = cards.filter((item) => item.startTime || item.slot);
  return `${timed.length ? `<div class="cc-day-cards">${renderDayCardsHtml(timed, teams, openKey, today)}</div>` : ""}
      ${untimed.length ? `<h5 class="cc-day-section">No time</h5><div class="cc-day-cards cc-day-cards-untimed">${renderDayCardsHtml(untimed, teams, openKey, today)}</div>` : ""}
      ${chips.length ? `<div class="cc-day-cards">${renderDayCardsHtml(chips, teams, openKey, today)}</div>` : ""}`;
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
      ${items.length || !gpsMarkFor(cal, date) ? renderDayListCardsHtml(items, teams, cal.panel.key, today, emptyText, emptyAction) : ""}
      ${renderGpsMarkHtml(cal, date)}
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
      const phoneLabel = `${label}${gpsMarkLabel(cal, date)}`;
      return `<button type="button" class="${classes.join(" ")}" data-action="central-calendar-select-day" data-date="${escapeAttr(date)}" aria-pressed="${date === selected ? "true" : "false"}"${date === today ? ' aria-current="date"' : ""} aria-label="${escapeAttr(phoneLabel)}">
          <span class="cc-month-number">${dayNumber(date)}</span>
          ${items.length ? `<span class="cc-month-count" aria-hidden="true">${items.length}</span>` : ""}
          ${gpsMarkSignHtml(cal, date)}
        </button>`;
    }
    const shown = items.slice(0, MONTH_CELL_CARDS);
    const more = items.length - shown.length;
    return `<div class="${classes.join(" ")}">
        <button type="button" class="cc-month-number" data-action="central-calendar-open-day" data-date="${escapeAttr(date)}"${date === today ? ' aria-current="date"' : ""} aria-label="${escapeAttr(`Open ${label}`)}">${dayNumber(date)}</button>
        <div class="cc-month-cards">
          ${shown.map((item) => renderMiniCardHtml(item, teams, cal.panel.key, today)).join("")}
          ${renderGpsMarkHtml(cal, date, { mini: true })}
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

// The Day view's time grid (K7, Q1): wide, the switch on Time grid, and not the list "+N more" opened.
export function centralCalendarDayGridShown(cal, layout) {
  return cal.view === "day" && (layout === "wide" || layout === "phone") && cal.weekMode === "grid" && !cal.dayList;
}

function renderBodyHtml(cal, layout, today) {
  if (!cal.data) return renderStateHtml(cal);
  const teams = cal.data.teams || [];
  const shownData = centralCalendarShownData(cal);
  // K6 (contract 2.5): an athlete is chosen and her own read is not here yet (or failed): the loading state or the
  // error with Try again, never the unfiltered answer's cards under "Showing Ana".
  if (!shownData) {
    if (cal.switcher?.status === "error") {
      return `<div class="cc-state cc-state-error" role="alert"><p class="cc-state-text">The calendar of this athlete could not be read.</p><button type="button" class="plain-button cc-retry" data-action="central-calendar-retry">Try again</button></div>`;
    }
    return `<p class="cc-state cc-state-loading" role="status">Loading calendar…</p>`;
  }
  const byDate = centralCalendarItemsByDate(shownData);
  const days = centralCalendarDisplayedDays(cal.view, cal.anchor);
  // A GPS mark (K5-4) is something to show too: a week or month with one never reads as empty.
  const anyVisible = days.some((date) => centralCalendarVisibleItems(byDate.get(date), cal.filters).length > 0 || Boolean(gpsMarkFor(cal, date)));
  const scope = cal.view === "month" ? "this month" : cal.view === "day" ? "on this day" : "this week";
  // A month with nothing to show says so once: a phone then skips the
  // selected day's own "Nothing on this day." under the grid.
  if (cal.view === "month") return renderMonthHtml(days, byDate, cal, teams, today, layout, { dayList: anyVisible }) + (anyVisible ? "" : renderEmptyHtml(cal, scope));
  if (cal.view === "day") {
    // K7 (Q1): on wide, the Day view is a time grid too when the switch says Time grid, unless "+N more" asked for
    // the day's list (cal.dayList).
    if (centralCalendarDayGridShown(cal, layout)) return renderTimeGridHtml([days[0]], byDate, cal, teams, today, { dayView: true, phone: layout === "phone" }) + (anyVisible ? "" : renderEmptyHtml(cal, scope));
    return renderSelectedDayListHtml(days[0], byDate, cal, teams, today, { heading: false });
  }
  if (layout === "phone" && cal.weekMode !== "grid") {
    const selected = days.includes(cal.selectedDate) ? cal.selectedDate : days[0];
    return renderStripHtml(days, byDate, cal, today, teams) + renderSelectedDayListHtml(selected, byDate, cal, teams, today);
  }
  const grid = (layout === "wide" || layout === "phone") && cal.weekMode === "grid";
  return (grid ? renderTimeGridHtml(days, byDate, cal, teams, today, { phone: layout === "phone" }) : renderWeekColumnsHtml(days, byDate, cal, teams, today, layout)) + (anyVisible ? "" : renderEmptyHtml(cal, scope));
}

// `roster` maps an athlete UUID to the rail roster's athlete_id, the id the
// weekly plan's route reads (central-calendar-actions.js
// centralCalendarRosterIndex). An athlete outside it has no drill-in here.
// `headless`: an event's list sits in its collapsible Athletes section, whose header names it and its count.
function renderPanelAthletesHtml(item, cal, roster, { headless = false } = {}) {
  const panel = cal.panel;
  const count = Number(item.athleteCount) || 0;
  // An imported activity's athletes are its recorded participants; who
  // still needs an attendance state is the Roster tab's knowledge (K1a
  // gives no per-athlete roster state), so the head says what the list is.
  const recorded = item.kind === "activity" && Boolean(item.attendance);
  const head = headless ? "" : `<h4 class="cc-panel-subtitle">${recorded ? "Recorded athletes" : "Athletes"}${count ? ` (${count})` : ""}</h4>`;
  if (panel.loading) return `${head}<p class="cc-panel-note" role="status">Loading athletes…</p>`;
  if (panel.error === "changed") return `${head}<p class="cc-panel-note">This item has changed since the calendar was loaded.</p><button type="button" class="plain-button cc-panel-button" data-action="central-calendar-retry">Refresh the calendar</button>`;
  if (panel.error) return `${head}<p class="cc-panel-note">Athlete names could not be loaded.</p><button type="button" class="plain-button cc-panel-button" data-action="central-calendar-retry-athletes">Try again</button>`;
  // The event panel package: a manager's event panel shows each athlete's
  // values and the summary (a UI rule, not an access rule: section 2 of
  // docs/ai/central-calendar-event-panel-contract.md). A reader's panel keeps
  // its states only.
  const manager = ccAnswersWanted(item);
  const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));
  // A manager's athletes no longer targeted come after the others, marked.
  const athletes = manager
    ? [...(panel.athletes || [])].sort((a, b) => (a.targeted === false) - (b.targeted === false) || byName(a, b))
    : [...(panel.athletes || [])].sort(byName);
  if (!athletes.length) return `${head}<p class="cc-panel-note">${count ? "No athlete names were returned." : "No athletes on this item."}</p>`;
  const teams = cal.data?.teams || [];
  // K5-1: the Roster button above the list says who still needs a state; without an activity id there is none.
  const rosterNote = recorded && item.attendance.needsState > 0 && !(item.links?.activityIds || []).length
    ? `<p class="cc-panel-note">Who still needs an attendance state is on the activity's Roster tab in Training Load.</p>`
    : "";
  const answersView = manager && cal.panelAnswers && cal.panelAnswers.panel === panel && cal.panelAnswers.key === item.key ? cal.panelAnswers : null;
  const entries = answersView?.weekly ? ccAnswerEntries(item, answersView.weekly) : null;
  const questionsRead = cal.panelQuestions && cal.panelQuestions.key === item.key ? cal.panelQuestions.read : null;
  let summaryHtml = "";
  if (manager) {
    // A panel with nothing that can carry a value reads nothing: its summary
    // (if anybody is counted) comes from the card's states alone.
    const reads = ccAnswersReadable(item);
    if (reads && (!answersView || answersView.loading)) summaryHtml = `<p class="cc-panel-note cc-answers-summary" role="status">Loading answers…</p>`;
    else if (reads && answersView.error) summaryHtml = `<p class="cc-panel-note cc-answers-summary" role="status">Answers could not be loaded.</p><button type="button" class="plain-button cc-panel-button" data-action="central-calendar-answers-retry">Try again</button>`;
    else {
      const summary = ccAnswersSummary(athletes, entries);
      const parts = ccAnswersSummaryParts(summary);
      // A line breaks only at "·" (each part stays whole); the spoken label says "2 of 12".
      if (parts.length) summaryHtml = `<p class="cc-answers-summary" role="status" aria-label="${escapeAttr(ccAnswersSummarySpoken(summary))}">${parts.map((part) => `<span class="cc-answers-part">${escapeHtml(part)}</span>`).join(` <span aria-hidden="true">·</span> `)}</p>`;
    }
  }
  return `${head}${summaryHtml}<ul class="cc-athletes" role="list">
      ${athletes.map((athlete) => {
        const stateLabel = athleteStateLabel(athlete);
        const answerText = entries ? ccAthleteAnswerText(entries.get(String(athlete.athleteId))) : "";
        const changedText = manager && answerText ? ccChangedText(ccChangedAtOf(questionsRead, athlete.athleteId)) : "";
        const excluded = manager && athlete.targeted === false;
        const names = (athlete.teamIds || []).map((id) => teamName(id, teams)).join(", ");
        const stateHtml = answerText
          ? `<span class="cc-athlete-state cc-athlete-values cc-athlete-state-${escapeAttr(athlete.rpe || "none")}">${escapeHtml(answerText)}</span>`
          : stateLabel ? `<span class="cc-athlete-state cc-athlete-state-${escapeAttr(athlete.rpe || athlete.result || "none")}">${escapeHtml(stateLabel)}</span>` : "";
        const side = `<span class="cc-athlete-side">${names ? `<span class="cc-athlete-teams">${escapeHtml(names)}</span>` : ""}${stateHtml}${changedText ? `<span class="cc-athlete-changed">${escapeHtml(changedText)}</span>` : ""}${excluded ? `<span class="cc-athlete-note">No longer in this event</span>` : ""}`;
        if (!roster?.has(String(athlete.athleteId))) {
          return `<li><div class="cc-athlete cc-athlete-static">
            <span class="cc-athlete-name">${escapeHtml(athlete.name || "Athlete")}</span>
            ${side}<span class="cc-athlete-note">Not in this workspace's roster</span></span>
          </div></li>`;
        }
        // A reader's row is exactly today's (contract section 2, Q6); a manager's
        // names its values in the label and shows where it leads.
        const spoken = manager
          ? [athlete.name || "Athlete", ccSpokenAnswerText(answerText || stateLabel), changedText, excluded ? "no longer in this event" : "", `open the weekly plan on ${centralCalendarLongDate(item.date)}`].filter(Boolean).join(", ")
          : `${athlete.name || "Athlete"}, open the weekly plan on ${centralCalendarLongDate(item.date)}`;
        return `<li><button type="button" class="cc-athlete" data-action="central-calendar-open-athlete" data-athlete-list="panel" data-athlete-id="${escapeAttr(athlete.athleteId)}" data-date="${escapeAttr(item.date)}" aria-label="${escapeAttr(spoken)}">
            <span class="cc-athlete-name">${escapeHtml(athlete.name || "Athlete")}</span>
            ${side}</span>${manager ? `
            <span class="cc-athlete-go" aria-hidden="true">Weekly plan ›</span>` : ""}
          </button></li>`;
      }).join("")}
    </ul>${rosterNote}${centralCalendarChosenAthlete(cal) ? `<p class="cc-panel-note">Showing only the chosen athlete. <button type="button" class="plain-button cc-inline-button" data-action="central-calendar-show-everyone">Show everyone</button></p>` : ""}`;
}

function panelItemOf(cal) {
  if (!cal.panel.open || !cal.data) return null;
  return centralCalendarItemsByDate(centralCalendarShownData(cal)).get(cal.panel.date)?.find((entry) => entry.key === cal.panel.key) || null;
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
// `askRpe` (K2b-2a-2b, contract 4.4): the club's switch is on and the coach
// manages the event - the RPE gap names the panel's next step.
function renderEventFactsHtml(item, { askRpe = false } = {}) {
  const expects = item.expects || [];
  const gaps = (item.gaps || []).map((gap) => (gap === "rpe" && askRpe ? `${GAP_NOTES.rpe} Use Ask RPE under Questions and RPE.` : GAP_NOTES[gap])).filter(Boolean);
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
function renderEventActionsHtml(item, { locked = false } = {}) {
  if (item.kind !== "event" || item.canManage !== true || item.cancelled) return "";
  const off = locked ? " disabled" : "";
  return `<div class="cc-panel-actions">
      <button type="button" class="plain-button cc-panel-button" data-action="central-calendar-edit-event" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}"${off}>Edit</button>
      <button type="button" class="plain-button cc-panel-button cc-danger-outline" data-action="central-calendar-cancel-event" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}"${off}>Cancel event</button>
    </div>`;
}

// v93 (docs/runbooks/calendar-event-delete-v93.md): Delete, for a manager, only when the event holds nothing - a
// planned event by its manager read (`deletable`, read under the same rules the database applies), a cancelled one
// (no manager read) by its card's schedules; the server decides again under the event's lock, and a refusal hides
// the button. A first press shows the step that names the event; only its second button sends. A cancelled event
// has no links section, so its Delete's unconfirmed result is shown here.
export function centralCalendarDeleteOffered(item, cal) {
  if (item?.kind !== "event" || item.canManage !== true) return false;
  if (cal.linkRefused?.has?.(centralCalendarDeleteRefusedKey(item.eventId))) return false;
  if (item.cancelled) return !item.links?.externalScheduleId && !item.links?.testScheduleId;
  const view = cal.panelEvent && cal.panelEvent.key === item.key ? cal.panelEvent : null;
  return Boolean(view && !view.loading && !view.error && view.event?.deletable === true);
}
function renderEventDeleteHtml(item, cal, pending, { locked = false } = {}) {
  if (item.kind !== "event" || item.canManage !== true) return "";
  const own = pending && pending.act === "delete-event" ? pending : null;
  const feedback = item.cancelled ? linkFeedbackHtml(cal, item.key, own) : "";
  if (!centralCalendarDeleteOffered(item, cal)) return feedback ? `<div class="cc-panel-delete">${feedback}</div>` : "";
  const busy = busyOn(cal, "delete-event", "eventKey", item.key);
  const off = locked || Boolean(pending) || busy;
  const step = cal.deleteStep && cal.deleteStep.eventKey === item.key && cal.deleteStep.revision === item.revision ? cal.deleteStep : null;
  if (!step) {
    return `<div class="cc-panel-delete">${feedback}<button type="button" class="plain-button cc-panel-button cc-danger-outline" data-action="central-calendar-delete-open" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}"${off ? " disabled" : ""}>Delete event</button></div>`;
  }
  return `<div class="cc-panel-delete cc-panel-delete-step" role="group" aria-labelledby="ccDeleteQuestion">${feedback}
      <p class="cc-panel-note" id="ccDeleteQuestion" role="status">${escapeHtml(centralCalendarDeleteEventQuestion(item))}</p>
      <div class="cc-link-align-buttons">${linkButtonHtml({ act: "delete-event", label: "Delete event", attrs: `data-event-key="${escapeAttr(item.key)}"`, busy, off, extraClass: "cc-danger" })}
      <button type="button" class="plain-button cc-panel-button cc-link-button" data-action="central-calendar-delete-keep"${busy ? " disabled" : ""}>Keep</button></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// K2c-1 (docs/ai/central-calendar-k2c-plan.md 1.1): the links of an event, in
// its panel and in a planned card's panel. `pending` is this panel's link
// command whose result is not confirmed (the actions module's memory), and
// `cal.linkWrite` the one in flight: while either exists every button here,
// and the event's Edit / Cancel, is off (one control at a time).
// ---------------------------------------------------------------------------
function linkButtonHtml({ act, label, attrs = "", busy = false, off = false, primary = false, aria = "", extraClass = "" }) {
  // The calendar's primary look is `plain-button cc-primary` (the app has no base .primary-button rule).
  const cls = `plain-button${primary ? " cc-primary" : ""} cc-panel-button cc-link-button${extraClass ? ` ${extraClass}` : ""}`;
  return `<button type="button" class="${cls}" data-action="central-calendar-link" data-act="${escapeAttr(act)}" ${attrs}${aria ? ` aria-label="${escapeAttr(aria)}"` : ""}${off ? " disabled" : ""}>${escapeHtml(busy ? centralCalendarLinkBusyWord(act) : label)}</button>`;
}

// One row: the name, its quiet line, a refused pair's short reason under it,
// and the row's button (none for a refused pair).
function linkRowHtml(title, meta, button, refusedReason = "") {
  return `<li class="cc-link-row"><div class="cc-link-text"><p class="cc-link-name">${escapeHtml(title)}</p>${meta ? `<p class="cc-link-meta">${escapeHtml(meta)}</p>` : ""}${refusedReason ? `<p class="cc-link-refused">${escapeHtml(refusedReason)}</p>` : ""}</div>${refusedReason ? "" : button}</li>`;
}

function linkFeedbackHtml(cal, panelKey, pending, family = "link") {
  const message = cal.linkMessage && cal.linkMessage.panelKey === panelKey && (cal.linkMessage.family || "link") === family ? cal.linkMessage : null;
  const messageHtml = message ? `<p class="cc-panel-note cc-link-message" role="${message.alert ? "alert" : "status"}" tabindex="-1">${escapeHtml(message.text)}</p>` : "";
  if (!pending) return messageHtml;
  const checking = cal.linkWrite?.check === true;
  return `<div class="cc-link-unconfirmed" role="status"><p class="cc-panel-note">The result is not confirmed.</p>${messageHtml}
      <button type="button" class="plain-button cc-panel-button cc-link-wrap" data-action="central-calendar-link-check" data-request-key="${escapeAttr(pending.requestKey)}"${checking ? " disabled" : ""}>${checking ? "Checking…" : "Check result"}</button></div>`;
}

function busyOn(cal, act, attr, value) {
  const write = cal.linkWrite;
  return Boolean(write && !write.check && write.act === act && String(write[attr] ?? "") === String(value ?? ""));
}

// The Align row (review M3, M6): always drawn while the card counts sessions
// that do not follow the event, its buttons off during another write; a first
// press shows the step in the same row and only its second button sends; the
// server's has_existing_results asks its own question there.
function renderAlignHtml(item, cal, off) {
  const align = centralCalendarAlignLine(item);
  if (!align) return "";
  const blocked = cal.alignBlocked && cal.alignBlocked.eventId === item.eventId && cal.alignBlocked.revision === item.revision;
  if (blocked) return `<div class="cc-link-align"><p class="cc-panel-note">${escapeHtml(CENTRAL_CALENDAR_ALIGN_NOT_ALLOWED)}</p></div>`;
  // A step belongs to the event as it was when it opened (review LOW): a
  // re-read that moved the revision or what the event collects drops it.
  const step = cal.alignStep && cal.alignStep.eventKey === item.key && cal.alignStep.revision === item.revision
    && cal.alignStep.expects === (item.expects || []).join(",") ? cal.alignStep : null;
  const busy = busyOn(cal, "align", "act", "align") || busyOn(cal, "align-confirm", "act", "align-confirm") || busyOn(cal, "align-results", "act", "align-results");
  if (step) {
    const question = step.stage === "results" ? centralCalendarResultsQuestion(step.resultCount) : align.step;
    const confirmAct = step.stage === "results" ? "align-results" : "align-confirm";
    const confirmLabel = step.stage === "results" ? "Stop asking" : align.confirm;
    return `<div class="cc-link-align cc-link-align-step"><p class="cc-panel-note" role="status">${escapeHtml(question)}</p>
        <div class="cc-link-align-buttons">${linkButtonHtml({ act: confirmAct, label: confirmLabel, busy, off: off || busy, primary: true })}
        <button type="button" class="plain-button cc-panel-button cc-link-button" data-action="central-calendar-align-cancel"${off || busy ? " disabled" : ""}>Not now</button></div></div>`;
  }
  return `<div class="cc-link-align"><p class="cc-panel-note">${escapeHtml(align.text)}</p>${linkButtonHtml({ act: "align", label: align.button, off, extraClass: "cc-link-wrap" })}</div>`;
}

// ---------------------------------------------------------------------------
// The event panel's layout (the owner's redesign of 2026-11-23): the head, one "In this event" summary row, then
// collapsible sections (Trainings, GPS and activities, Questions, Test, Athletes, Details) and the event's own acts
// at the bottom. Only the layout changes: every control below sends exactly what it sent before.
// `cal.panelView` ({ key, sections, menu }) is this panel's memory of what the coach opened or closed; a section
// nobody touched follows its default (open only while it asks for a decision).
// ---------------------------------------------------------------------------
const PANEL_SECTION_ICONS = Object.freeze({ trainings: "barbell", activities: "gps", questions: "clipboard", tests: "ruler-measure", athletes: "team", details: "notes" });

function panelViewOf(cal, item) {
  return cal.panelView && cal.panelView.key === item.key ? cal.panelView : null;
}

// `force`: the section holds a command's result, its Check result or an open step - it stays open whatever the coach
// chose earlier, so an unconfirmed outcome is never folded away.
function panelSectionOpen(cal, item, id, fallback, force = false) {
  if (force) return true;
  const chosen = panelViewOf(cal, item)?.sections?.[id];
  return typeof chosen === "boolean" ? chosen : Boolean(fallback);
}

// A collapsible section: its header is one button (aria-expanded / aria-controls) with the section's icon, name,
// count and an optional short fact; the body is in the markup only while it is open.
function panelSectionHtml(cal, item, { id, title, count = "", meta = "", open = false, force = false, body = "", className = "", busy = false }) {
  const expanded = panelSectionOpen(cal, item, id, open, force);
  const countHtml = count === "" ? "" : `<span class="cc-psec-count">${escapeHtml(String(count))}</span>`;
  const spoken = [title, count === "" ? "" : String(count), meta].filter(Boolean).join(", ");
  return `<section class="cc-psec${className ? ` ${className}` : ""}${expanded ? " is-open" : ""}" data-section="${escapeAttr(id)}"${busy ? ' aria-busy="true"' : ""}>
      <h4 class="cc-psec-title"><button type="button" class="cc-psec-toggle" data-action="central-calendar-panel-section" data-key="${escapeAttr(id)}" aria-expanded="${expanded ? "true" : "false"}" aria-controls="ccSec-${escapeAttr(id)}" aria-label="${escapeAttr(spoken)}">
        ${renderIconSvg(PANEL_SECTION_ICONS[id] || "list", { size: 18, className: "cc-psec-icon" })}<span class="cc-psec-name">${escapeHtml(title)}</span>${countHtml}${meta ? `<span class="cc-psec-meta">${escapeHtml(meta)}</span>` : ""}<span class="cc-psec-chevron" aria-hidden="true"></span>
      </button></h4>
      <div class="cc-psec-body" id="ccSec-${escapeAttr(id)}"${expanded ? "" : " hidden"}>${expanded ? body : ""}</div>
    </section>`;
}

// A linked row: its name and quiet line, and a "⋯" button whose small menu holds the row's Unlink (the same
// button, the same request, as before). The menu is in the markup only while it is open.
function linkedRowHtml(cal, item, { menuId, title, meta = "", button }) {
  const open = panelViewOf(cal, item)?.menu === menuId;
  const domId = `ccMenu-${menuId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return `<li class="cc-link-row cc-link-row-compact${open ? " is-menu-open" : ""}"><div class="cc-link-text"><p class="cc-link-name">${escapeHtml(title)}</p>${meta ? `<p class="cc-link-meta">${escapeHtml(meta)}</p>` : ""}</div>
      <button type="button" class="plain-button icon-button cc-row-more" data-action="central-calendar-row-menu" data-key="${escapeAttr(menuId)}" aria-expanded="${open ? "true" : "false"}"${open ? ` aria-controls="${escapeAttr(domId)}"` : ""} aria-label="${escapeAttr(`More for ${title}`)}"><span aria-hidden="true">⋯</span></button>
      ${open ? `<div class="cc-row-menu" id="${escapeAttr(domId)}" role="group" aria-label="${escapeAttr(title)}">${button}</div>` : ""}</li>`;
}

// An offer on this day: one compact row with its small Link (a refused pair keeps its reason, no button).
function offerRowHtml(title, meta, button, refusedReason = "") {
  return `<li class="cc-link-row cc-link-row-compact cc-link-offer"><div class="cc-link-text"><p class="cc-link-name">${escapeHtml(title)}</p>${meta ? `<p class="cc-link-meta">${escapeHtml(meta)}</p>` : ""}${refusedReason ? `<p class="cc-link-refused">${escapeHtml(refusedReason)}</p>` : ""}</div>${refusedReason ? "" : button}</li>`;
}

// The event's links split into its two sections. `otherPending`: a question command of this event not confirmed -
// it keeps these buttons off too (one control at a time), its Check result is drawn in the questions section.
function eventLinkParts(item, cal, pending, otherPending = null) {
  if (!centralCalendarEventLinkable(item)) return null;
  const busy = Boolean(cal.linkWrite);
  // An open question step holds the panel too (one control at a time).
  const off = busy || Boolean(pending) || Boolean(otherPending) || Boolean(cal.questionStep);
  const view = cal.panelEvent && cal.panelEvent.key === item.key ? cal.panelEvent : null;
  const suggestions = centralCalendarLinkSuggestions(cal.data, item, cal.linkRefused);
  const settled = Boolean(view && !view.loading && !view.error && view.event);
  const readState = !view || view.loading ? "loading" : settled ? "ok" : "error";
  const stateHtml = readState === "loading"
    ? `<p class="cc-panel-note" role="status">Loading linked trainings…</p>`
    : readState === "error" ? `<p class="cc-panel-note" role="alert">${escapeHtml(CENTRAL_CALENDAR_LINKS_LOAD_FAILED)}</p>${view.retry === false ? "" : `<button type="button" class="plain-button cc-panel-button" data-action="central-calendar-details-retry">Try again</button>`}` : "";
  // 1. Trainings: the linked ones, Align, then the day's offers.
  const t = [];
  let linkedTrainings = 0;
  if (settled) {
    const { groups, orphaned, orphanedCount } = centralCalendarSessionLinkGroups(view.event, item.date);
    linkedTrainings = groups.length + orphaned.length;
    const rows = groups.map((group) => {
      const name = group.name || "Training";
      const meta = [centralCalendarWhenLabel({ slot: group.slot }), athleteCountLabel(group.athleteCount), group.renamedFrom ? `was “${group.renamedFrom}”` : ""].filter(Boolean).join(" · ");
      return linkedRowHtml(cal, item, { menuId: `session:${group.key}`, title: name, meta, button: linkButtonHtml({ act: "unlink-sessions", label: "Unlink", attrs: `data-group="${escapeAttr(group.key)}"`, busy: busyOn(cal, "unlink-sessions", "group", group.key), off, aria: `Unlink ${name}` }) });
    });
    if (orphaned.length) {
      rows.push(linkedRowHtml(cal, item, { menuId: "session:orphaned", title: centralCalendarOrphanedLine(orphanedCount), meta: CENTRAL_CALENDAR_ORPHANED_META, button: linkButtonHtml({ act: "unlink-sessions", label: "Unlink", attrs: `data-group="orphaned"`, busy: busyOn(cal, "unlink-sessions", "group", "orphaned"), off, aria: "Unlink the deleted trainings" }) }));
    }
    if (rows.length) t.push(`<h5 class="cc-link-heading">Linked</h5><ul class="cc-link-list" role="list">${rows.join("")}</ul>`);
  }
  const alignHtml = renderAlignHtml(item, cal, off);
  if (alignHtml) t.push(alignHtml);
  if (suggestions.trainings.length) {
    const rows = suggestions.trainings.map(({ item: planned, refused }) => {
      const title = centralCalendarTitle(planned);
      const meta = [centralCalendarWhenLabel(planned), athleteCountLabel(Number(planned.athleteCount) || 0)].filter(Boolean).join(" · ");
      return offerRowHtml(title, meta, linkButtonHtml({ act: "link-session", label: "Link", attrs: `data-planned-key="${escapeAttr(planned.key)}"`, busy: busyOn(cal, "link-session", "plannedKey", planned.key), off, aria: `Link ${title}` }), refused);
    });
    t.push(`<h5 class="cc-link-heading">On this day, not linked</h5><ul class="cc-link-list" role="list">${rows.join("")}</ul>`);
  }
  const partial = centralCalendarPartialLine(suggestions.partial);
  if (partial) t.push(`<p class="cc-panel-note">${escapeHtml(partial)}</p>`);
  // 2. Activities: the linked ones, then the day's offers.
  const a = [];
  let linkedActivities = 0;
  if (settled) {
    const links = centralCalendarActivityLinksOf(view.event, item.date);
    linkedActivities = links.length;
    if (links.length) {
      const rows = links.map((link) => {
        const name = link.visible ? link.name || "Activity" : "An activity you cannot open here";
        return linkedRowHtml(cal, item, { menuId: `activity:${link.activityId}`, title: name, button: linkButtonHtml({ act: "unlink-activity", label: "Unlink", attrs: `data-activity-id="${escapeAttr(link.activityId)}"`, busy: busyOn(cal, "unlink-activity", "activityId", link.activityId), off, aria: `Unlink ${name}` }) });
      });
      a.push(`<h5 class="cc-link-heading">Linked</h5><ul class="cc-link-list" role="list">${rows.join("")}</ul>`);
    }
  }
  if (suggestions.activities.length) {
    const rows = suggestions.activities.map(({ item: activity, refused }) => {
      const title = centralCalendarTitle(activity);
      const meta = [centralCalendarWhenLabel(activity), centralCalendarKindLabel(activity)].filter(Boolean).join(" · ");
      return offerRowHtml(title, meta, linkButtonHtml({ act: "link-activity", label: "Link", attrs: `data-activity-key="${escapeAttr(activity.key)}"`, busy: busyOn(cal, "link-activity", "activityKey", activity.key), off, aria: `Link ${title}` }), refused);
    });
    a.push(`<h5 class="cc-link-heading">On this day, not linked</h5><ul class="cc-link-list" role="list">${rows.join("")}</ul>`);
  }
  const offersTrainings = suggestions.trainings.some((s) => !s.refused);
  const offersActivities = suggestions.activities.some((s) => !s.refused);
  const nothing = settled && !linkedTrainings && !linkedActivities && !suggestions.trainings.length && !suggestions.activities.length && !alignHtml;
  return {
    busy, readState, stateHtml, nothing,
    trainings: { count: settled ? linkedTrainings : "", parts: t, hint: linkedTrainings ? CENTRAL_CALENDAR_LINKED_HINT : "", offers: offersTrainings || Boolean(alignHtml) },
    activities: { count: settled ? linkedActivities : "", parts: a, offers: offersActivities },
  };
}

// `linkEntries`: every link command not confirmed in this workspace - an
// event with one waiting is not offered here until it is checked (review LOW).
function renderPlannedLinksHtml(item, cal, pending, linkEntries = []) {
  if (item.kind !== "planned") return "";
  const { events, partial } = centralCalendarEventsForPlanned(cal.data, item, cal.linkRefused);
  const feedback = linkFeedbackHtml(cal, item.key, pending);
  const partialHtml = partial.map((event) => `<p class="cc-panel-note">${escapeHtml(centralCalendarPlannedPartialLine(event))}</p>`).join("");
  if (!events.length) {
    if (!partialHtml && !feedback) return "";
    return `<section class="cc-panel-links" aria-labelledby="ccLinksTitle"><h4 class="cc-panel-subtitle" id="ccLinksTitle">Link to an event</h4>${feedback}${partialHtml}</section>`;
  }
  const busy = Boolean(cal.linkWrite);
  const off = busy || Boolean(pending);
  const waits = (event) => linkEntries.some((entry) => entry.eventId === event.eventId);
  const meta = (event) => [centralCalendarWhenLabel(event), eventKindWord(event)].filter(Boolean).join(" · ");
  let body;
  if (events.length === 1 && !events[0].refused) {
    const { item: event } = events[0];
    const title = centralCalendarTitle(event);
    body = `<div class="cc-link-one">${linkButtonHtml({ act: "link-to-event", label: `Link to “${title}”`, attrs: `data-event-key="${escapeAttr(event.key)}"`, busy: busyOn(cal, "link-to-event", "eventKey", event.key), off: off || waits(event), primary: true })}<p class="cc-link-meta">${escapeHtml(meta(event))}</p></div>`;
  } else {
    body = `<ul class="cc-link-list" role="list">${events.map(({ item: event, refused }) => {
      const title = centralCalendarTitle(event);
      const button = linkButtonHtml({ act: "link-to-event", label: "Link", attrs: `data-event-key="${escapeAttr(event.key)}"`, busy: busyOn(cal, "link-to-event", "eventKey", event.key), off: off || waits(event), aria: `Link to ${title}` });
      return linkRowHtml(title, meta(event), button, refused);
    }).join("")}</ul>`;
  }
  return `<section class="cc-panel-links" aria-labelledby="ccLinksTitle"${busy ? ' aria-busy="true"' : ""}><h4 class="cc-panel-subtitle" id="ccLinksTitle">Link to an event</h4>${feedback}${body}${partialHtml}</section>`;
}

// K5-3 (docs/ai/central-calendar-k5-plan.md, "Add to the event?"): a lone activity's or RPE request's panel asks
// whether to add it to a training or match of its day (central-calendar-links.js has the rule). One event: the
// question with [Add] and [Not now]; several: a row per event with its Add, then Not now. Never sent by itself; Not now
// sends nothing and hides the question for this card until the page is loaded again. A command of this panel whose
// result is not confirmed keeps its Check result here even after Not now (the owner's word, 2026-11-23).
function renderAddToEventHtml(item, cal, pending) {
  const what = centralCalendarAddToEventKind(item);
  if (!what) return "";
  const feedback = linkFeedbackHtml(cal, item.key, pending);
  const left = cal.addToEventLeft?.has?.(item.key) === true;
  const offers = left ? [] : centralCalendarAddToEventOffers(cal.data, item, cal.linkRefused);
  if (!offers.length) {
    if (!feedback) return "";
    return `<section class="cc-panel-links cc-add-event" aria-labelledby="ccLinksTitle"><h4 class="cc-panel-subtitle" id="ccLinksTitle" tabindex="-1">Add to an event</h4>${feedback}</section>`;
  }
  const busy = Boolean(cal.linkWrite);
  const off = busy || Boolean(pending);
  const act = what === "activity" ? "add-activity" : "add-rpe";
  const meta = (event) => [centralCalendarWhenLabel(event), eventKindWord(event)].filter(Boolean).join(" · ");
  const addable = offers.some((offer) => !offer.refused);
  const leave = `<button type="button" class="plain-button cc-panel-button cc-link-button" data-action="central-calendar-add-leave"${off ? " disabled" : ""}>${addable ? "Not now" : "Hide"}</button>`;
  let body;
  if (offers.length === 1 && !offers[0].refused) {
    const { item: event } = offers[0];
    body = `<p class="cc-add-question">${escapeHtml(centralCalendarAddToEventQuestion(event))}</p>
      <p class="cc-link-meta">${escapeHtml(meta(event))}</p>
      <div class="cc-add-buttons">${linkButtonHtml({ act, label: "Add", attrs: `data-event-key="${escapeAttr(event.key)}"`, busy: busyOn(cal, act, "eventKey", event.key), off, primary: true, aria: `Add to ${centralCalendarAddToEventName(event)}` })}${leave}</div>`;
  } else {
    body = `<p class="cc-add-question">${addable ? "Add to one of these events?" : escapeHtml(CENTRAL_CALENDAR_ADD_TO_EVENT_NONE)}</p><ul class="cc-link-list" role="list">${offers.map(({ item: event, refused }) => {
      const button = linkButtonHtml({ act, label: "Add", attrs: `data-event-key="${escapeAttr(event.key)}"`, busy: busyOn(cal, act, "eventKey", event.key), off, aria: `Add to ${centralCalendarAddToEventName(event)}` });
      return linkRowHtml(centralCalendarTitle(event), meta(event), button, refused);
    }).join("")}</ul><div class="cc-add-buttons">${leave}</div>`;
  }
  return `<section class="cc-panel-links cc-add-event" aria-labelledby="ccLinksTitle"${busy ? ' aria-busy="true"' : ""}>
      <h4 class="cc-panel-subtitle" id="ccLinksTitle" tabindex="-1">Add to an event</h4>
      ${feedback}${body}
      ${addable ? `<p class="cc-panel-note cc-link-hint">${escapeHtml(CENTRAL_CALENDAR_ADD_TO_EVENT_HINT[what])}</p>` : ""}
    </section>`;
}

// ---------------------------------------------------------------------------
// K5-1 (central-calendar-k5-12-contract.md 1.2): *Go there* - each panel's way to where its work is done. A button
// that leaves the calendar carries a trailing arrow (Q5); the openers record the calendar's place first, so Back
// returns to the same day with the same panel (K4-0). The Builder is not a target (Q1).
// ---------------------------------------------------------------------------
function goButtonHtml({ action, label, attrs = "", primary = false, aria = "" }) {
  return `<button type="button" class="plain-button${primary ? " cc-primary" : ""} cc-panel-button cc-go-button" data-action="${action}" ${attrs}${aria ? ` aria-label="${escapeAttr(aria)}"` : ""}>${escapeHtml(label)}</button>`;
}

function weekdayLong(iso) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(dateAtNoon(iso));
}

// The targets of one card, in the plan's order (RPE, Tests, then the activities); each with its button and a short
// line. The schedule ids are a manager's only (a reader's event card carries none), so a reader gets the activities.
export function centralCalendarGoTargets(item) {
  const links = item?.links || {};
  const date = item?.date || "";
  const targets = [];
  if ((item?.kind === "external" || item?.kind === "event") && links.externalScheduleId) {
    targets.push({
      key: "rpe", name: "RPE request", meta: item.kind === "event" && item.rpe ? `RPE ${item.rpe.submitted}/${item.rpe.asked}` : "",
      action: "central-calendar-open-rpe-schedule", label: "Open in Training Load",
      attrs: `data-schedule-id="${escapeAttr(links.externalScheduleId)}" data-date="${escapeAttr(date)}"`,
      hint: "Opens Training Load › Schedule on this RPE request.",
    });
  }
  if ((item?.kind === "test" || item?.kind === "event") && links.testScheduleId) {
    targets.push({
      key: "test", name: "Test", meta: item.kind === "event" && item.results ? `Results ${item.results.completed}/${item.results.expected}` : "",
      action: "central-calendar-open-tests", label: "Open in Tests",
      attrs: `data-schedule-id="${escapeAttr(links.testScheduleId)}" data-date="${escapeAttr(date)}"`,
      hint: `Opens Tests on ${weekdayLong(date)}, to see who has answered.`,
    });
  }
  const activityIds = links.activityIds || [];
  if (activityIds.length) {
    const thing = item.kind === "event" ? "event" : item.kind === "external" ? "RPE request" : "training";
    const one = activityIds.length === 1;
    targets.push({
      key: "activity",
      name: one ? (centralCalendarItemImported(item) ? "GPS data" : "Activity") : `${activityIds.length} activities`,
      meta: "",
      action: "central-calendar-open-training-load",
      label: one ? "Open in Training Load" : "Open the day in Training Load",
      attrs: `${one ? `data-activity-id="${escapeAttr(activityIds[0])}" ` : ""}data-date="${escapeAttr(date)}"`,
      hint: item.kind === "activity" ? "" : one ? `1 activity is recorded for this ${thing}.` : `${activityIds.length} activities are recorded for this ${thing}.`,
    });
  }
  return targets;
}

function renderGoThereHtml(item) {
  const targets = centralCalendarGoTargets(item);
  if (!targets.length) return "";
  // An event's targets live in its sections (renderEventPanelBodyHtml), each with its own button.
  // Any other panel: the first target full width and primary with its line; the rest after it (Q2).
  const needsState = item.kind === "activity" ? Number(item.attendance?.needsState) || 0 : 0;
  const activityId = (item.links?.activityIds || [])[0];
  const roster = needsState > 0 && activityId
    ? `<p class="cc-panel-note cc-go-warn">${escapeHtml(`${needsState} ${needsState === 1 ? "athlete needs" : "athletes need"} an attendance state.`)}</p>
      ${goButtonHtml({ action: "central-calendar-open-training-load", label: `Roster · ${needsState} need${needsState === 1 ? "s" : ""} a state`, attrs: `data-activity-id="${escapeAttr(activityId)}" data-date="${escapeAttr(item.date)}" data-tab="roster"` })}`
    : "";
  return `<section class="cc-go" aria-label="Go there">
      ${targets.map((target, index) => `${goButtonHtml({ ...target, primary: index === 0 })}${target.hint ? `<p class="cc-panel-note cc-go-hint">${escapeHtml(target.hint)}</p>` : ""}`).join("")}
      ${roster}
    </section>`;
}

// One target of an event (E2) inside its section: the name, its count, and its own button with one short line.
function goRowHtml(target) {
  return `<div class="cc-go cc-go-event"><ul class="cc-go-list" role="list"><li class="cc-go-row"><p class="cc-go-name">${escapeHtml(target.name)}${target.meta ? ` <span class="cc-go-meta">· ${escapeHtml(target.meta)}</span>` : ""}</p>${goButtonHtml({ ...target, aria: `${target.label}: ${target.name}` })}</li></ul>${target.hint ? `<p class="cc-panel-note cc-go-hint">${escapeHtml(target.hint)}</p>` : ""}</div>`;
}

// The answers' first fact ("Answered 2/12") for the folded Athletes header: a manager's event whose answers are read.
function athleteAnswersMeta(item, cal) {
  if (!ccAnswersWanted(item) || !ccAnswersReadable(item)) return "";
  const panel = cal.panel;
  const view = cal.panelAnswers && cal.panelAnswers.panel === panel && cal.panelAnswers.key === item.key ? cal.panelAnswers : null;
  if (!view || view.loading || view.error || !view.weekly || !Array.isArray(panel.athletes)) return "";
  return ccAnswersSummaryParts(ccAnswersSummary(panel.athletes, ccAnswerEntries(item, view.weekly)))[0] || "";
}

// The event's panel below its facts (the owner's redesign of 2026-11-23): the summary row, Plan / Open the training,
// the sections, See each athlete, Athletes, Details, then Edit · Cancel event · Delete together at the bottom.
function renderEventPanelBodyHtml(item, cal, { roster, pending, pendingQuestion, linksLocked, questionsOn, today, askRpe = false, compact = false }) {
  const targets = centralCalendarGoTargets(item);
  const target = (key) => targets.find((entry) => entry.key === key) || null;
  const links = eventLinkParts(item, cal, pending, pendingQuestion);
  const sections = [];
  // Trainings (a manager's: linked, Align, the day's offers).
  if (links) {
    const body = [links.readState === "ok" ? "" : links.stateHtml, ...links.trainings.parts,
      links.trainings.hint ? `<p class="cc-panel-note cc-link-hint">${escapeHtml(links.trainings.hint)}</p>` : "",
      links.nothing ? `<p class="cc-panel-note">${escapeHtml(CENTRAL_CALENDAR_LINK_EMPTY)}</p>` : ""].join("");
    const alignOpen = Boolean(cal.alignStep && cal.alignStep.eventKey === item.key);
    sections.push({ id: "trainings", title: "Trainings", count: links.trainings.count, open: links.readState === "error" || links.trainings.offers, force: alignOpen, body, busy: links.busy });
  }
  // GPS and activities: the card's activities (open them), then a manager's linked ones and the day's offers.
  const activity = target("activity");
  if (links || activity) {
    const linked = links && links.readState === "ok" ? links.activities.count : "";
    const count = activity ? Math.max(Number(linked) || 0, (item.links?.activityIds || []).length) : linked;
    const body = [activity ? goRowHtml(activity) : "", ...(links ? links.activities.parts : [])].join("")
      || `<p class="cc-panel-note">Nothing is recorded for this event yet.</p>`;
    sections.push({ id: "activities", title: "GPS and activities", count, open: Boolean(links?.activities.offers), body, busy: Boolean(links?.busy) });
  }
  // Questions and the event's RPE request.
  const rpe = target("rpe");
  if (questionsOn || rpe) {
    const pq = cal.panelQuestions && cal.panelQuestions.key === item.key ? cal.panelQuestions : null;
    const asked = pq && !pq.loading && !pq.error && !pq.hidden ? ccPanelQuestionList(pq.read).length : 0;
    const questionsHtml = questionsOn ? renderEventQuestionsHtml(item, cal, pendingQuestion, Boolean(pending), today) : "";
    const ownLine = cal.linkMessage?.family === "question" && cal.linkMessage.panelKey === item.key;
    const step = cal.questionStep && cal.questionStep.eventKey === item.key;
    const force = Boolean(pendingQuestion) || ownLine || step;
    const count = (rpe ? 1 : 0) + asked;
    // Open by default while the RPE gap's next step is Ask RPE here (askRpe), or after a failed read.
    sections.push({ id: "questions", title: "Questions and RPE", count: questionsOn && (!pq || pq.loading) && !rpe ? "" : count, meta: rpe?.meta || "", open: askRpe || Boolean(pq?.error), force, body: `${rpe ? goRowHtml(rpe) : ""}${questionsHtml}` || `<p class="cc-panel-note">No question is asked yet.</p>` });
  }
  // The event's test.
  const test = target("test");
  if (test) sections.push({ id: "tests", title: "Test", count: 1, meta: test.meta, open: false, body: goRowHtml(test) });
  const sectionHtml = (entry) => panelSectionHtml(cal, item, entry);
  const summary = sections.length ? `<div class="cc-panel-summary" role="group" aria-labelledby="ccSumTitle">
      <h4 class="cc-panel-subtitle" id="ccSumTitle">In this event</h4>
      <div class="cc-sum-chips">${sections.map((entry) => {
        const shown = entry.count === "" ? "…" : String(entry.count);
        const spoken = `${entry.title}: ${entry.count === "" ? "loading" : entry.count}${entry.meta ? `, ${entry.meta}` : ""}. Show`;
        const label = compact ? ({ trainings: "Training", activities: "GPS", questions: "RPE" }[entry.id] || entry.title) : entry.title;
        return `<button type="button" class="cc-sum-chip${entry.count === 0 ? " is-empty" : ""}" data-action="central-calendar-panel-reveal" data-key="${escapeAttr(entry.id)}" aria-label="${escapeAttr(spoken)}">${renderIconSvg(PANEL_SECTION_ICONS[entry.id] || "list", { size: 18, className: "cc-sum-icon" })}<span class="cc-sum-count">${escapeHtml(shown)}</span><span class="cc-sum-name">${escapeHtml(label)}</span></button>`;
      }).join("")}</div>
    </div>` : "";
  // The link sections share one status line (a write's result, its Check result), always in view.
  const linkIds = ["trainings", "activities"];
  const linkSections = sections.filter((entry) => linkIds.includes(entry.id));
  const linksHtml = links
    ? `<div class="cc-panel-links"${links.busy ? ' aria-busy="true"' : ""}><h4 class="visually-hidden" id="ccLinksTitle" tabindex="-1">Trainings and activities</h4>${linkFeedbackHtml(cal, item.key, pending)}${linkSections.map(sectionHtml).join("")}</div>`
    : linkSections.map(sectionHtml).join("");
  const others = sections.filter((entry) => !linkIds.includes(entry.id)).map(sectionHtml).join("");
  // Athletes and Details: folded, with their count.
  const count = Number(item.athleteCount) || 0;
  const athletes = panelSectionHtml(cal, item, {
    id: "athletes", title: "Athletes", count: count || (Array.isArray(cal.panel.athletes) ? cal.panel.athletes.length : ""), className: "cc-panel-athletes",
    meta: athleteAnswersMeta(item, cal), open: false, body: renderPanelAthletesHtml(item, cal, roster, { headless: true }),
  });
  const details = centralCalendarEventDetailsParts(item, cal.panelEvent);
  const detailsHtml = details ? panelSectionHtml(cal, item, {
    id: "details", title: "Details", count: details.count, meta: details.missing ? `${details.missing} required empty` : "", open: details.state === "error", body: details.body,
  }) : "";
  const actions = renderEventActionsHtml(item, { locked: linksLocked });
  const del = renderEventDeleteHtml(item, cal, pending, { locked: linksLocked || Boolean(cal.form) });
  return `${summary}
      ${renderK3PanelHtml(item, cal, { locked: linksLocked })}
      ${linksHtml}
      ${others}
      ${renderCentralCalendarSeeEachHtml(cal, item)}
      ${athletes}
      ${detailsHtml}
      ${actions || del ? `<div class="cc-panel-bottom">${actions}${del}</div>` : ""}`;
}

function panelHost(body, layout) {
  if (layout === "wide") return `<aside class="cc-panel" aria-labelledby="ccPanelTitle">${body}</aside>`;
  return `<button type="button" class="cc-sheet-backdrop" data-action="central-calendar-close-panel" aria-label="Close" tabindex="-1"></button>
    <aside class="cc-panel cc-sheet" role="dialog" aria-modal="true" aria-labelledby="ccPanelTitle">${body}</aside>`;
}

function renderPanelHtml(cal, layout, today, roster, formCtx, uncertainWrites = []) {
  // The event form takes the panel's place (K2a-2); the item's panel comes
  // back when the form closes.
  // K2c-3: below 1024 px the form is a sheet, so the Builder's band rides in it.
  if (cal.form) return panelHost(`${layout === "wide" ? "" : renderK2c3FormBandHtml(cal.form)}${renderCentralCalendarEventFormHtml(cal.form, { ...formCtx, longDate: centralCalendarLongDate, today })}`, layout);
  const panel = cal.panel;
  const item = panelItemOf(cal);
  if (!item) return "";
  const teams = cal.data.teams || [];
  const when = centralCalendarWhenLabel(item);
  const ownSentence = centralCalendarStatusSentence(item);
  // K2b-2a-2b: a live question is something expected after the event.
  const sentence = ownSentence === "Nothing is expected after this event." && item.canManage === true && ccPanelQuestionsWaiting(cal.panelQuestions, item) ? CC_WAITING_SENTENCE : ownSentence;
  const count = centralCalendarCountLabel(item);
  // K2c-1: this panel's link command left not confirmed (by the event, or by
  // the planned card it was sent from).
  const pending = uncertainWrites.find((entry) => entry.mode === "link" && (entry.panelKey === item.key || (item.kind === "event" && entry.eventId === item.eventId))) || null;
  // K2b-2a-2b: this event's question command left not confirmed.
  const pendingQuestion = item.kind === "event" ? uncertainWrites.find((entry) => entry.mode === "question" && entry.eventId === item.eventId) || null : null;
  const linksLocked = Boolean(cal.linkWrite) || Boolean(pending && item.kind === "event") || Boolean(pendingQuestion) || Boolean(cal.questionStep);
  // The section also stays while one of its commands is not confirmed (its Check result).
  const questionsOn = item.kind === "event" && item.canManage === true && (formCtx.catalog?.questionsEnabled === true || Boolean(pendingQuestion));
  // The RPE gap names Ask RPE (and the Questions section opens for it) only when the section really offers it.
  const eventAskRpe = item.kind === "event" && item.canManage === true && formCtx.catalog?.questionsEnabled === true && (item.gaps || []).includes("rpe")
    && ccPanelAskOffered(item, cal.panelQuestions, "rpe", questionChannelsOf(item, cal));
  const body = `<header class="cc-panel-head">
        <h3 class="cc-panel-title" id="ccPanelTitle">${escapeHtml(centralCalendarTitle(item))}</h3>
        <button type="button" class="plain-button icon-button cc-panel-close" data-action="central-calendar-close-panel" aria-label="Close">&times;</button>
      </header>
      <p class="cc-panel-kind${item.cancelled ? " is-cancelled" : ""}">${itemIconHtml(item, "cc-panel-icon")}<span>${escapeHtml(centralCalendarKindLabel(item))}</span></p>
      <p class="cc-panel-when">${escapeHtml(centralCalendarLongDate(item.date))}${item.date === today ? " (today)" : ""}${when && layout === "phone" ? `<span class="cc-panel-time"><span aria-hidden="true"> · </span>${escapeHtml(when)}</span>` : when ? ` · ${escapeHtml(when)}` : ""}</p>
      ${(item.teamIds || []).length ? `<p class="cc-panel-teams">${item.teamIds.map((id) => `<span class="cc-panel-team"${teamColorStyle(id, teams)}><span class="cc-team-dot" aria-hidden="true"></span>${escapeHtml(teamName(id, teams))}</span>`).join("")}</p>` : ""}
      ${renderBadgeHtml(item, today) || count || sentence ? `<div class="cc-panel-status">${renderBadgeHtml(item, today)}${count ? `<span class="cc-panel-count">${escapeHtml(count)}</span>` : ""}${sentence ? `<p class="cc-panel-sentence">${escapeHtml(sentence)}</p>` : ""}</div>` : ""}
      ${item.kind === "event" ? renderEventFactsHtml(item, { askRpe: eventAskRpe }) : ""}
      ${item.kind === "event"
    ? renderEventPanelBodyHtml(item, cal, { roster, pending, pendingQuestion, linksLocked, questionsOn, today, askRpe: eventAskRpe, compact: layout === "phone" })
    : `${renderEventActionsHtml(item, { locked: linksLocked })}
      ${renderEventDeleteHtml(item, cal, pending, { locked: linksLocked || Boolean(cal.form) })}
      ${item.kind === "planned" ? renderPlannedLinksHtml(item, cal, pending, uncertainWrites.filter((entry) => entry.mode === "link")) : ""}
      ${item.kind === "activity" || item.kind === "external" ? renderAddToEventHtml(item, cal, pending) : ""}
      ${renderGoThereHtml(item)}
      ${renderCentralCalendarSeeEachHtml(cal, item)}
      <section class="cc-panel-athletes">${renderPanelAthletesHtml(item, cal, roster)}</section>`}`;
  return panelHost(body, layout);
}

// K2b-2a-2b (contract 4.2): the questions of a manager's event; every
// control off while a write of this panel is in flight or not confirmed.
function renderEventQuestionsHtml(item, cal, pendingQuestion, linkPending, today) {
  const busy = cal.linkWrite?.family === "question";
  const step = cal.questionStep && cal.questionStep.eventKey === item.key ? cal.questionStep : null;
  return renderCentralCalendarQuestionsHtml(item, cal.panelQuestions, {
    step, busy, off: Boolean(cal.linkWrite) || Boolean(pendingQuestion) || linkPending || Boolean(cal.alignStep), today,
    feedback: linkFeedbackHtml(cal, item.key, pendingQuestion, "question"),
    // Where that line belongs: the row of the command that sent it.
    feedbackAt: (cal.linkMessage?.family === "question" && cal.linkMessage.panelKey === item.key ? cal.linkMessage.at : null)
      || (pendingQuestion ? { kind: pendingQuestion.kind || "", questionId: pendingQuestion.questionId || "" } : null),
    ...questionChannelsOf(item, cal),
    inSection: true,
  });
}

// RPE's other channels: linked trainings (the manager view), or the event's own
// RPE request that no live question owns (the server's rpe_already_linked).
function questionChannelsOf(item, cal) {
  const view = cal.panelEvent && cal.panelEvent.key === item.key ? cal.panelEvent.event : null;
  return {
    rpeFromSessions: (view?.sessionLinks || []).length > 0,
    rpeFromRequest: Boolean(view?.externalScheduleId ?? item.links?.externalScheduleId),
  };
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
    if (entry.mode === "link") return `Check linking for “${title}”`;
    if (entry.mode === "question") return `Check the question for “${title}”`;
    return entry.mode === "create" ? `Check “${title}”` : entry.mode === "cancel" ? `Check cancelling “${title}”` : `Check the change to “${title}”`;
  };
  return `<div class="cc-refresh-note cc-uncertain-line" role="status">
      <span>${writes.length === 1 ? "1 save of an event is not confirmed." : `${writes.length} saves of events are not confirmed.`}</span>
      ${writes.map((entry) => `<button type="button" class="plain-button cc-inline-button" data-action="central-calendar-event-pending" data-request-key="${escapeAttr(entry.requestKey)}"${cal.linkWrite ? " disabled" : ""}>${escapeHtml(label(entry))}</button>`).join("")}
    </div>`;
}

// `canCreate`: the active workspace may create events (a club, a team, a
// private coach - the actions module decides from the answer's workspace);
// `eventRoster`: the workspace's athletes for the form's targets ({ id, name });
// `uncertainWrites`: the event saves left unconfirmed in this workspace.
export function renderCentralCalendarHtml(sourceCal, { today, layout = "wide", roster = new Map(), canCreate = false, eventRoster = [], uncertainWrites = [], athletes = state.athletes } = {}) {
  // K6 (contract 2.5, Q3): while an athlete is chosen the Groups chips scope the strip only - the in-memory card
  // filter by team is suspended, so a club-wide event of the athlete is never hidden.
  const athleteChosen = Boolean(centralCalendarChosenAthlete(sourceCal, athletes));
  const cal = athleteChosen ? { ...sourceCal, filters: { ...sourceCal.filters, teamIds: [] } } : sourceCal;
  const switcherModel = buildCentralCalendarSwitcherModel(sourceCal, athletes);
  const teams = cal.data?.teams || [];
  const byDate = centralCalendarItemsByDate(cal.data);
  const days = cal.anchor ? centralCalendarDisplayedDays(cal.view, cal.anchor) : [];
  const counts = centralCalendarChipCounts(byDate, days);
  // FE-D16: a chosen kind read on its own counts what it shows (an RPE request no longer folded into its event).
  // K5-2: the chosen *Show only* kind's own count from that answer - Other activities leaves its imports out.
  const shown = centralCalendarShownData(cal);
  const only = (cal.filters?.kinds || [])[0] || "";
  if (shown && shown !== cal.data && only) counts.kinds[only] = centralCalendarChipCounts(centralCalendarItemsByDate(shown), days).kinds[only] || 0;
  // K5-4 (contract 2.1): the GPS imports pill also counts the sessions waiting for review, each mark's number (an
  // uncertain mark has none), so the pill says how many are waiting. Like the other pills, whatever else is chosen.
  counts.kinds.gps = (counts.kinds.gps || 0) + days.reduce((sum, date) => sum + (gpsReviewMark(cal, date)?.count || 0), 0);
  // The panel column exists only while the open item is really in the answer,
  // or while the event form is open.
  const panelOpen = Boolean(cal.form) || Boolean(panelItemOf(cal));
  // K2b-1d2 (the manager's Q1): the form never takes the platform's teams - they are every club's; the platform's
  // support edit keeps the event's own targets read-only, and the platform creates no event.
  const formTeams = cal.data?.workspace?.type === "platform" ? [] : teams;
  const formCtx = { types: cal.eventTypes || [], teams: formTeams, roster: eventRoster, catalog: centralCalendarCatalogOf(cal) };
  return `<section class="central-calendar cc-layout-${escapeAttr(layout)} cc-view-${escapeAttr(cal.view)}${panelOpen ? " cc-panel-open" : ""}" aria-label="Calendar">
      ${layout === "wide" ? renderK2c3FormBandHtml(cal.form) : ""}
      ${cal.anchor ? renderToolbarHtml(cal, layout, { canCreate }) : ""}
      ${renderCentralCalendarSwitcherHtml(sourceCal, switcherModel, { layout, counts, phoneAction: layout === "phone" && cal.anchor ? renderNewEventHtml(cal, canCreate) : "" })}
      ${renderCentralCalendarShowingLineHtml(sourceCal, switcherModel, { onlyLabel: only ? `only ${CENTRAL_CALENDAR_SHOW_ONLY_LABELS[only] || only}` : "" })}
      ${renderFiltersHtml(sourceCal, counts, teams, { compact: layout === "phone" && cal.view === "week" && cal.weekMode === "grid" })}
      ${cal.refreshError ? `<p class="cc-refresh-note" role="status">${escapeHtml(cal.refreshError)} <button type="button" class="plain-button cc-inline-button" data-action="central-calendar-retry">Try again</button></p>` : ""}
      ${cal.notice ? `<p class="cc-refresh-note" role="status">${escapeHtml(cal.notice)}</p>` : ""}
      ${renderUncertainWritesHtml(cal, uncertainWrites)}
      <div class="cc-body">
        <div class="cc-main">${cal.anchor ? renderBodyHtml(cal, layout, today) : renderStateHtml(cal)}</div>
        ${renderPanelHtml(cal, layout, today, roster, formCtx, uncertainWrites)}
      </div>
      ${cal.k3?.sheet && !cal.form && panelItemOf(cal)?.key === cal.k3.eventKey ? renderK3SheetHtml(cal, panelItemOf(cal)) : ""}
    </section>`;
}

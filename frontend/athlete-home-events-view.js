// The athlete's *Upcoming events* on Home (K2b-1e, docs/ai/central-calendar-k2b-plan.md section 22): pure template
// strings over state.athleteHomeEvents (athlete-home-events-data.js). A row shows the event's title, its type word, its
// day(s) and time, and its place with *Open in maps* (the K2b-1d panel's place, reused); a cancelled event is marked and
// shows no place. Nothing here talks to the server.
import {
  ATHLETE_HOME_EVENTS_DAYS, ATHLETE_HOME_EVENTS_LIMIT, athleteHomeEventsNow, athleteHomeVisibleEventRows, registerAthleteHomeEventsSectionPainter,
} from "./athlete-home-events-data.js";
import { renderCentralCalendarEventPlaceHtml } from "./central-calendar-event-details.js";
import { CENTRAL_CALENDAR_EVENT_KIND_LABELS, centralCalendarItemColorIndex, centralCalendarItemIconKey } from "./central-calendar-view.js";
import { renderIconSvg } from "./icon-render.js";
import { state } from "./state.js";
import { addDaysIso, escapeAttr, escapeHtml, localDateIso } from "./utils.js";

const LIST_ID = "athleteHomeEventsList";
const TITLE_ID = "athleteHomeEventsTitle";

// "Today", "Tomorrow", else the weekday and the date ("Thu 19 Nov").
export function athleteHomeEventDayWord(iso, today) {
  if (iso === today) return "Today";
  if (today && iso === addDaysIso(today, 1)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date(`${iso}T12:00:00`));
}

// The time: "18:00–19:30", "18:00" without an end, "Time not set" without a start (the manager's Q2: an event without a
// time is not necessarily a whole day; the coach may not have entered it). A day off has no time by nature, so without
// one it shows no time part at all (the manager's decision on PR #603; its kind is `day_off`).
export function athleteHomeEventTime(row) {
  if (!row.startTime) return row.eventKind === "day_off" ? "" : "Time not set";
  return `${String(row.startTime).slice(0, 5)}${row.endTime ? `–${String(row.endTime).slice(0, 5)}` : ""}`;
}

// The day(s) and the time: "Today · 18:00", "Fri 21 Nov – Sun 23 Nov · 09:00–17:00" (a date range always with the en
// dash and a space on each side, the manager's decision on PR #603). A multi-day event that began before today shows
// its real first day.
export function athleteHomeEventWhen(row, today) {
  const days = row.to && row.to !== row.from
    ? `${athleteHomeEventDayWord(row.from, today)} – ${athleteHomeEventDayWord(row.to, today)}`
    : athleteHomeEventDayWord(row.from, today);
  return [days, athleteHomeEventTime(row)].filter(Boolean).join(" · ");
}

function typeWord(row) {
  return row.eventTypeLabel || CENTRAL_CALENDAR_EVENT_KIND_LABELS[row.eventKind] || "Event";
}

function rowHtml(row, today) {
  const word = typeWord(row);
  const title = row.title || word;
  // The day first (what she scans the list for), then the type word - only when the title is not that word already.
  const meta = [athleteHomeEventWhen(row, today), title !== word ? word : ""].filter(Boolean).join(" · ");
  // K2b-1d3: the type's icon tinted with its colour, as on the calendar card; else the kind's icon, untinted.
  const look = { kind: "event", eventKind: row.eventKind, eventTypeIconKey: row.eventTypeIconKey, eventTypeColorKey: row.eventTypeColorKey };
  const colorIndex = centralCalendarItemColorIndex(look);
  const svg = renderIconSvg(centralCalendarItemIconKey(look), { size: 20, className: colorIndex < 0 ? "athlete-home-event-icon" : "athlete-home-event-icon has-type-color" });
  const icon = colorIndex < 0 ? svg : `<span class="cc-type-tint" style="--cc-type-color: var(--cc-team-${colorIndex})">${svg}</span>`;
  // Cancelled (22.7 Q1): the mark right under the title, read before the time; no place.
  const status = row.cancelled
    ? `<p class="athlete-home-event-status"><span class="cc-badge cc-badge-cancelled athlete-home-event-cancelled"><span aria-hidden="true">✕</span> Cancelled</span></p>`
    : "";
  const place = row.cancelled ? "" : renderCentralCalendarEventPlaceHtml({ place: row.place, location: null });
  return `<li class="athlete-home-event${row.cancelled ? " is-cancelled" : ""}">
      ${icon}
      <div class="athlete-home-event-body">
        <p class="athlete-home-event-title">${escapeHtml(title)}</p>
        ${status}
        <p class="athlete-home-event-when">${escapeHtml(meta)}</p>
        ${place}
      </div>
    </li>`;
}

function bodyHtml(slice) {
  if (slice.status === "error") {
    return `<p class="athlete-home-events-state" role="alert">${escapeHtml(slice.error || "Events could not be loaded.")}</p>
      ${slice.canRetry ? `<button type="button" class="plain-button compact-button athlete-home-events-button" data-action="athlete-home-events-retry">Try again</button>` : ""}`;
  }
  if (slice.status !== "ready") return `<p class="muted athlete-home-events-state" role="status">Loading events…</p>`;
  // K2b-1d3: an event that has ended is left out (filtered at every paint and at the minute's tick).
  const rows = athleteHomeVisibleEventRows(slice.rows, athleteHomeEventsNow());
  if (!rows.length) return `<div class="empty-state athlete-home-events-state">No events in the next ${ATHLETE_HOME_EVENTS_DAYS} days.</div>`;
  const shown = slice.expanded ? rows : rows.slice(0, ATHLETE_HOME_EVENTS_LIMIT);
  const more = rows.length - ATHLETE_HOME_EVENTS_LIMIT;
  const toggle = more > 0
    ? `<button type="button" class="plain-button compact-button athlete-home-events-button" data-action="athlete-home-events-toggle" aria-expanded="${slice.expanded ? "true" : "false"}" aria-controls="${LIST_ID}">${slice.expanded ? "Show fewer" : `Show ${more} more`}</button>`
    : "";
  // role="list": Safari drops a list's semantics under list-style: none.
  // K2b-1d3: "Today" / "Tomorrow" from the device's date at this paint, not the date the list was read (a paint after
  // midnight never calls today "Tomorrow").
  const today = localDateIso(new Date(athleteHomeEventsNow()));
  return `<ul class="athlete-home-events-list" id="${LIST_ID}" role="list">${shown.map((row) => rowHtml(row, today)).join("")}</ul>${toggle}`;
}

export function renderAthleteHomeEventsHtml(slice) {
  // 403: nothing she can do here, so nothing is shown.
  if (!slice || slice.status === "hidden") return "";
  return `
    <section class="panel athlete-home-events" aria-labelledby="${escapeAttr(TITLE_ID)}">
      <div class="athlete-home-events-head">
        <p class="eyebrow" id="${escapeAttr(TITLE_ID)}" tabindex="-1">Upcoming events</p>
        <p class="muted athlete-home-events-range">Next ${ATHLETE_HOME_EVENTS_DAYS} days</p>
      </div>
      ${bodyHtml(slice)}
    </section>
  `;
}

// K2b-1d3: the minute's tick replaces only this section, in place (athlete-home-events-data.js). A control of the
// section that had the focus (Show N more / Show fewer) has it again after the swap. Without the section on the page it
// changes nothing and answers false.
export function repaintAthleteHomeEventsSection(doc = globalThis.document) {
  const section = doc?.querySelector?.("section.athlete-home-events");
  if (!section) return false;
  const active = doc.activeElement;
  const focusAction = active && active !== section && section.contains(active) ? active.getAttribute("data-action") : null;
  const template = doc.createElement("template");
  template.innerHTML = renderAthleteHomeEventsHtml(state.athleteHomeEvents).trim();
  const next = template.content.firstElementChild;
  if (next) section.replaceWith(next);
  else section.remove();
  if (next && focusAction) next.querySelector(`[data-action="${focusAction}"]`)?.focus?.();
  return true;
}
registerAthleteHomeEventsSectionPainter(() => repaintAthleteHomeEventsSection());

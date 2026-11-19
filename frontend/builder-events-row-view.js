// K2c-3 (docs/ai/central-calendar-k3-plan.md 6.2 - 6.6; mockup
// docs/design/calendar-k4/02): the day's events row, Whole day, each session's
// `Event: [▾]` with its note, and the "not saved yet" question. Every state has
// words and a glyph, never colour alone; the selects are native (16 px).
import { calendarColorIndex } from "./calendar-colors.js";
import { k3SessionLabel } from "./central-calendar-k3.js";
import { CENTRAL_CALENDAR_EVENT_KIND_ICONS } from "./central-calendar-view.js";
import {
  builderDayEvents,
  builderEventsBusy,
  builderEventsOffered,
  builderSelectorChoices,
  builderSessionEvent,
  builderSessionOutside,
  EVENTS_LOAD_FAILED,
  SAVE_FIRST_QUESTION,
} from "./builder-events-row.js";
import { isLibraryKey, renderIconSvg } from "./icon-render.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const ICON_LOCK = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const ICON_CAL = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><rect x="4" y="5" width="16" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 10h16M9 3v4M15 3v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const ICON_WARN = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M12 4l9 16H3z M12 10v4 M12 17v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M5 12l5 5 9-10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const time = (value) => String(value || "").slice(0, 5);
const range = (event) => [time(event.startTime), time(event.endTime)].filter(Boolean).join("–");
const placeOf = (event) => String(event.place?.name || event.location || "").trim();

function colorStyle(event) {
  const index = calendarColorIndex(event.eventTypeColorKey);
  return index < 0 ? "" : ` style="--k3-color: var(--cc-team-${index})"`;
}

function iconOf(event) {
  const key = isLibraryKey(event.eventTypeIconKey) ? event.eventTypeIconKey : CENTRAL_CALENDAR_EVENT_KIND_ICONS[event.eventKind] || "calendar-event";
  return renderIconSvg(key, { size: 16, className: "k3-type-icon" });
}

function messageHtml(at) {
  const row = state.builder.events;
  const message = row?.message && row.message.at === at ? row.message : null;
  const pending = row?.pending && row.pending.at === at ? row.pending : null;
  if (!message && !pending) return "";
  const checking = row.write?.check === true;
  const tone = message?.tone === "ok" ? "is-ok" : "is-warning";
  const useTime = message?.useEventTime ? `<button type="button" class="plain-button k3-note-button" data-action="builder-events-use-event-time" data-session-id="${escapeAttr(message.useEventTime)}">Use the event's time</button>` : "";
  const check = pending ? `<button type="button" class="plain-button k3-note-button" data-action="builder-events-check"${checking ? " disabled" : ""}>${checking ? "Checking…" : "Check result"}</button>` : "";
  const retry = message?.retry ? `<button type="button" class="plain-button k3-note-button" data-action="builder-events-retry-move" data-date="${escapeAttr(message.retry.day)}" data-session-id="${escapeAttr(message.retry.sessionId)}" data-event-id="${escapeAttr(message.retry.value)}">Try again</button>` : "";
  return `<div class="k3-note ${tone}" role="${tone === "is-ok" ? "status" : "alert"}">${tone === "is-ok" ? ICON_CHECK : ICON_WARN}<span>${escapeHtml(message?.text || "The result is not confirmed.")}</span>${useTime}${retry}${check}</div>`;
}

// The day's events row (6.2), above its sessions.
export function renderBuilderEventsRowHtml(block) {
  if (!block?.date || !builderEventsOffered()) return "";
  const row = state.builder.events || {};
  const draft = state.builder.draft;
  const firstDay = (draft?.blocks || []).find((b) => b.date)?.date;
  const busy = builderEventsBusy() || row.loading;
  const events = builderDayEvents(block.date);
  const chips = events.map((event) => {
    const locked = event.canManage !== true;
    const meta = locked ? [time(event.startTime), "Managed by the club"].filter(Boolean).join(" · ") : [range(event), placeOf(event)].filter(Boolean).join(" · ");
    return `<button type="button" class="b-ev-chip${locked ? " is-locked" : ""}" data-action="builder-events-open" data-date="${escapeAttr(block.date)}" data-key="${escapeAttr(event.key)}"${colorStyle(event)} aria-label="${escapeAttr(`Open ${event.title || "the event"} in the calendar`)}">
        ${locked ? ICON_LOCK : iconOf(event)}<strong>${escapeHtml(event.title || "Event")}</strong>${meta ? `<span class="b-ev-meta">${escapeHtml(meta)}</span>` : ""}</button>`;
  }).join("");
  const managed = events.filter((event) => event.canManage === true);
  const wholeDay = (block.sessions || []).length >= 2 && managed.length
    ? `<label class="b-ev-whole">Whole day: <select class="b-ev-select" data-builder-events-day="${escapeAttr(block.date)}"${busy ? " disabled" : ""}>
        <option value="">Choose an event for every session…</option>
        ${managed.map((event) => `<option value="${escapeAttr(event.eventId)}">${escapeHtml(`${event.title || "Event"}${time(event.startTime) ? ` ${time(event.startTime)}` : ""}`)}</option>`).join("")}
      </select></label>`
    : "";
  const made = row.made && row.made.day === block.date ? `<p class="k3-note is-ok" role="status">${ICON_CHECK}<span>${escapeHtml(row.made.text)}</span></p>` : "";
  const loading = row.loading && block.date === firstDay ? `<p class="b-ev-quiet" role="status">Loading events…</p>` : "";
  const error = row.error && block.date === firstDay
    ? `<p class="k3-note is-warning" role="alert">${ICON_WARN}<span>${escapeHtml(EVENTS_LOAD_FAILED)}</span><button type="button" class="plain-button k3-note-button" data-action="builder-events-retry">Try again</button></p>`
    : "";
  return `<div class="b-ev-row" role="group" aria-label="${escapeAttr(`Events on ${block.date}`)}">
      <span class="b-ev-label">Events:</span>
      ${chips || `<span class="b-ev-quiet">None on this day.</span>`}
      <button type="button" class="plain-button b-ev-create" data-action="builder-events-create" data-date="${escapeAttr(block.date)}"${busy ? " disabled" : ""}>${ICON_CAL}<span>Create event →</span></button>
    </div>
    ${loading}${error}${made}
    ${wholeDay}
    ${messageHtml(`day:${block.date}`)}`;
}

// `Event: [▾]` on a session's line (6.4).
export function renderBuilderSessionEventHtml(block, session) {
  if (!block?.date || !builderEventsOffered()) return "";
  const row = state.builder.events || {};
  const busy = builderEventsBusy() || row.loading;
  const value = builderSessionEvent(block.date, session);
  const name = k3SessionLabel(session);
  if (value === "other") {
    return `<span class="b-ev-session"><span class="b-ev-locked">${ICON_LOCK}Linked by the club's admin from the calendar.</span></span>`;
  }
  const choices = builderSelectorChoices(block.date, session);
  const current = value ? builderDayEvents(block.date).find((event) => String(event.eventId) === String(value)) : null;
  if (current && !choices.some((c) => String(c.event.eventId) === String(value))) choices.unshift({ event: current, locked: false });
  const options = choices.map(({ event, locked }) => {
    const label = `${locked ? "🔒 " : ""}${event.title || "Event"}${time(event.startTime) ? ` ${time(event.startTime)}` : ""}${locked ? " - Linked by the club's admin from the calendar." : ""}`;
    return `<option value="${escapeAttr(event.eventId)}"${String(event.eventId) === String(value) ? " selected" : ""}${locked ? " disabled" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  return `<label class="b-ev-session${value ? " is-linked" : ""}"${current ? colorStyle(current) : ""}><span class="b-ev-session-label">Event:</span>
      <select class="b-ev-select" data-builder-event-select data-date="${escapeAttr(block.date)}" data-session-id="${escapeAttr(session.id)}" aria-label="${escapeAttr(`Event for ${name}`)}"${busy ? " disabled" : ""}>
        <option value=""${value ? "" : " selected"}>No event</option>${options}
      </select></label>`;
}

// The notes under a session: its message, and a linked session whose own
// time or half no longer fits its event (7.1 / 7.2; nothing changes by itself).
export function renderBuilderSessionEventNoteHtml(block, session) {
  if (!block?.date || !builderEventsOffered()) return "";
  const own = messageHtml(`session:${session.id}`);
  if (own) return own;
  const outside = builderSessionOutside(block.date, session);
  if (!outside) return "";
  const { fit, event } = outside;
  const text = fit.reason === "time" ? `Outside the event's time (${range(event)})` : "Outside the event's half of the day";
  return `<div class="k3-note is-warning">${ICON_WARN}<span>${escapeHtml(text)}</span>
      ${fit.reason === "time" ? `<button type="button" class="plain-button k3-note-button" data-action="builder-events-use-event-time" data-session-id="${escapeAttr(session.id)}">Use the event's time</button>` : ""}
      <button type="button" class="text-action k3-note-button" data-action="builder-events-open" data-date="${escapeAttr(block.date)}" data-key="${escapeAttr(event.key)}">Open the event</button></div>`;
}

// "This plan isn't saved yet" (6.4), asked once before a write.
export function renderBuilderEventsAskHtml() {
  const ask = state.builder.events?.ask;
  if (!ask) return "";
  const busy = Boolean(ask.busy);
  return `<div class="k3-sheet-layer">
      <button type="button" class="k3-sheet-backdrop" data-action="builder-events-save-first" data-answer="no" aria-label="Cancel" tabindex="-1"></button>
      <div class="k3-sheet" role="dialog" aria-modal="true" aria-labelledby="bEvAskTitle"${busy ? ' aria-busy="true"' : ""}>
        <h3 class="k3-sheet-title" id="bEvAskTitle">This plan isn't saved yet</h3>
        <p class="k3-sheet-text">${escapeHtml(SAVE_FIRST_QUESTION)}</p>
        <div class="k3-sheet-actions">
          <button type="button" class="plain-button cc-primary k3-sheet-button" data-action="builder-events-save-first" data-answer="yes" data-k3-focus${busy ? " disabled" : ""}>${busy ? "Saving…" : "Save and continue"}</button>
          <button type="button" class="plain-button k3-sheet-button" data-action="builder-events-save-first" data-answer="no"${busy ? " disabled" : ""}>Cancel</button>
        </div>
      </div>
    </div>`;
}

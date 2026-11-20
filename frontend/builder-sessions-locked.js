// Task 5 (docs/ai/builder-batch-edit-plan.md section 12.3): the Save of an
// edit draft was refused (409 edit_sessions_locked) because the draft removes
// or moves a session that has entered results or is linked to an event. Says
// which sessions and why, and the way out: put the session back, or first
// remove the link to the event in the calendar. The event is found from the
// Builder's own reads of the week (the server names no event).
import { builderDayEvents, builderSessionEvent } from "./builder-events-row.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function sessionsLockedDayLabel(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!match) return String(day || "");
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()];
  return `${weekday} ${match[3]}.${match[2]}`;
}

// The way to the link: the managed event's panel, a sentence for an event the
// coach does not manage, or the calendar on that day when the event is not in
// the week the Builder read.
function linkWayHtml(session) {
  const target = { amPm: session.amPm, bta: session.bta, name: session.name };
  const value = builderSessionEvent(session.day, target);
  if (value === "other") {
    return `<p class="builder-sessions-locked-why">Linked by the club's admin from the calendar. Ask them to remove the link, then save again.</p>`;
  }
  const event = value ? builderDayEvents(session.day).find((e) => String(e.eventId) === String(value)) : null;
  const sentence = `<p class="builder-sessions-locked-why">Linked to ${event?.title ? `the event “${escapeHtml(event.title)}”` : "an event"} in the calendar. First remove the link to the event, then save again.</p>`;
  const button = event
    ? `<button type="button" class="plain-button" data-action="builder-events-open" data-date="${escapeAttr(session.day)}" data-key="${escapeAttr(event.key)}">Open the event</button>`
    : `<button type="button" class="plain-button" data-action="builder-events-open" data-date="${escapeAttr(session.day)}">Open the calendar</button>`;
  return `${sentence}<div class="builder-sessions-locked-actions">${button}</div>`;
}

export function renderBuilderSessionsLockedHtml() {
  const locked = state.builder.sessionsLocked;
  const sessions = Array.isArray(locked?.sessions) ? locked.sessions : [];
  if (!sessions.length) return "";
  const rows = sessions.map((session) => {
    const reasons = Array.isArray(session.reasons) ? session.reasons : [];
    const where = [sessionsLockedDayLabel(session.day), session.amPm].filter(Boolean).join(" · ");
    const verb = session.change === "moved" ? "moved" : "removed";
    const parts = [];
    if (reasons.includes("has_results")) {
      parts.push(`<p class="builder-sessions-locked-why">Has entered results, so it can't be removed or moved. Its content can still change.</p>`);
    }
    if (reasons.includes("linked_to_event")) parts.push(linkWayHtml(session));
    return `<li class="builder-sessions-locked-item"><p><strong>${escapeHtml(session.name || "Session")}</strong> · ${escapeHtml(where)} <span class="muted">(${verb} in this draft)</span></p>${parts.join("")}</li>`;
  }).join("");
  return `<section class="builder-sessions-locked" data-builder-sessions-locked role="alert">
      <p><strong>Not saved.</strong> ${sessions.length === 1 ? "This session can't be removed or moved:" : "These sessions can't be removed or moved:"}</p>
      <ul class="builder-sessions-locked-list">${rows}</ul>
      <p>Your changes are still here. Put ${sessions.length === 1 ? "the session" : "these sessions"} back where ${sessions.length === 1 ? "it was" : "they were"}, or discard your changes, then save again.</p>
      <div class="builder-sessions-locked-actions"><button type="button" class="plain-button" data-action="builder-sessions-locked-close">OK</button></div>
    </section>`;
}

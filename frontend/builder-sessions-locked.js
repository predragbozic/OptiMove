// Task 5 (docs/ai/builder-batch-edit-plan.md section 12): a session that has
// entered results or is linked to an event can't be removed or moved.
// - The Save of an edit draft refused (409 edit_sessions_locked): a panel says
//   which sessions and why, with one way out per session: move it back,
//   discard the changes, or first remove the link to the event (Open the
//   event, the Builder's own hand-off to the calendar). The event is found
//   from the Builder's own reads of the week (the server names no event).
// - Deleting a published plan refused (409 plan_sessions_locked): one
//   sentence naming the sessions, in place of a generic error.
import { builderDayEvents, builderSessionEvent } from "./builder-events-row.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RESULTS_WHY = "Athletes have already entered results for it (for example RPE)";
const ROUND_TRIP = "Your draft is kept. After you remove the link, come back to Builder › Continue where you left off, and save again.";

export function sessionsLockedDayLabel(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!match) return String(day || "");
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()];
  return `${weekday} ${match[3]}.${match[2]}`;
}
const whereOf = (session) => [sessionsLockedDayLabel(session.day), session.amPm].filter(Boolean).join(" · ");
const countLine = (n, what) => (n === 1 ? `This session can't be ${what}:` : `${n} sessions can't be ${what}:`);
const discardButton = `<button type="button" class="plain-button" data-action="builder-discard-current-draft">Discard changes</button>`;

// The way out for one session the draft removes or moves.
function wayOutHtml(session) {
  const reasons = Array.isArray(session.reasons) ? session.reasons : [];
  const moved = session.change === "moved";
  const back = moved
    ? `Move it back to ${escapeHtml(whereOf(session))}, or discard your changes.`
    : "To keep it, discard your changes, then make your other edits again.";
  if (reasons.includes("has_results")) {
    // Results can't be taken away, so removing the link would not help.
    const also = reasons.includes("linked_to_event") ? " It is also linked to an event." : "";
    return `<p class="builder-sessions-locked-why">${RESULTS_WHY}, so it can't be ${moved ? "moved" : "removed"}. You can still change its content.${also}</p>
      <p class="builder-sessions-locked-why">${back}</p>${moved ? "" : `<div class="builder-sessions-locked-actions">${discardButton}</div>`}`;
  }
  const target = { amPm: session.amPm, bta: session.bta, name: session.name };
  const value = builderSessionEvent(session.day, target);
  if (value === "other") {
    return `<p class="builder-sessions-locked-why">Linked to an event you can't change. Ask whoever manages that event (usually your club's admin) to remove the link, then save again.</p>
      <p class="builder-sessions-locked-why">Or: ${back.charAt(0).toLowerCase()}${back.slice(1)}</p>`;
  }
  const event = value ? builderDayEvents(session.day).find((e) => String(e.eventId) === String(value)) : null;
  const named = event?.title ? `the event “${escapeHtml(event.title)}”` : "an event";
  const open = event
    ? `<button type="button" class="plain-button builder-sessions-locked-primary" data-action="builder-events-open" data-date="${escapeAttr(session.day)}" data-key="${escapeAttr(event.key)}">Open the event</button>`
    : `<button type="button" class="plain-button builder-sessions-locked-primary" data-action="builder-events-open" data-date="${escapeAttr(session.day)}">Open the calendar</button>`;
  return `<p class="builder-sessions-locked-why">Linked to ${named} in the calendar. To keep this change, first remove the link to the event, then save again.</p>
    <div class="builder-sessions-locked-actions">${open}</div>
    <p class="builder-sessions-locked-why muted">${ROUND_TRIP}</p>
    <p class="builder-sessions-locked-why">Or: ${back.charAt(0).toLowerCase()}${back.slice(1)}</p>`;
}

export function renderBuilderSessionsLockedHtml() {
  const locked = state.builder.sessionsLocked;
  const sessions = Array.isArray(locked?.sessions) ? locked.sessions : [];
  if (!sessions.length) return "";
  const rows = sessions.map((session) => {
    const verb = session.change === "moved" ? "moved" : "removed";
    return `<li class="builder-sessions-locked-item"><p><strong>${escapeHtml(session.name || "Session")}</strong> · ${escapeHtml(whereOf(session))} <span class="muted">(${verb} in this draft)</span></p>${wayOutHtml(session)}</li>`;
  }).join("");
  return `<section class="builder-sessions-locked" data-builder-sessions-locked tabindex="-1" aria-labelledby="builder-sessions-locked-title">
      <p id="builder-sessions-locked-title" role="alert"><strong>Not saved.</strong> ${countLine(sessions.length, "removed or moved")}</p>
      <ul class="builder-sessions-locked-list">${rows}</ul>
      <p>Your changes are still here.</p>
      <div class="builder-sessions-locked-actions"><button type="button" class="text-action builder-sessions-locked-close" data-action="builder-sessions-locked-close">Close</button></div>
    </section>`;
}

// After the panel is first drawn: bring it into view and move focus to it, so
// a coach who pressed Save far down the page (or with a keyboard) sees it.
export function focusBuilderSessionsLocked() {
  const focus = () => {
    const panel = document.querySelector("[data-builder-sessions-locked]");
    if (!panel) return true;
    panel.scrollIntoView?.({ block: "nearest" });
    panel.focus?.({ preventScroll: true });
    return document.activeElement === panel;
  };
  // While Save runs the workspace is inert (app.js handleBuilderAction), and
  // an inert element takes no focus: try again once that is lifted.
  if (!focus()) setTimeout(focus, 0);
}

// Deleting a published plan refused: one sentence per session, no markup.
export function planSessionsLockedText(sessions) {
  const list = (Array.isArray(sessions) ? sessions : []).map((session) => {
    const reasons = Array.isArray(session.reasons) ? session.reasons : [];
    const why = reasons.includes("has_results")
      ? "athletes have already entered results for it"
      : "it is linked to an event in the calendar - first remove the link to the event, then delete again";
    return `• ${session.name || "Session"} · ${whereOf(session)}: ${why}.`;
  });
  return [`This plan can't be deleted. ${list.length === 1 ? "A session" : "Sessions"} with entered results or a link to an event can't be removed:`, ...list].join("\n");
}

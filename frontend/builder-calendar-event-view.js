// K2c-2-F: the Builder's "Make an event" - the button in a weekly session's
// row and its inline panel (docs/ai/central-calendar-k2c-plan.md 2.1, 2.2).
// Pure template strings over state.builder.calendarEvent; every selector is
// under the calendar's prefix (`cc-builder-event`).
import {
  builderCalendarEventBlockedReason,
  builderCalendarEventOffered,
  builderCalendarMadeKey,
  builderCalendarMatchSentence,
  builderCalendarTrainingTypes,
  formatDay,
  NO_TRAINING_TYPE,
  RESULT_NOT_CONFIRMED,
} from "./builder-calendar-event.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const ICON_CALENDAR = `<svg class="cc-builder-event-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="5" width="17" height="15" rx="2"></rect><path d="M8 3v4M16 3v4M3.5 10h17"></path></svg>`;

// The button in `.builder-session-actions` (weekly plans only).
export function renderBuilderCalendarEventButton({ draft, block, session, workspaceType, panel, made }) {
  if (!builderCalendarEventOffered(draft, block, workspaceType)) return "";
  const blocked = builderCalendarEventBlockedReason(draft);
  const busyElsewhere = Boolean(panel && panel.sessionId !== session.id && (panel.phase === "sending" || panel.phase === "unconfirmed"));
  const open = Boolean(panel && panel.sessionId === session.id);
  const disabled = Boolean(blocked) || busyElsewhere;
  const inCalendar = (made || []).includes(builderCalendarMadeKey(draft, block, session));
  return `
    <span class="cc-builder-event-trigger">
      <button class="plain-button cc-builder-event-button" type="button" data-action="builder-calendar-event-open" data-session-id="${escapeAttr(session.id)}" aria-expanded="${open ? "true" : "false"}" ${disabled ? "disabled" : ""}>${ICON_CALENDAR}<span>Make an event</span></button>
      ${inCalendar ? `<span class="cc-builder-event-badge" title="Made into an event from this Builder">✓ In calendar</span>` : ""}
      ${blocked ? `<span class="cc-builder-event-note" role="status">${escapeHtml(blocked)}</span>` : ""}
    </span>`;
}

// The inline panel under the session row, while it is open for that session.
export function renderBuilderCalendarEventPanel({ session, block, panel, types }) {
  if (!panel || panel.sessionId !== session.id) return "";
  const id = `cc-builder-event-${escapeAttr(session.id)}`;
  const busy = panel.phase === "sending";
  const body = renderBody({ session, block, panel, types, busy });
  return `
    <section class="cc-builder-event" id="${id}" aria-labelledby="${id}-title" ${busy ? 'aria-busy="true"' : ""}>
      <div class="cc-builder-event-head">
        <h4 class="cc-builder-event-title" id="${id}-title">Make an event</h4>
        <button class="plain-button cc-builder-event-close" type="button" data-action="builder-calendar-event-close" ${busy || panel.phase === "unconfirmed" ? "disabled" : ""}>Close</button>
      </div>
      ${body}
    </section>`;
}

function renderBody({ block, panel, types, busy }) {
  if (panel.phase === "reading") return `<p class="cc-builder-event-line" role="status">Reading the calendar…</p>`;
  if (panel.phase === "read_error") {
    return `<p class="cc-builder-event-line" role="alert">The calendar could not be read.</p>
      <div class="cc-builder-event-actions"><button class="plain-button cc-builder-event-primary" type="button" data-action="builder-calendar-event-retry">Try again</button></div>`;
  }
  if (panel.phase === "done") {
    return `<p class="cc-builder-event-line" role="status" tabindex="-1" data-cc-builder-event-focus>${escapeHtml(panel.doneText)}</p>
      ${(panel.doneNotes || []).map((note) => `<p class="cc-builder-event-quiet">${escapeHtml(note)}</p>`).join("")}
      <div class="cc-builder-event-actions"><button class="plain-button cc-builder-event-primary" type="button" data-action="builder-calendar-event-open-calendar">Open in calendar</button></div>`;
  }
  if (panel.phase === "unconfirmed") {
    return `<p class="cc-builder-event-line" role="alert" tabindex="-1" data-cc-builder-event-focus>${escapeHtml(RESULT_NOT_CONFIRMED)}</p>
      <p class="cc-builder-event-quiet">Check result sends the same request again; it never makes a second event.${panel.checkNote ? ` ${escapeHtml(panel.checkNote)}` : ""}</p>
      <div class="cc-builder-event-actions"><button class="plain-button cc-builder-event-primary" type="button" data-action="builder-calendar-event-check" ${panel.checking ? "disabled" : ""}>${panel.checking ? "Checking…" : "Check result"}</button></div>`;
  }
  const message = panel.message ? `<p class="cc-builder-event-line" role="alert" tabindex="-1" data-cc-builder-event-focus>${escapeHtml(panel.message)}</p>` : "";
  const match = panel.match;
  if (!match || match.kind !== "planned") {
    const sentence = match ? builderCalendarMatchSentence(match) : "";
    const calendarButton = match && (match.kind === "linked" || match.kind === "linked_many" || panel.offerCalendar)
      ? `<div class="cc-builder-event-actions"><button class="plain-button cc-builder-event-primary" type="button" data-action="builder-calendar-event-open-calendar">Open in calendar</button></div>` : "";
    return `${message}${sentence && sentence !== panel.message ? `<p class="cc-builder-event-line" role="status">${escapeHtml(sentence)}</p>` : ""}${calendarButton}`;
  }
  const training = builderCalendarTrainingTypes(types);
  if (!training.length) return `${message}<p class="cc-builder-event-line" role="status">${escapeHtml(NO_TRAINING_TYPE)}</p>`;
  const form = panel.form || {};
  const card = match.card;
  const names = (card.athletes || []).map((a) => a?.name).filter(Boolean);
  const count = Number(card.athleteCount) || (card.athleteIds || []).length;
  const chosenType = training.find((type) => String(type.id) === String(form.typeId)) || training[0];
  const off = busy ? "disabled" : "";
  return `
    ${message}
    <div class="cc-builder-event-form">
      <label class="cc-builder-event-field"><span>Title</span><input type="text" maxlength="120" value="${escapeAttr(form.title || "")}" data-builder-event-field="title" ${off}></label>
      ${training.length > 1
        ? `<label class="cc-builder-event-field"><span>Type</span><select data-builder-event-field="typeId" ${off}>${training.map((type) => `<option value="${escapeAttr(type.id)}" ${String(type.id) === String(chosenType.id) ? "selected" : ""}>${escapeHtml(type.label || "Training")}</option>`).join("")}</select></label>`
        : `<p class="cc-builder-event-quiet">Type: ${escapeHtml(chosenType.label || "Training")}</p>`}
      <p class="cc-builder-event-quiet">Day: ${escapeHtml(formatDay(block.date))}</p>
      <div class="cc-builder-event-times">
        <label class="cc-builder-event-field"><span>Start</span><input type="time" value="${escapeAttr(form.startTime || "")}" data-builder-event-field="startTime" ${off}></label>
        <label class="cc-builder-event-field"><span>End (optional)</span><input type="time" value="${escapeAttr(form.endTime || "")}" data-builder-event-field="endTime" ${off}></label>
      </div>
      ${names.length
        ? `<details class="cc-builder-event-who"><summary>${count === 1 ? "1 athlete" : `${count} athletes`}</summary><p class="cc-builder-event-quiet">${names.map(escapeHtml).join(", ")}</p></details>`
        : `<p class="cc-builder-event-quiet">${count === 1 ? "1 athlete" : `${count} athletes`}</p>`}
      <p class="cc-builder-event-quiet">${card.rpe ? "The event asks for RPE, as this training does." : "The event does not ask for RPE, as this training does not."}</p>
      <div class="cc-builder-event-actions">
        <button class="plain-button cc-builder-event-primary" type="button" data-action="builder-calendar-event-send" ${off}>${busy ? "Making the event…" : "Make the event"}</button>
        <button class="plain-button cc-builder-event-secondary" type="button" data-action="builder-calendar-event-close" ${off}>Cancel</button>
      </div>
    </div>`;
}

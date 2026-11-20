// K3 (docs/ai/central-calendar-k3-plan.md 2.1 - 2.8; the owner-approved
// mockup docs/design/calendar-k4/01): the panel's Training section and its
// case sheet, and in the Builder the band, the event's day, the In / Not in
// this event chips and the Save and link bar with its outcomes. Every state
// has words and a glyph, never colour alone.
import { calendarColorIndex } from "./calendar-colors.js";
import { k3PlanForLabel, k3SessionTimeText } from "./central-calendar-k3.js";
import {
  k3BlockInEvent,
  k3EventHasTrainings,
  k3EventLabel,
  k3EventRangeText,
  k3EventShape,
  k3Offered,
  k3SaveSummary,
  k3SessionState,
  k3SessionTimeMark,
} from "./central-calendar-k3-actions.js";
import { CENTRAL_CALENDAR_EVENT_KIND_ICONS } from "./central-calendar-view.js";
import { isLibraryKey, renderIconSvg } from "./icon-render.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const ICON_LIST = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const ICON_BACK = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M5 12l5 5 9-10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_WARN = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M12 4l9 16H3z M12 10v4 M12 17v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
const ICON_CLOCK = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v4l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

// ---------------------------------------------------------------------------
// The calendar's panel (2.1): *Plan the training* or *Open the training*.
// ---------------------------------------------------------------------------
export function renderK3PanelHtml(item, cal, { locked = false } = {}) {
  if (!k3Offered(item)) return "";
  const k3 = cal.k3 && cal.k3.eventKey === item.key ? cal.k3 : null;
  const busy = Boolean(k3?.busy);
  const has = k3EventHasTrainings(cal, item);
  const off = locked || busy || Boolean(cal.k3?.busy) || Boolean(cal.form);
  const label = busy ? "Opening the Builder…" : has ? "Open the training" : "Plan the training";
  return `<section class="cc-panel-k3" aria-labelledby="ccK3Title">
      <h4 class="cc-panel-subtitle" id="ccK3Title">Training</h4>
      ${has ? "" : `<p class="cc-panel-note">No training is planned for this event yet.</p>`}
      <button type="button" class="plain-button cc-panel-button${has ? "" : " cc-primary k3-plan-button"}" data-action="central-calendar-plan-training" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}"${off ? " disabled" : ""}${busy ? ' aria-busy="true"' : ""}>${has ? "" : ICON_LIST}<span>${escapeHtml(label)}</span></button>
      ${k3?.error ? `<p class="cc-panel-note k3-error" role="alert">${escapeHtml(k3.error)}</p>` : ""}
    </section>`;
}

// The sheet of 2.2 (a dialog on a computer, a bottom sheet on a phone).
export function renderK3SheetHtml(cal, item) {
  const k3 = cal.k3;
  if (!k3?.sheet) return "";
  const { sheet } = k3;
  const title = item ? `Plan the training · ${String(item.title || "").trim() || "Training"}` : "Plan the training";
  const busy = Boolean(k3.busy);
  const off = busy ? " disabled" : "";
  const button = (act, label, primary = false, focus = false, extra = "") => `<button type="button" class="plain-button k3-sheet-button${primary ? " cc-primary" : ""}" data-action="central-calendar-k3" data-k3="${act}"${extra}${focus ? " data-k3-focus" : ""}${off}>${escapeHtml(label)}</button>`;
  let body;
  if (sheet.choosing) {
    const rows = (sheet.planCase.withPlans || []).map((p) => `<li>${button("open-existing", p.name || "An athlete's plan", false, false, ` data-plan-id="${escapeAttr(p.planId)}"`)}</li>`).join("");
    body = `<p class="k3-sheet-text">Open whose plan? Changes go to that athlete only.</p><ul class="k3-sheet-list" role="list">${rows}</ul>
      <div class="k3-sheet-actions">${button("cancel", "Cancel", false, true)}</div>`;
  } else {
    const buttons = sheet.buttons.map((name, i) => {
      if (name === "planForRest") return button("plan-rest", k3PlanForLabel(sheet.planForCount), true, i === 0);
      if (name === "openExisting") return button(sheet.planCase.withPlans.length === 1 ? "open-existing" : "choose-existing", "Open an existing plan", false, i === 0, sheet.planCase.withPlans.length === 1 ? ` data-plan-id="${escapeAttr(sheet.planCase.withPlans[0].planId)}"` : "");
      if (name === "openPlan") return button("open-plan", "Open the plan", true, i === 0);
      if (name === "continue") return button("continue", "Continue", true, i === 0);
      if (name === "close") return button("close", "Close", false, i === 0);
      return button("cancel", "Cancel", false, i === 0);
    }).join("");
    body = `<p class="k3-sheet-text">${escapeHtml(sheet.text)}</p>
      <div class="k3-sheet-actions">${buttons}</div>
      ${sheet.note ? `<p class="k3-sheet-note">${escapeHtml(sheet.note)}</p>` : ""}`;
  }
  return `<div class="k3-sheet-layer">
      <button type="button" class="k3-sheet-backdrop" data-action="central-calendar-k3" data-k3="cancel" aria-label="Cancel" tabindex="-1"></button>
      <div class="k3-sheet" role="dialog" aria-modal="true" aria-labelledby="k3SheetTitle"${busy ? ' aria-busy="true"' : ""}>
        <h3 class="k3-sheet-title" id="k3SheetTitle">${escapeHtml(title)}</h3>
        ${body}
        ${k3.error ? `<p class="k3-error" role="alert">${escapeHtml(k3.error)}</p>` : ""}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// The Builder (2.3 - 2.5).
// ---------------------------------------------------------------------------
function typeColor(context) {
  const index = calendarColorIndex(context.eventTypeColorKey);
  return index < 0 ? "" : ` style="--k3-color: var(--cc-team-${index})"`;
}

function typeIcon(context, size = 16) {
  const key = isLibraryKey(context.eventTypeIconKey) ? context.eventTypeIconKey : CENTRAL_CALENDAR_EVENT_KIND_ICONS[context.eventKind] || "run";
  return renderIconSvg(key, { size, className: "k3-type-icon" });
}

export function renderK3BandHtml(context) {
  if (!context) return "";
  const range = k3EventRangeText(context);
  const s = (n) => `${n} ${n === 1 ? "athlete" : "athletes"}`;
  const meta = [range, context.placeName, s(context.athleteCount)].filter(Boolean).join(" · ");
  const back = context.saving && !context.saved ? "Saving and linking…" : "Back to calendar";
  return `<section class="k3-band" role="region" aria-label="${escapeAttr(`Planning for event ${context.title}`)}"${typeColor(context)}>
      <div class="k3-band-text">
        <p class="k3-band-title">${typeIcon(context)}<strong>${escapeHtml(context.title)}</strong><span class="k3-band-meta">${escapeHtml([k3EventLabel(context).split(" · ").pop(), meta].filter(Boolean).join(" · "))}</span></p>
        <p class="k3-band-line">Sessions on this day go into this event.${context.clubPlan ? " This plan belongs to the club." : ""}</p>
      </div>
      <button type="button" class="plain-button k3-band-back" data-action="builder-k3-back"${context.saving ? " disabled" : ""}>${ICON_BACK}<span>${escapeHtml(back)}</span></button>
    </section>`;
}

// The event's day (2.3): a mark beside the day's name.
export function renderK3DayMarkHtml(context, block) {
  if (!k3BlockInEvent(context, block)) return "";
  return `<span class="k3-day-mark"${typeColor(context)}><span class="k3-dot" aria-hidden="true"></span>In this event</span>`;
}

// A session's chip (2.4): In this event / Not in this event · Put back /
// Outside the event (PM), and its time "10:00 · from the event".
export function renderK3SessionHtml(context, block, session) {
  const st = k3SessionState(context, block, session);
  if (!st) return "";
  const event = k3EventShape(context);
  const time = !session.time && st.state === "in" ? k3SessionTimeText(session, event) : "";
  const timeHtml = time ? `<span class="k3-session-time">${escapeHtml(time)}</span>` : "";
  const name = String(session.name || "").trim() || "this session";
  if (st.state === "outside") {
    return `<span class="k3-session">${timeHtml}<span class="k3-chip is-outside">Outside the event (${escapeHtml(st.amPm)})</span></span>`;
  }
  if (st.state === "out") {
    return `<span class="k3-session"><span class="k3-chip is-out"><span class="k3-ring" aria-hidden="true"></span>Not in this event</span><button type="button" class="text-action k3-put-back" data-action="builder-k3-toggle-session" data-k3-key="${escapeAttr(st.key)}" aria-label="${escapeAttr(`Put ${name} back in the event`)}">Put back</button></span>`;
  }
  const mark = k3SessionTimeMark(context, block, session);
  const markHtml = mark ? `<span class="k3-chip is-warning">${ICON_CLOCK}Outside the event's time</span>` : "";
  return `<span class="k3-session">${timeHtml}${markHtml}<button type="button" class="k3-chip is-in" data-action="builder-k3-toggle-session" data-k3-key="${escapeAttr(st.key)}" aria-pressed="true" aria-label="${escapeAttr(`${name}: in this event. Take it out`)}"${typeColor(context)}><span class="k3-dot" aria-hidden="true"></span>In this event</button></span>`;
}

// A message under a session row: the O14 refusals (its own time).
export function renderK3SessionNoteHtml(context, block, session) {
  if (!context) return "";
  if (context.timeMessage?.sessionId === session.id) {
    return `<p class="k3-note is-warning" role="alert">${ICON_CLOCK}<span>${escapeHtml(context.timeMessage.text)}</span></p>`;
  }
  if (context.blocker?.sessionId === session.id) {
    return `<div class="k3-note is-warning" role="alert">${ICON_CLOCK}<span>${escapeHtml(context.blocker.text)}</span>
        <button type="button" class="plain-button k3-note-button" data-action="builder-k3-use-event-time" data-session-id="${escapeAttr(session.id)}">Use the event's time</button>
        <button type="button" class="plain-button k3-note-button" data-action="builder-k3-dismiss-blocker">Cancel</button></div>`;
  }
  const mark = k3SessionTimeMark(context, block, session);
  if (mark) {
    const range = mark.to ? `${mark.from}–${mark.to}` : `from ${mark.from}`;
    return `<div class="k3-note is-warning">${ICON_WARN}<span>${escapeHtml(`Outside the event's time (${range})`)}</span>
        <button type="button" class="plain-button k3-note-button" data-action="builder-k3-use-event-time" data-session-id="${escapeAttr(session.id)}">Use the event's time</button></div>`;
  }
  return "";
}

// The bar where the check button was (2.5): its line and *Save and link*.
export function renderK3SaveBarHtml(context, draft) {
  if (!context || context.saved || !draft || draft.plan?.status !== "draft") return "";
  const busy = context.saving;
  return `<div class="k3-save-bar" role="group" aria-label="Save and link">
      <p class="k3-save-line">${escapeHtml(k3SaveSummary(context, draft))}</p>
      <button type="button" class="plain-button cc-primary k3-save-button" data-action="builder-k3-save-link"${busy ? ' disabled aria-busy="true"' : ""}>${ICON_CHECK}<span>${busy ? "Saving and linking…" : "Save and link"}</span></button>
    </div>`;
}

const ACTION_BUTTONS = {
  backToCalendar: (primary) => `<button type="button" class="plain-button${primary ? " cc-primary" : ""} k3-outcome-button" data-action="builder-k3-back">${primary ? ICON_BACK : ""}<span>Back to calendar</span></button>`,
  keepEditing: () => `<button type="button" class="plain-button k3-outcome-button" data-action="builder-k3-keep-editing">Keep editing</button>`,
  checkResult: () => `<button type="button" class="plain-button k3-outcome-button" data-action="builder-k3-check-result">Check result</button>`,
  tryLinking: () => `<button type="button" class="plain-button k3-outcome-button" data-action="builder-k3-try-linking">Try linking again</button>`,
  tryAgain: () => `<button type="button" class="plain-button k3-outcome-button" data-action="builder-k3-save-link">Try again</button>`,
};

// The outcome (2.5): one sentence, one next step; never "linked" without a
// confirmed answer.
export function renderK3OutcomeHtml(context) {
  const outcome = context?.outcome;
  if (!outcome) return "";
  const busy = context.saving;
  const glyph = outcome.tone === "ok" ? ICON_CHECK : outcome.tone === "busy" ? "" : ICON_WARN;
  const actions = busy ? "" : (outcome.actions || []).map((name, i) => ACTION_BUTTONS[name]?.(i === 0 && name === "backToCalendar") || "").join("");
  return `<div class="k3-outcome is-${escapeAttr(outcome.tone || "ok")}" role="${outcome.tone === "ok" || outcome.tone === "busy" ? "status" : "alert"}" tabindex="-1">
      <p class="k3-outcome-text">${glyph}<span>${escapeHtml(busy && outcome.tone !== "busy" ? "Checking…" : outcome.text)}</span></p>
      ${outcome.note ? `<p class="k3-outcome-note">${escapeHtml(outcome.note)}</p>` : ""}
      ${(outcome.actions || []).includes("keepEditing") && context.athleteCount > 1 && !busy ? `<p class="k3-outcome-note">Keep editing opens the saved plan one athlete at a time.</p>` : ""}
      ${outcome.error ? `<p class="k3-outcome-note" role="alert">${escapeHtml(outcome.error)}</p>` : ""}
      ${actions ? `<div class="k3-outcome-actions">${actions}</div>` : ""}
    </div>`;
}

// After a save the plan is published and its draft is gone: the band and the
// outcome only (screen 01 step 3).
export function renderK3SavedHtml(context) {
  return `<section class="content-section builder-workspace k3-saved">
      ${renderK3BandHtml(context)}
      ${renderK3OutcomeHtml(context)}
    </section>`;
}

// ---------------------------------------------------------------------------
// K2c-3 (6.3; mockup 03): the band over the calendar's own form opened from
// the Builder. Amber, a detour: the event does not exist yet.
// ---------------------------------------------------------------------------
const longDay = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()];
  return `${day} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export function renderK2c3FormBandHtml(form) {
  if (!form?.returnTo) return "";
  const busy = form.busy;
  const after = form.returnTo.sessionName
    ? `After Create event you go back to the Builder, with this event chosen for ${form.returnTo.sessionName}.`
    : "After Create event you go back to the Builder, with this event in the day's row.";
  return `<section class="k3-band k3-band-form" role="region" aria-label="Creating an event for the Builder">
      <div class="k3-band-text">
        <p class="k3-band-title">${ICON_LIST}<strong>Creating an event for the Builder</strong><span class="k3-band-meta">${escapeHtml(longDay(form.returnTo.day))}</span></p>
        <p class="k3-band-line">${escapeHtml(after)}</p>
      </div>
      <button type="button" class="plain-button k3-band-back" data-action="central-calendar-back-to-builder"${busy ? " disabled" : ""}>${ICON_BACK}<span>Back to the Builder</span></button>
    </section>`;
}

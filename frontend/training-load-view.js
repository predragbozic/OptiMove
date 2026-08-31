import { state } from "./state.js";
import { escapeAttr, escapeHtml, formatDate, formatDayMonth, formatWeekday, initialsFor, localDateIso, localDateIsoInTimeZone, localMonthIsoInTimeZone } from "./utils.js";
import { ICON_CHECK, ICON_X } from "./builder-structure.js";

// Training load (RPE/sRPE), first complete phase. Deliberately its own
// visual language - white surfaces, neutral gray borders, dark text, muted
// secondary text, the accent color reserved for small indicators/focus/
// status only. Never the Tests module's green-heavy calendar CSS, and
// never state.tests - see training-load-data.js's own header comment.

const RPE_ANCHORS = [
  { at: 0, label: "Rest" },
  { at: 2, label: "Light" },
  { at: 4, label: "Moderate" },
  { at: 6, label: "Hard" },
  { at: 8, label: "Very hard" },
  { at: 10, label: "Max effort" },
];

function rpeDescriptor(rpe) {
  let best = RPE_ANCHORS[0];
  for (const anchor of RPE_ANCHORS) if (rpe >= anchor.at) best = anchor;
  return best.label;
}

export function formatSrpe(srpe) {
  return `${srpe} AU`;
}

// "RPE 7 - 60 min - sRPE 420 AU" - the exact compact summary format
// required both post-submission on a session and in the Results list.
export function formatFeedbackSummary(feedback) {
  if (!feedback) return "";
  return `RPE ${feedback.rpe} · ${feedback.durationMinutes} min · sRPE ${formatSrpe(feedback.srpe)}`;
}

function sessionLabel(session) {
  const parts = [];
  if (session.sessionName) parts.push(session.sessionName);
  if (session.amPm) parts.push(session.amPm);
  if (session.bta) parts.push(session.bta);
  return parts.length ? parts.join(" · ") : "Training session";
}

// A session/assignment's own click-target id - the two sources are
// mutually exclusive (see the XOR identity on training_load.
// session_feedback), so exactly one of these is ever populated.
function sessionRowId(session) {
  return session.sessionId || session.externalAssignmentId || "";
}

// "OUTSIDE PLAN" - a small, neutral tag (no color-coding beyond the
// existing status-pill convention) distinguishing a session scheduled
// outside any Weekly plan from a planned one, wherever the two can appear
// side by side.
function renderOutsidePlanTagHtml(session) {
  return session.source === "scheduled_external" ? `<span class="training-load-outside-plan-tag">Outside plan</span>` : "";
}

// ------------------------------------------------------------
// Athlete Home card ("Session feedback", shown above/alongside Today's
// training - mirrors the exact same "count === 0 renders nothing" /
// "count === 1 deep-links" / "count > 1 opens a list" shape Home's own
// WELLNESS card already established, kept fully independent of it).
// ------------------------------------------------------------

// Composes whichever athlete-side overlay (if any) is currently open - the
// RPE form takes priority (it can be opened while the weekly overlay or
// the "more than one session" list is also open, and must render on top
// of either), then the weekly overlay, then the list. `position: fixed`
// styling means it doesn't matter where in the DOM tree this lands.
export function renderTrainingLoadAthleteOverlaysHtml() {
  if (state.trainingLoad.rpeForm) return renderRpeFormHtml(state.trainingLoad.rpeForm);
  if (state.trainingLoad.athleteWeeklyOpen) return renderTrainingLoadAthleteWeeklyHtml();
  if (state.trainingLoad.showSessionList) return renderTrainingLoadSessionListHtml(state.trainingLoad.athleteToday);
  return "";
}

export function renderTrainingLoadHomeCardHtml(athleteToday) {
  const sessions = athleteToday?.sessions || [];
  const unrated = sessions.filter((s) => !s.rated);
  if (!unrated.length) return "";
  const multiple = unrated.length > 1;
  return `
    <button type="button" class="panel training-load-home-card" data-action="training-load-home-card-open" data-count="${unrated.length}" data-session-id="${escapeAttr(unrated[0] ? sessionRowId(unrated[0]) : "")}">
      <div class="training-load-home-card-body">
        <p class="eyebrow">Session feedback</p>
        <p class="muted">${multiple ? `${unrated.length} sessions waiting for RPE` : `Rate today's session: ${escapeHtml(sessionLabel(unrated[0]))}`}</p>
      </div>
      <span class="training-load-home-card-cta">${multiple ? "View all" : "Rate session"} &rsaquo;</span>
    </button>
  `;
}

// Item 4 correction: a permanent, always-visible link to the athlete's own
// weekly training-load overlay - unlike the Home card above (which only
// ever reflects TODAY's own unrated count and disappears entirely once
// that's zero), this stays reachable regardless, so a not-yet-rated
// session from yesterday or earlier always has a real UI path.
export function renderTrainingLoadWeekLinkHtml() {
  return `
    <button type="button" class="training-load-week-link" data-action="training-load-athlete-weekly-open">
      This week's training load &rsaquo;
    </button>
  `;
}

// The "more than one session waiting" list - opened from the Home card,
// each row deep-links straight into the RPE form for that one session. A
// rated row is a plain, non-clickable summary (never re-opens a blank
// form that would only end in a 409 - see training-load-actions.js's own
// openRpeFormForSessionId guard, this is the matching render-side gate).
export function renderTrainingLoadSessionListHtml(athleteToday) {
  const sessions = athleteToday?.sessions || [];
  return `
    <div class="training-load-overlay">
      <button class="training-load-overlay-backdrop" type="button" data-action="training-load-close-list" aria-label="Close"></button>
      <section class="panel training-load-list-panel" role="dialog" aria-modal="true" aria-label="Today's sessions">
        <div class="training-load-list-head">
          <h3>Today's sessions</h3>
          <button class="plain-button icon-button" type="button" data-action="training-load-close-list" aria-label="Close">&times;</button>
        </div>
        <div class="training-load-list-rows">
          ${sessions.map((session) => renderAthleteSessionRowHtml(session)).join("")}
        </div>
      </section>
    </div>
  `;
}

function renderAthleteSessionRowHtml(session) {
  if (session.rated) {
    return `
      <div class="training-load-list-row is-rated">
        <span class="training-load-list-row-name">${escapeHtml(sessionLabel(session))}${renderOutsidePlanTagHtml(session)}</span>
        <span class="training-load-status-pill training-load-status-rated">${escapeHtml(formatFeedbackSummary(session.feedback))}</span>
      </div>
    `;
  }
  return `
    <button type="button" class="training-load-list-row" data-action="training-load-open-rpe-form" data-session-id="${escapeAttr(sessionRowId(session))}">
      <span class="training-load-list-row-name">${escapeHtml(sessionLabel(session))}${renderOutsidePlanTagHtml(session)}</span>
      <span class="training-load-status-pill training-load-status-unrated">Rate session &rsaquo;</span>
    </button>
  `;
}

// ------------------------------------------------------------
// Athlete: "This week" weekly overlay (item 4 correction) - a single
// weekly nav (no Today/Schedule/Results sub-tabs - those are coach
// concepts), same Prev/Next/Today/7-day-strip behavior as the coach side,
// its own markup. Today or an earlier day's session opens the RPE form
// (or shows its rated summary); a future day's sessions are always
// disabled - the backend independently enforces this too (a future-dated
// session 400s), this is just the UI never offering it in the first place.
// ------------------------------------------------------------

export function renderTrainingLoadAthleteWeeklyHtml() {
  const nav = state.trainingLoad.athleteWeekly;
  const todayIso = localDateIso();
  return `
    <div class="training-load-overlay">
      <button class="training-load-overlay-backdrop" type="button" data-action="training-load-athlete-weekly-close" aria-label="Close"></button>
      <section class="panel training-load-athlete-weekly-panel" role="dialog" aria-modal="true" aria-label="This week's training load">
        <div class="training-load-list-head">
          <h3>This week's training load</h3>
          <button class="plain-button icon-button" type="button" data-action="training-load-athlete-weekly-close" aria-label="Close">&times;</button>
        </div>
        ${nav.loading && !nav.data ? `<p class="muted training-load-empty">Loading...</p>` : ""}
        ${nav.error ? `<p class="builder-error">${escapeHtml(nav.error)}</p>` : ""}
        ${nav.data ? renderAthleteWeeklyShellHtml(nav, todayIso) : ""}
      </section>
    </div>
  `;
}

function renderAthleteWeeklyShellHtml(nav, todayIso) {
  const selectedDay = nav.data.days.find((d) => d.date === nav.selectedDate) || nav.data.days[0];
  return `
    <div class="training-load-weekly">
      <div class="training-load-weekly-nav">
        <button type="button" class="plain-button icon-button training-load-weekly-arrow" data-action="training-load-athlete-weekly-prev-week" aria-label="Previous week">&larr;</button>
        <div class="training-load-weekly-range">
          <strong>${escapeHtml(formatDate(nav.data.weekStart))} - ${escapeHtml(formatDate(nav.data.weekEnd))}</strong>
          <button type="button" class="plain-button compact-button training-load-weekly-today-button" data-action="training-load-athlete-weekly-today">Today</button>
        </div>
        <button type="button" class="plain-button icon-button training-load-weekly-arrow" data-action="training-load-athlete-weekly-next-week" aria-label="Next week">&rarr;</button>
      </div>
      <div class="training-load-weekly-strip" role="tablist" aria-label="Select a day">
        ${nav.data.days.map((day) => {
          const isSelected = day.date === selectedDay?.date;
          const isToday = day.date === todayIso;
          const dayNumber = Number(day.date.slice(8, 10));
          const count = day.sessions.length;
          return `
            <button type="button" class="training-load-weekly-day ${isSelected ? "is-selected" : ""} ${isToday ? "is-today" : ""}" role="tab" aria-selected="${isSelected ? "true" : "false"}" data-action="training-load-athlete-weekly-select-day" data-date="${escapeAttr(day.date)}">
              <span class="training-load-weekly-day-name">${escapeHtml(formatWeekday(day.date))}</span>
              <span class="training-load-weekly-day-number">${dayNumber}</span>
              ${count ? `<span class="training-load-weekly-day-count" aria-hidden="true">${count}</span>` : ""}
            </button>
          `;
        }).join("")}
      </div>
      <div class="training-load-weekly-agenda">
        ${selectedDay && selectedDay.sessions.length
          ? selectedDay.sessions.map((session) => renderAthleteWeeklySessionRowHtml(session, selectedDay.date, todayIso)).join("")
          : `<p class="muted training-load-empty">No training sessions this day.</p>`}
      </div>
    </div>
  `;
}

function renderAthleteWeeklySessionRowHtml(session, date, todayIso) {
  // Future is always disabled (the backend independently enforces this
  // too - see this file's own header comment). A rated session shows its
  // summary but is never clickable again (see renderAthleteSessionRowHtml's
  // own comment on why).
  const isFuture = date > todayIso;
  if (session.rated) {
    return `
      <div class="training-load-session-row">
        <span class="training-load-session-time">${escapeHtml((session.sessionTime || "").slice(0, 5))}</span>
        <span class="training-load-session-main">
          <span class="training-load-session-name">${escapeHtml(sessionLabel(session))}${renderOutsidePlanTagHtml(session)}</span>
        </span>
        <span class="training-load-status-pill training-load-status-rated">${escapeHtml(formatFeedbackSummary(session.feedback))}</span>
      </div>
    `;
  }
  if (isFuture) {
    return `
      <div class="training-load-session-row" aria-disabled="true">
        <span class="training-load-session-time">${escapeHtml((session.sessionTime || "").slice(0, 5))}</span>
        <span class="training-load-session-main">
          <span class="training-load-session-name">${escapeHtml(sessionLabel(session))}</span>
        </span>
        <span class="training-load-status-pill training-load-status-unrated">Not yet</span>
      </div>
    `;
  }
  return `
    <button type="button" class="training-load-session-row is-clickable" data-action="training-load-open-rpe-form" data-session-id="${escapeAttr(sessionRowId(session))}">
      <span class="training-load-session-time">${escapeHtml((session.sessionTime || "").slice(0, 5))}</span>
      <span class="training-load-session-main">
        <span class="training-load-session-name">${escapeHtml(sessionLabel(session))}${renderOutsidePlanTagHtml(session)}</span>
      </span>
      <span class="training-load-status-pill training-load-status-unrated">Rate session &rsaquo;</span>
    </button>
  `;
}

// ------------------------------------------------------------
// RPE entry form - compact: a discrete 0-10 slider with a clearly shown
// value + anchor descriptor (never 11 giant buttons), a small number
// input for actual duration, a live sRPE preview, and a save button with
// its own loading/double-submit guard.
// ------------------------------------------------------------

export function renderRpeFormHtml(form) {
  if (!form) return "";
  const durationNumber = Number(form.durationMinutes);
  const livePreview = form.durationMinutes !== "" && Number.isFinite(durationNumber) && durationNumber > 0
    ? form.rpe * durationNumber
    : null;
  if (form.savedFeedback) {
    return `
      <div class="training-load-overlay">
        <button class="training-load-overlay-backdrop" type="button" data-action="training-load-close-rpe-form" aria-label="Close"></button>
        <section class="panel training-load-rpe-panel" role="dialog" aria-modal="true" aria-label="Session rated">
          <p class="eyebrow">Saved</p>
          <h3>${escapeHtml(formatFeedbackSummary(form.savedFeedback))}</h3>
          <p class="muted">${escapeHtml(sessionLabel(form))}${form.date ? ` · ${escapeHtml(formatDate(form.date))}` : ""}</p>
          <button type="button" class="plain-button compact-button" data-action="training-load-close-rpe-form">Done</button>
        </section>
      </div>
    `;
  }
  return `
    <div class="training-load-overlay">
      <button class="training-load-overlay-backdrop" type="button" data-action="training-load-close-rpe-form" aria-label="Close"></button>
      <section class="panel training-load-rpe-panel" role="dialog" aria-modal="true" aria-label="Rate session">
        <div class="training-load-rpe-head">
          <div>
            <p class="eyebrow">Rate session</p>
            <h3>${escapeHtml(sessionLabel(form))}${renderOutsidePlanTagHtml(form)}</h3>
            ${form.date ? `<p class="muted">${escapeHtml(formatDate(form.date))}</p>` : ""}
          </div>
          <button class="plain-button icon-button" type="button" data-action="training-load-close-rpe-form" aria-label="Cancel">&times;</button>
        </div>

        <div class="training-load-rpe-slider-block" data-training-load-slider-block>
          ${renderRpeSliderInnerHtml(form)}
        </div>

        <label class="training-load-rpe-duration-label">
          Actual duration (minutes)
          <input type="number" inputmode="numeric" min="1" max="600" step="1" class="training-load-rpe-duration-input" data-action="training-load-rpe-duration-input" value="${escapeAttr(form.durationMinutes)}" placeholder="e.g. 60">
        </label>

        <p class="training-load-rpe-srpe-preview" data-training-load-srpe-preview>${livePreview != null ? `sRPE preview: <strong>${escapeHtml(formatSrpe(livePreview))}</strong>` : "sRPE preview: enter a duration"}</p>

        <label class="training-load-rpe-note-label">
          Note <span class="muted">(optional)</span>
          <textarea class="training-load-rpe-note-input" data-action="training-load-rpe-note-input" maxlength="500" rows="2" placeholder="How did it feel?">${escapeHtml(form.note)}</textarea>
        </label>

        ${form.error ? `<p class="builder-error">${escapeHtml(form.error)}</p>` : ""}

        <div class="training-load-rpe-actions">
          <button type="button" class="plain-button compact-button" data-action="training-load-close-rpe-form" ${form.saving ? "disabled" : ""}>Cancel</button>
          <button type="button" class="plain-button compact-button training-load-rpe-save" data-action="training-load-rpe-submit" ${form.saving || !isRpeFormValid(form) ? "disabled" : ""}>${form.saving ? "Saving..." : "Save"}</button>
        </div>
      </section>
    </div>
  `;
}

export function isRpeFormValid(form) {
  const duration = Number(form.durationMinutes);
  return Number.isInteger(form.rpe) && form.rpe >= 0 && form.rpe <= 10
    && form.durationMinutes !== "" && Number.isInteger(duration) && duration >= 1 && duration <= 600;
}

// Targeted-patch inner markup for the slider block, so dragging it never
// re-renders the whole form (losing slider focus/drag state) - mirrors
// this app's existing convention for continuous-input controls (see
// tests-actions.js's own slider-drag handling).
export function renderRpeSliderInnerHtml(form) {
  return `
    <div class="training-load-rpe-slider-value">
      <span class="training-load-rpe-slider-number">${form.rpe}</span>
      <span class="training-load-rpe-slider-descriptor">${escapeHtml(rpeDescriptor(form.rpe))}</span>
    </div>
    <input type="range" min="0" max="10" step="1" value="${form.rpe}" class="training-load-rpe-slider" data-action="training-load-rpe-slider-input" aria-label="RPE (0 to 10)" aria-valuenow="${form.rpe}" aria-valuetext="${escapeAttr(`${form.rpe} - ${rpeDescriptor(form.rpe)}`)}">
    <div class="training-load-rpe-slider-anchors">
      <span>0 Rest</span>
      <span>5 Moderate</span>
      <span>10 Max</span>
    </div>
  `;
}

// ------------------------------------------------------------
// Coach: "Training load" tab - Today / Schedule / Results, same
// organizational shape as the Tests weekly calendar (Prev/Next/Today, a
// 7-day strip, a selected-day agenda) but its OWN markup/classes - never
// tests-view.js's renderWeeklyShellHtml or its CSS.
// ------------------------------------------------------------

function trainingLoadTodayIso() {
  return localDateIso();
}

function formatWeekRangeLabel(weekStart, weekEnd) {
  return `${formatDate(weekStart)} - ${formatDate(weekEnd)}`;
}

function renderTrainingLoadWeeklyShellHtml({ section, days, weekStart, weekEnd, selectedDate, renderSessionRow, emptyAgendaText, agendaHeaderExtra = "" }) {
  const todayIso = trainingLoadTodayIso();
  const selectedDay = days.find((d) => d.date === selectedDate) || days[0];
  return `
    <div class="training-load-weekly">
      <div class="training-load-weekly-nav">
        <button type="button" class="plain-button icon-button training-load-weekly-arrow" data-action="training-load-weekly-prev-week" data-section="${section}" aria-label="Previous week">&larr;</button>
        <div class="training-load-weekly-range">
          <strong>${escapeHtml(formatWeekRangeLabel(weekStart, weekEnd))}</strong>
          <button type="button" class="plain-button compact-button training-load-weekly-today-button" data-action="training-load-weekly-today" data-section="${section}">Today</button>
        </div>
        <button type="button" class="plain-button icon-button training-load-weekly-arrow" data-action="training-load-weekly-next-week" data-section="${section}" aria-label="Next week">&rarr;</button>
      </div>
      <div class="training-load-weekly-strip" role="tablist" aria-label="Select a day">
        ${days.map((day) => renderTrainingLoadStripDayHtml(section, day, day.date === selectedDay?.date, todayIso)).join("")}
      </div>
      <div class="training-load-weekly-agenda">
        ${agendaHeaderExtra}
        ${selectedDay && selectedDay.sessions.length
          ? selectedDay.sessions.map((session) => renderSessionRow(session, selectedDay.date)).join("")
          : `<p class="muted training-load-empty">${escapeHtml(emptyAgendaText)}</p>`}
      </div>
    </div>
  `;
}

function renderTrainingLoadStripDayHtml(section, day, isSelected, todayIso) {
  const isToday = day.date === todayIso;
  const dayNumber = Number(day.date.slice(8, 10));
  const count = day.sessions.length;
  return `
    <button type="button" class="training-load-weekly-day ${isSelected ? "is-selected" : ""} ${isToday ? "is-today" : ""}" role="tab" aria-selected="${isSelected ? "true" : "false"}" data-action="training-load-weekly-select-day" data-section="${section}" data-date="${escapeAttr(day.date)}" aria-label="${escapeAttr(formatWeekday(day.date))} ${dayNumber}${count ? `, ${count} session${count === 1 ? "" : "s"}` : ""}">
      <span class="training-load-weekly-day-name">${escapeHtml(formatWeekday(day.date))}</span>
      <span class="training-load-weekly-day-number">${dayNumber}</span>
      ${count ? `<span class="training-load-weekly-day-count" aria-hidden="true">${count}</span>` : ""}
    </button>
  `;
}

// Today groups every OUTSIDE PLAN row sharing the same scheduleId+date into
// ONE clickable summary row (rated/total, total sRPE) - "clicking an active
// external session opens per-athlete status + manual-reminder UI" only
// makes sense read this way (a planned Weekly-plan session has no such
// grouping concept - each row there is already its own one-athlete unit,
// rendered unchanged). Grouping is computed fresh on every render straight
// from the already-loaded weekly payload, never cached, so a reminder send
// or a fresh rating is reflected the instant Today re-fetches.
function groupSessionsForToday(sessions) {
  const groups = new Map();
  const result = [];
  for (const s of sessions) {
    if (s.source !== "scheduled_external") {
      result.push(s);
      continue;
    }
    // GET /weekly (coach branch) returns every external row regardless of
    // schedule/assignment status, unfiltered - Schedule needs that for
    // management. Today must not present a paused/cancelled row that was
    // never rated as if it were a real pending request - explicit
    // `actionable`/`rated` fields decide this, never row presence alone.
    if (!s.rated && !s.actionable) continue;
    let group = groups.get(s.scheduleId);
    if (!group) {
      group = { __externalGroup: true, scheduleId: s.scheduleId, eventName: s.sessionName, sessionTime: s.sessionTime, sessions: [] };
      groups.set(s.scheduleId, group);
      result.push(group);
    }
    group.sessions.push(s);
  }
  return result;
}

function renderExternalGroupRowHtml(group, date) {
  const rated = group.sessions.filter((s) => s.rated);
  const totalSrpe = rated.reduce((sum, s) => sum + s.feedback.srpe, 0);
  const allRated = rated.length === group.sessions.length;
  return `
    <button type="button" class="training-load-session-row is-clickable" data-action="training-load-open-external-group" data-schedule-id="${escapeAttr(group.scheduleId)}" data-date="${escapeAttr(date)}">
      <span class="training-load-session-time">${escapeHtml((group.sessionTime || "").slice(0, 5))}</span>
      <span class="training-load-session-main">
        <span class="training-load-session-name">${escapeHtml(group.eventName)}${renderOutsidePlanTagHtml({ source: "scheduled_external" })}</span>
        <span class="training-load-session-subtitle">${rated.length}/${group.sessions.length} rated${totalSrpe ? ` · ${escapeHtml(formatSrpe(totalSrpe))}` : ""}</span>
      </span>
      <span class="training-load-status-pill training-load-status-${allRated ? "rated" : "unrated"}">${rated.length}/${group.sessions.length}</span>
    </button>
  `;
}

// A disabled+unrated session, OR one whose governing workspace(s)
// currently have automatic planned RPE off (v9), was never actually a
// rating request in the first place - each of the two OFF reasons gets
// its own distinct, informational (never pending) label, so a row is
// never left looking actionable while the master switch is off but
// LOOKING like a normal "session-level off" the coach could just
// individually flip back on.
function plannedStatusLabel(session) {
  if (session.rated) return { label: formatFeedbackSummary(session.feedback), cls: "rated" };
  if (session.rpeEnabled === false) return { label: "RPE off", cls: "off" };
  if (session.workspacePlannedRpeEnabled === false) return { label: "Automatic RPE off", cls: "off" };
  return { label: "Not rated", cls: "unrated" };
}

function renderCoachSessionRowHtml(session, date) {
  if (session.__externalGroup) return renderExternalGroupRowHtml(session, date);
  const status = plannedStatusLabel(session);
  return `
    <div class="training-load-session-row">
      <span class="training-load-session-time">${escapeHtml((session.sessionTime || "").slice(0, 5))}</span>
      <span class="training-load-session-main">
        <span class="training-load-session-name">${escapeHtml(session.athleteName)}${renderOutsidePlanTagHtml(session)}</span>
        <span class="training-load-session-subtitle">${escapeHtml(sessionLabel(session))}${session.historical ? " · from a since-changed plan" : ""}</span>
      </span>
      <span class="training-load-status-pill training-load-status-${status.cls}">${escapeHtml(status.label)}</span>
    </div>
  `;
}

export function renderTrainingLoadTodayHtml() {
  const nav = state.trainingLoad.weekly.today;
  if (nav.loading && !nav.data) return `<p class="muted training-load-empty">Loading training load...</p>`;
  if (nav.error) return `<p class="builder-error">${escapeHtml(nav.error)}</p>`;
  if (!nav.data) return "";
  if (state.trainingLoad.todayGroupDetail) return renderTodayGroupDetailHtml();
  return renderTrainingLoadWeeklyShellHtml({
    section: "today",
    days: nav.data.days.map((day) => ({ ...day, sessions: groupSessionsForToday(day.sessions) })),
    weekStart: nav.data.weekStart,
    weekEnd: nav.data.weekEnd,
    selectedDate: nav.selectedDate,
    emptyAgendaText: "No training sessions this day.",
    renderSessionRow: renderCoachSessionRowHtml,
  });
}

// Schedule: a read-only projection of training sessions from active
// Weekly plans - a click opens the EXISTING Weekly plan/session view
// (data-action="training-load-open-weekly-plan"), never a separate RPE-
// specific schedule screen. A historical (session-deleted) row has no
// live session left to open, so it renders as a plain, non-clickable row.
// PLANNED · RPE ON / PLANNED · RPE OFF - "OUTSIDE PLAN" (external
// sessions) is a separate row kind added once external scheduling ships.
function renderScheduleRpeStateBadgeHtml(session) {
  const on = session.rpeEnabled !== false;
  return `<span class="training-load-rpe-state-badge ${on ? "is-on" : "is-off"}">PLANNED &middot; RPE ${on ? "ON" : "OFF"}</span>`;
}

function renderOutsidePlanBadgeHtml() {
  return `<span class="training-load-rpe-state-badge is-outside">OUTSIDE PLAN</span>`;
}

// An external row's own status label - explicit, never re-derived from
// row presence (GET /weekly returns a paused/cancelled row to the coach
// unfiltered now, for management visibility - see that route's own
// comment). A completed result always wins, regardless of what later
// happened to its schedule.
function externalStatusLabel(session) {
  if (session.rated) return { label: formatFeedbackSummary(session.feedback), cls: "rated" };
  if (session.scheduleStatus === "paused") return { label: "Paused", cls: "off" };
  if (session.scheduleStatus === "cancelled") return { label: "Cancelled", cls: "off" };
  if (!session.actionable) return { label: "Not rated", cls: "off" };
  return { label: "Not rated", cls: "unrated" };
}

function renderScheduleSessionRowHtml(session, date) {
  const isExternal = session.source === "scheduled_external";
  const status = isExternal ? externalStatusLabel(session) : plannedStatusLabel(session);
  // A planned row opens the existing Weekly plan view; an OUTSIDE PLAN row
  // opens this schedule's own detail (Edit/Pause/Resume/Cancel/Schedule
  // again) instead - the two click targets are never interchangeable.
  const clickable = isExternal || !session.historical;
  const attrs = isExternal
    ? `type="button" data-action="training-load-open-external-schedule" data-schedule-id="${escapeAttr(session.scheduleId)}"`
    : clickable
      ? `type="button" data-action="training-load-open-weekly-plan" data-athlete-id="${escapeAttr(session.athleteId)}" data-date="${escapeAttr(date)}"`
      : "";
  const Tag = clickable ? "button" : "div";
  const canToggle = !isExternal && clickable && session.sessionId;
  return `
    <div class="training-load-schedule-row">
      <${Tag} class="training-load-session-row ${clickable ? "is-clickable" : ""}" ${attrs}>
        <span class="training-load-session-time">${escapeHtml((session.sessionTime || "").slice(0, 5))}</span>
        <span class="training-load-session-main">
          <span class="training-load-session-name">${escapeHtml(session.athleteName)}</span>
          <span class="training-load-session-subtitle">${escapeHtml(sessionLabel(session))}${session.historical ? " · from a since-changed plan" : ""}</span>
        </span>
        <span class="training-load-status-pill training-load-status-${status.cls}">${escapeHtml(status.label)}</span>
      </${Tag}>
      ${canToggle ? `
        <div class="training-load-schedule-row-toggle">
          ${renderScheduleRpeStateBadgeHtml(session)}
          <button type="button" class="plain-button compact-button" data-action="training-load-toggle-session-rpe" data-session-id="${escapeAttr(session.sessionId)}" data-currently-enabled="${session.rpeEnabled !== false ? "true" : "false"}">
            ${session.rpeEnabled !== false ? "Turn RPE off" : "Turn RPE on"}
          </button>
        </div>
      ` : ""}
      ${isExternal ? `<div class="training-load-schedule-row-toggle">${renderOutsidePlanBadgeHtml()}</div>` : ""}
    </div>
  `;
}

function renderScheduleWeeklyCalendarHtml() {
  const nav = state.trainingLoad.weekly.schedule;
  if (nav.loading && !nav.data) return `<p class="muted training-load-empty">Loading schedule...</p>`;
  if (nav.error) return `<p class="builder-error">${escapeHtml(nav.error)}</p>`;
  if (!nav.data) return "";
  return renderTrainingLoadWeeklyShellHtml({
    section: "schedule",
    days: nav.data.days,
    weekStart: nav.data.weekStart,
    weekEnd: nav.data.weekEnd,
    selectedDate: nav.selectedDate,
    emptyAgendaText: "No training sessions scheduled this day.",
    renderSessionRow: renderScheduleSessionRowHtml,
  });
}

// (v9) Workspace-level master toggle - compact, no large colored surface
// (matches the existing Notifications switch row this reuses the exact
// CSS classes of - tests-notification-row/-switch/-switch-knob/-row-
// label, already this module's own "compact Training Load control"
// convention). Renders disabled (never clickable) until the real current
// value has actually loaded, so a coach can never flip it against an
// unknown starting state - see this control's own action handler.
export function renderPlannedRpeMasterToggleHtml() {
  const setting = state.trainingLoad.plannedRpeSetting;
  const checked = setting.enabled === true;
  const disabled = setting.saving || !setting.loaded;
  return `
    <div class="training-load-master-toggle">
      <div class="tests-notification-row">
        <button type="button" class="tests-notification-switch ${checked ? "is-on" : ""}" role="switch" aria-checked="${checked ? "true" : "false"}" aria-label="Automatically collect RPE for planned sessions" data-action="training-load-toggle-planned-rpe-master" ${disabled ? "disabled" : ""}>
          <span class="tests-notification-switch-knob" aria-hidden="true"></span>
        </button>
        <span class="tests-notification-row-label">
          Automatically collect RPE for planned sessions
          <span class="muted training-load-master-toggle-hint">Request RPE after sessions created in the Weekly Plan. Individual sessions can still be turned off.</span>
        </span>
      </div>
      ${setting.error ? `<p class="builder-error">${escapeHtml(setting.error)}</p>` : ""}
      ${setting.loaded && !checked ? `<p class="muted training-load-master-toggle-off-note">Automatic planned RPE is off</p>` : ""}
    </div>
  `;
}

export function renderTrainingLoadScheduleHtml() {
  const overlayOpen = Boolean(state.trainingLoad.scheduleForm || state.trainingLoad.scheduleDetail);
  return `
    ${!overlayOpen ? renderPlannedRpeMasterToggleHtml() : ""}
    <div class="training-load-schedule-toolbar">
      <button type="button" class="plain-button" data-action="training-load-open-schedule-form">New RPE session</button>
    </div>
    ${state.trainingLoad.scheduleForm ? renderExternalScheduleFormHtml() : ""}
    ${!state.trainingLoad.scheduleForm && state.trainingLoad.scheduleDetail ? renderExternalScheduleDetailHtml() : ""}
    ${!state.trainingLoad.scheduleForm && !state.trainingLoad.scheduleDetail ? renderScheduleWeeklyCalendarHtml() : ""}
  `;
}

// Results: only SUBMITTED entries - computed entirely client-side from the
// same weekly payload (no extra aggregate endpoint - see backend/src/
// routes/trainingLoad.js's own header comment on why one weekly GET is
// enough). No new charting library - the 7-day load bar is plain CSS.
function computeWeeklyAggregates(data) {
  const allSessions = data.days.flatMap((day) => day.sessions);
  const rated = allSessions.filter((s) => s.rated);
  const totalSrpe = rated.reduce((sum, s) => sum + s.feedback.srpe, 0);
  const totalDuration = rated.reduce((sum, s) => sum + s.feedback.durationMinutes, 0);
  const avgRpe = rated.length ? rated.reduce((sum, s) => sum + s.feedback.rpe, 0) / rated.length : null;
  const dailySrpe = data.days.map((day) => ({
    date: day.date,
    srpe: day.sessions.filter((s) => s.rated).reduce((sum, s) => sum + s.feedback.srpe, 0),
  }));
  // Per-session RPE opt-out, AND (v9) the workspace-level master toggle -
  // a disabled session, or one whose governing workspace(s) currently
  // have automatic planned RPE off, was never actually asking to be
  // rated, so it must never count toward the "rated/planned" completion
  // denominator. One that already has a result still counts - it's
  // already in `rated` above either way. Same rule for a paused/
  // cancelled external row that was never rated - GET /weekly returns it
  // to the coach unfiltered (Schedule needs it for management), but it
  // was never a real pending request. Both sources now carry their own
  // real, backend-computed `actionable` field (never re-derived here),
  // so this is a single uniform check across planned and external rows.
  const countedTowardPlanned = allSessions.filter((s) => s.rated || s.actionable);
  return { totalSrpe, totalDuration, avgRpe, ratedCount: rated.length, plannedCount: countedTowardPlanned.length, dailySrpe };
}

function renderTrainingLoadBarChartHtml(dailySrpe) {
  const max = Math.max(1, ...dailySrpe.map((d) => d.srpe));
  return `
    <div class="training-load-bar-chart" role="img" aria-label="Daily training load for the week">
      ${dailySrpe.map((d) => {
        const heightPct = d.srpe ? Math.max(6, Math.round((d.srpe / max) * 100)) : 0;
        return `
          <div class="training-load-bar-col" title="${escapeAttr(formatDayMonth(d.date))}: ${escapeAttr(formatSrpe(d.srpe))}">
            <div class="training-load-bar-track"><div class="training-load-bar-fill" style="height:${heightPct}%"></div></div>
            <span class="training-load-bar-label">${escapeHtml(formatWeekday(d.date).slice(0, 1))}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderResultsSessionRowHtml(session) {
  return `
    <div class="training-load-session-row">
      <span class="training-load-session-time">${escapeHtml((session.sessionTime || "").slice(0, 5))}</span>
      <span class="training-load-session-main">
        <span class="training-load-session-name">${escapeHtml(session.athleteName)}${renderOutsidePlanTagHtml(session)}</span>
        <span class="training-load-session-subtitle">${escapeHtml(sessionLabel(session))}${session.historical ? " · from a since-changed plan" : ""}</span>
      </span>
      <span class="training-load-status-pill training-load-status-rated">${escapeHtml(formatFeedbackSummary(session.feedback))}</span>
    </div>
  `;
}

// ------------------------------------------------------------
// External (outside-plan) RPE scheduling - "New RPE session" on the
// Schedule tab. Same visual language as the rest of this module (white/
// grey surfaces, neutral borders, the accent color only for a small
// indicator/active state - explicitly NEVER a large green surface), and
// the same Dates/Daily calendar + Builder-style Clubs/Teams/Athletes
// recipient picker shape WELLNESS's own schedule form already established
// (tests-view.js), rebuilt here against this module's own state/actions -
// never importing from tests-view.js/state.tests (see this file's own
// header comment on why the two features stay fully independent).
//
// The calendar here is deliberately click-only (no drag-select) - a real,
// working three-mode picker (multi/range/single, exactly WELLNESS's own
// modes), just without replicating its lower-level mousedown/mouseover/
// mouseup drag-tracking machinery, which the spec never actually required
// ("same calendar picker" as a concept, not byte-for-byte the same
// interaction). Range mode uses a two-click anchor: the first click starts
// a fresh range (start=end=that day), the second confirms start..end
// (sorted) and clears the anchor - the next click after that starts over.
// ------------------------------------------------------------

const EXTERNAL_EVENT_TYPES = [
  { value: "team_training", label: "Team training" },
  { value: "individual", label: "Individual" },
  { value: "gym", label: "Gym" },
  { value: "rehabilitation", label: "Rehabilitation" },
  { value: "match", label: "Match" },
  { value: "other", label: "Other" },
];

export function externalCalendarMode(form) {
  if (form.scheduleKind === "specific_dates") return "multi";
  if (form.scheduleKind === "daily") return "range";
  return "single";
}

function externalRangeDateSet(start, end) {
  if (!start || !end) return new Set();
  const [from, to] = start <= end ? [start, end] : [end, start];
  const result = new Set();
  const cursor = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  while (cursor <= last) {
    result.add(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export function externalCalendarSelectedSet(form) {
  const mode = externalCalendarMode(form);
  if (mode === "multi") return new Set(form.selectedDates);
  return externalRangeDateSet(form.startDate, form.endDate);
}

function formatShortDate(iso) {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function externalCalendarToggleLabel(form) {
  const mode = externalCalendarMode(form);
  if (mode === "multi") {
    const count = form.selectedDates.length;
    return count ? `${count} date${count === 1 ? "" : "s"} selected` : "Pick dates";
  }
  if (!form.startDate || !form.endDate) return mode === "range" ? "Pick start and end dates" : "Pick a date";
  if (mode === "range") {
    return form.startDate === form.endDate
      ? `Daily · ${formatShortDate(form.startDate)}`
      : `Daily · ${formatShortDate(form.startDate)} – ${formatShortDate(form.endDate)}`;
  }
  return formatShortDate(form.startDate);
}

const CALENDAR_WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function externalMonthMatrix(monthIso) {
  const [year, month] = monthIso.split("-").map(Number);
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function renderExternalCalendarSelectedHtml(form) {
  const mode = externalCalendarMode(form);
  if (mode !== "multi") {
    if (!form.startDate || !form.endDate) {
      return `<p class="muted">${mode === "range" ? "Click a day, then click again to set the end." : "Click a day to pick the date."}</p>`;
    }
    return `<p class="muted training-load-calendar-count">${escapeHtml(externalCalendarToggleLabel(form))}</p>`;
  }
  const dates = form.selectedDates.slice().sort();
  if (!dates.length) return `<p class="muted">No dates selected yet - click a day to add it.</p>`;
  return `
    <p class="muted training-load-calendar-count">${dates.length} date${dates.length === 1 ? "" : "s"} selected</p>
    <div class="training-load-calendar-chips">
      ${dates.map((iso) => `
        <button type="button" class="training-load-calendar-chip" data-action="training-load-calendar-remove-date" data-date="${escapeAttr(iso)}" title="Remove ${escapeAttr(iso)}">
          ${escapeHtml(iso)} &times;
        </button>
      `).join("")}
    </div>
  `;
}

function renderExternalCalendarHtml(form) {
  const timezone = form.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const monthIso = form.calendarMonth || localMonthIsoInTimeZone(timezone);
  const cells = externalMonthMatrix(monthIso);
  const [year, month] = monthIso.split("-").map(Number);
  const monthLabel = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const todayIso = localDateIsoInTimeZone(timezone);
  const selected = externalCalendarSelectedSet(form);
  return `
    <div class="training-load-calendar" data-training-load-calendar>
      <div class="training-load-calendar-head">
        <div class="training-load-calendar-head-nav">
          <button type="button" class="plain-button icon-button" data-action="training-load-calendar-prev-month" aria-label="Previous month">&larr;</button>
          <strong>${escapeHtml(monthLabel)}</strong>
          <button type="button" class="plain-button icon-button" data-action="training-load-calendar-next-month" aria-label="Next month">&rarr;</button>
        </div>
      </div>
      <div class="training-load-calendar-weekdays">${CALENDAR_WEEKDAY_LABELS.map((label) => `<span>${label}</span>`).join("")}</div>
      <div class="training-load-calendar-grid" data-training-load-calendar-grid>
        ${cells.map((iso) => {
          if (!iso) return `<span class="training-load-calendar-day training-load-calendar-day-blank" aria-hidden="true"></span>`;
          const isPast = iso < todayIso;
          const isSelected = selected.has(iso);
          const dayNumber = Number(iso.slice(8, 10));
          return `<button type="button" class="training-load-calendar-day ${isSelected ? "is-selected" : ""}" data-action="training-load-calendar-day-click" data-date="${escapeAttr(iso)}" ${isPast ? "disabled" : ""}>${dayNumber}</button>`;
        }).join("")}
      </div>
      <div class="training-load-calendar-selected" data-training-load-calendar-selected>
        ${renderExternalCalendarSelectedHtml(form)}
      </div>
    </div>
  `;
}

function renderExternalCalendarSectionHtml(form) {
  return `
    <div class="training-load-calendar-section">
      ${form.calendarOpen ? renderExternalCalendarHtml(form) : `<p class="training-load-calendar-closed-summary muted" data-training-load-calendar-toggle-label>${escapeHtml(externalCalendarToggleLabel(form))}</p>`}
    </div>
  `;
}

// Hardening correction (item 10): editing an existing schedule used to
// still render the full click-to-pick calendar, but submit silently
// stripped dates/startDate/scheduleKind before sending the PATCH - a
// control that looked fully functional while the backend quietly
// ignored whatever it was clicked to. None of these three kinds accept
// a genuinely new date/date-set through Edit (only Schedule again
// does, via the real interactive calendar above) - a recurring
// schedule's own END date is the one exception, since PATCH really
// does apply it, so that's a real editable input, not a display value.
function renderExternalScheduleReadOnlyDatesHtml(form) {
  if (form.scheduleKind === "daily") {
    return `
      <div class="training-load-dates-readonly">
        <p class="muted">Starts <strong>${escapeHtml(formatShortDate(form.startDate))}</strong> (fixed - use Schedule again for a different start date)</p>
        <label class="search-field">
          <span>Ends</span>
          <input type="date" name="endDate" value="${escapeAttr(form.endDate)}" min="${escapeAttr(form.startDate)}" data-action="training-load-schedule-form-field" required>
        </label>
      </div>
    `;
  }
  if (form.scheduleKind === "specific_dates") {
    const dates = (form.datesList.length ? form.datesList : [form.startDate].filter(Boolean)).slice().sort();
    return `
      <div class="training-load-dates-readonly">
        <p class="muted training-load-calendar-count">${dates.length} date${dates.length === 1 ? "" : "s"} - fixed after creation</p>
        <div class="training-load-calendar-chips">
          ${dates.map((iso) => `<span class="training-load-calendar-chip training-load-calendar-chip-static">${escapeHtml(iso)}</span>`).join("")}
        </div>
        <p class="muted">Use Schedule again to run this on different dates.</p>
      </div>
    `;
  }
  return `<p class="muted">Date: <strong>${escapeHtml(formatShortDate(form.startDate))}</strong> (fixed - use Schedule again for a different date)</p>`;
}

// ------------------------------------------------------------
// Recipient picker - identical shape/CSS to the coach filter picker above
// (Builder-style Clubs/Teams/Athletes tabs), just backed by the schedule
// form's own clubIds/teamIds/athleteIds instead of state.trainingLoad.filter.
// ------------------------------------------------------------

function externalRecipientsTotalSelected(form) {
  return form.clubIds.length + form.teamIds.length + form.athleteIds.length;
}

function renderExternalRecipientsTriggerHtml(form) {
  const total = externalRecipientsTotalSelected(form);
  return `
    <div class="builder-assignment-row training-load-recipients-row">
      <span class="builder-field-label">Recipients</span>
      <button class="builder-athlete-trigger" type="button" data-action="training-load-open-recipient-picker" aria-haspopup="dialog">
        <span><strong>${total ? `Recipients · ${total} selected` : "Choose recipients"}</strong></span>
        <span class="button-icon">&gt;</span>
      </button>
    </div>
  `;
}

function externalRecipientVisibleAthletes(form) {
  const roster = state.trainingLoad.orgPickerData?.athletes || [];
  const search = form.athleteSearch.trim().toLowerCase();
  return search ? roster.filter((a) => (a.name || "").toLowerCase().includes(search)) : roster;
}

function renderExternalRecipientSelectAllHtml({ items, selectedIds, kind }) {
  const selected = new Set(selectedIds);
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  return `
    <button type="button" class="checkbox-toggle-all ${allSelected ? "is-checked" : ""}" data-action="training-load-recipient-picker-select-all" data-kind="${kind}" aria-label="${allSelected ? "Uncheck all" : "Check all"}" ${items.length ? "" : "disabled"}>
      <span aria-hidden="true">${allSelected ? "&#10003;" : ""}</span>
    </button>
    <span class="muted">Select all</span>
    <button type="button" class="plain-button compact-button" data-action="training-load-recipient-picker-clear" data-kind="${kind}" ${selectedIds.length ? "" : "disabled"}>Clear all</button>
  `;
}

function renderExternalRecipientOptionsHtml({ items, selectedIds, kind, emptyLabel }) {
  if (!items.length) return `<p class="muted">${escapeHtml(emptyLabel)}</p>`;
  const selected = new Set(selectedIds);
  return items.map((item) => {
    const isSelected = selected.has(item.id);
    return `
      <button type="button" class="builder-athlete-option ${isSelected ? "is-selected" : ""}" data-action="training-load-recipient-picker-toggle" data-kind="${kind}" data-id="${escapeAttr(item.id)}">
        <span class="builder-athlete-trigger-icon">${escapeHtml(initialsFor(item.name))}</span>
        <span><strong>${escapeHtml(item.name)}</strong>${item.subtitle ? `<small>${escapeHtml(item.subtitle)}</small>` : ""}</span>
        <span class="builder-checkmark" aria-hidden="true">${isSelected ? "&#10003;" : ""}</span>
      </button>
    `;
  }).join("");
}

const RECIPIENT_PICKER_TABS = [
  { id: "clubs", label: "Clubs" },
  { id: "teams", label: "Teams" },
  { id: "athletes", label: "Athletes" },
];

function externalRecipientTabCount(form, tabId) {
  if (tabId === "clubs") return form.clubIds.length;
  if (tabId === "teams") return form.teamIds.length;
  return form.athleteIds.length;
}

function renderExternalRecipientPickerTabsHtml(form) {
  return `
    <div class="tests-recipient-picker-tabs" role="tablist">
      ${RECIPIENT_PICKER_TABS.map((tab) => {
        const count = externalRecipientTabCount(form, tab.id);
        return `
          <button type="button" class="tests-recipient-picker-tab ${form.recipientPickerTab === tab.id ? "is-active" : ""}" role="tab" aria-selected="${form.recipientPickerTab === tab.id ? "true" : "false"}" data-action="training-load-recipient-picker-set-tab" data-recipient-tab="${tab.id}">
            ${tab.label}${count ? ` <span class="tests-recipient-picker-tab-count">${count}</span>` : ""}
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderExternalRecipientPickerPanelHtml(form) {
  const orgData = state.trainingLoad.orgPickerData;
  if (form.recipientPickerTab === "clubs") {
    const clubs = orgData?.clubs || [];
    return `
      <div class="builder-athlete-select-all">${renderExternalRecipientSelectAllHtml({ items: clubs, selectedIds: form.clubIds, kind: "club" })}</div>
      <div class="builder-athlete-options tests-athlete-options">${renderExternalRecipientOptionsHtml({ items: clubs.map((c) => ({ id: c.id, name: c.name })), selectedIds: form.clubIds, kind: "club", emptyLabel: "No clubs available." })}</div>
    `;
  }
  if (form.recipientPickerTab === "teams") {
    const teams = orgData?.teams || [];
    return `
      <div class="builder-athlete-select-all">${renderExternalRecipientSelectAllHtml({ items: teams, selectedIds: form.teamIds, kind: "team" })}</div>
      <div class="builder-athlete-options tests-athlete-options">${renderExternalRecipientOptionsHtml({ items: teams.map((t) => ({ id: t.id, name: t.name, subtitle: t.club_name || "" })), selectedIds: form.teamIds, kind: "team", emptyLabel: "No teams available." })}</div>
    `;
  }
  const visible = externalRecipientVisibleAthletes(form);
  return `
    <label class="search-field">
      <span>Search athletes</span>
      <input type="search" placeholder="Search athletes by name" value="${escapeAttr(form.athleteSearch)}" data-action="training-load-recipient-athlete-search">
    </label>
    <div class="builder-athlete-select-all">${renderExternalRecipientSelectAllHtml({ items: visible.map((a) => ({ id: a.id })), selectedIds: form.athleteIds, kind: "athlete" })}</div>
    <div class="builder-athlete-options tests-athlete-options">${renderExternalRecipientOptionsHtml({ items: visible.map((a) => ({ id: a.id, name: a.name, subtitle: a.athlete_id ? `ID ${a.athlete_id}` : "" })), selectedIds: form.athleteIds, kind: "athlete", emptyLabel: "No athletes match." })}</div>
  `;
}

function renderExternalRecipientPickerHtml(form) {
  return `
    <div class="builder-athlete-overlay tests-recipient-picker-overlay">
      <button class="builder-athlete-backdrop" type="button" data-action="training-load-recipient-picker-cancel" aria-label="Close recipients picker"></button>
      <section class="panel builder-athlete-picker tests-recipient-picker" role="dialog" aria-modal="true" aria-label="Choose recipients">
        <div class="builder-section-panel-head">
          <div>
            <strong>Recipients</strong>
            <p class="muted">Any mix of clubs, teams and individual athletes.</p>
          </div>
          <div class="builder-athlete-picker-head-actions">
            <button class="plain-button icon-button builder-athlete-picker-cancel" type="button" data-action="training-load-recipient-picker-cancel" aria-label="Cancel" title="Cancel">${ICON_X}</button>
            <button class="plain-button icon-button builder-athlete-picker-continue" type="button" data-action="training-load-recipient-picker-confirm" aria-label="Confirm" title="Confirm">${ICON_CHECK}</button>
          </div>
        </div>
        ${renderExternalRecipientPickerTabsHtml(form)}
        ${renderExternalRecipientPickerPanelHtml(form)}
        <div class="builder-copy-plan-footer">
          <span class="muted">${externalRecipientsTotalSelected(form)} selected total</span>
        </div>
      </section>
    </div>
  `;
}

// ------------------------------------------------------------
// Notifications (per-schedule config the worker itself reads - see
// migrations_v2/202609020900_training_load_v7...). No coach "live digest"
// kind here - unlike WELLNESS, training_load's own GET /weekly already
// shows an occurrence's current state live, so a redundant live-digest
// notification was never part of this feature's design.
// ------------------------------------------------------------

function notificationRuleFor(form, kind) {
  return form.notificationRules.find((r) => r.kind === kind) || { kind, enabled: false, reminderOffsetMinutes: null };
}

function notificationsSummary(form) {
  const on = ["athlete_invitation", "athlete_reminder", "final_digest"].filter((k) => notificationRuleFor(form, k).enabled).length;
  return on === 3 ? "All on" : on === 0 ? "All off" : `${on}/3 on`;
}

function renderNotificationSwitchRowHtml({ kind, label, checked }) {
  return `
    <div class="tests-notification-row">
      <button type="button" class="tests-notification-switch ${checked ? "is-on" : ""}" role="switch" aria-checked="${checked ? "true" : "false"}" aria-label="${escapeAttr(label)}" data-action="training-load-notification-rule-toggle" data-kind="${kind}">
        <span class="tests-notification-switch-knob" aria-hidden="true"></span>
      </button>
      <span class="tests-notification-row-label">${escapeHtml(label)}</span>
    </div>
  `;
}

function renderExternalNotificationsSectionHtml(form) {
  const invitation = notificationRuleFor(form, "athlete_invitation");
  const reminder = notificationRuleFor(form, "athlete_reminder");
  const finalDigest = notificationRuleFor(form, "final_digest");
  return `
    <div class="tests-collapsible-section">
      <button type="button" class="tests-calendar-open-toggle tests-collapsible-toggle" data-action="training-load-toggle-notifications-section" aria-expanded="${form.notificationsSectionOpen ? "true" : "false"}">
        <span class="tests-collapsible-label">Notifications <span class="tests-collapsible-summary">&middot; ${escapeHtml(notificationsSummary(form))}</span></span>
        <span class="tests-calendar-toggle-caret">${form.notificationsSectionOpen ? "&#9650;" : "&#9660;"}</span>
      </button>
      ${form.notificationsSectionOpen ? `
        ${renderNotificationSwitchRowHtml({ kind: "athlete_invitation", label: "Notify when open", checked: invitation.enabled })}
        ${renderNotificationSwitchRowHtml({ kind: "athlete_reminder", label: "Remind incomplete", checked: reminder.enabled })}
        ${reminder.enabled ? `
        <div class="tests-notification-inline-control">
          <span>Remind</span>
          <input type="number" min="1" step="1" class="tests-notification-offset-input" value="${escapeAttr(reminder.reminderOffsetMinutes || 60)}" data-action="training-load-notification-offset-input" aria-label="Minutes before closes_at">
          <span>min before close</span>
        </div>
        ` : ""}
        ${renderNotificationSwitchRowHtml({ kind: "final_digest", label: "Final summary when it closes", checked: finalDigest.enabled })}
      ` : ""}
    </div>
  `;
}

// ------------------------------------------------------------
// The create/edit/schedule-again form itself.
// ------------------------------------------------------------

export function externalScheduleSubmitDisabled(form) {
  if (form.submitting || !form.eventName.trim()) return true;
  if (form.editingScheduleId) {
    // Dates are fixed once created (see the read-only summary this form
    // renders instead of a calendar) - only Daily's real end-date input
    // can still block submit here, exactly like the calendar itself
    // could before this correction.
    if (form.scheduleKind === "daily") return !form.endDate;
    return false;
  }
  if (form.scheduleKind === "specific_dates") return !form.selectedDates.length;
  if (form.scheduleKind === "daily") return !form.startDate || !form.endDate;
  return !form.startDate;
}

export function externalScheduleSubmitLabel(form) {
  if (form.submitting) return "Saving...";
  if (form.scheduleKind === "specific_dates" && !form.editingScheduleId) return `Schedule ${form.selectedDates.length} date${form.selectedDates.length === 1 ? "" : "s"}`;
  return form.editingScheduleId ? "Save changes" : "Create schedule";
}

export function renderExternalScheduleFormHtml() {
  const form = state.trainingLoad.scheduleForm;
  const isEdit = Boolean(form.editingScheduleId);
  const isScheduleAgain = Boolean(form.scheduleAgainFromId);
  const isSpecificDates = form.scheduleKind === "specific_dates";
  return `
    <section class="panel training-load-schedule-form">
      <button type="button" class="plain-button icon-button wellness-back" data-action="training-load-close-schedule-form" aria-label="Close">&times;</button>
      <h3>${isEdit ? "Edit RPE session" : isScheduleAgain ? "Schedule again" : "New RPE session"}${renderOutsidePlanBadgeHtml()}</h3>
      ${isScheduleAgain ? `<p class="muted">Settings copied from the original - pick new dates below to create an independent new schedule. The original and its results are unaffected.</p>` : ""}
      ${form.error ? `<p class="builder-error">${escapeHtml(form.error)}</p>` : ""}
      <div class="training-load-schedule-form-scroll">
        <label class="search-field">
          <span>Name</span>
          <input type="text" name="eventName" value="${escapeAttr(form.eventName)}" data-action="training-load-schedule-form-field" placeholder="e.g. National team camp" required>
        </label>
        <div class="training-load-event-type-field">
          <span class="builder-field-label">Type (optional)</span>
          <div class="training-load-event-type-pills" role="group" aria-label="Type">
            ${EXTERNAL_EVENT_TYPES.map((t) => `
              <button type="button" class="training-load-event-type-pill ${form.eventType === t.value ? "is-active" : ""}" data-action="training-load-schedule-set-event-type" data-event-type="${t.value}">${t.label}</button>
            `).join("")}
          </div>
        </div>
        ${isEdit ? "" : `
        <div class="training-load-recurrence-toggle" role="group" aria-label="Recurrence">
          <button type="button" class="training-load-recurrence-pill ${isSpecificDates ? "is-active" : ""}" data-action="training-load-schedule-set-recurrence" data-daily="false">Dates</button>
          <button type="button" class="training-load-recurrence-pill ${form.scheduleKind === "daily" ? "is-active" : ""}" data-action="training-load-schedule-set-recurrence" data-daily="true">Daily</button>
        </div>
        `}
        ${isEdit ? renderExternalScheduleReadOnlyDatesHtml(form) : renderExternalCalendarSectionHtml(form)}
        <div class="tests-time-row">
          <label class="search-field">
            <span>Opens</span>
            <input type="time" name="opensTime" value="${escapeAttr(form.opensTime)}" data-action="training-load-schedule-form-field" required>
          </label>
          <label class="search-field">
            <span>Closes</span>
            <input type="time" name="closesTime" value="${escapeAttr(form.closesTime)}" data-action="training-load-schedule-form-field" required>
          </label>
        </div>
        <p class="muted training-load-timezone-info">Times follow each athlete's own device timezone.</p>
        ${renderExternalRecipientsTriggerHtml(form)}
        <label class="search-field">
          <span>Note (optional)</span>
          <textarea name="eventNote" data-action="training-load-schedule-form-field" placeholder="Anything athletes should know">${escapeHtml(form.eventNote)}</textarea>
        </label>
        ${renderExternalNotificationsSectionHtml(form)}
        <div class="tests-collapsible-section">
          <button type="button" class="tests-calendar-open-toggle tests-collapsible-toggle" data-action="training-load-toggle-advanced-settings" aria-expanded="${form.advancedSettingsOpen ? "true" : "false"}">
            <span class="tests-collapsible-label">Advanced settings</span>
            <span class="tests-calendar-toggle-caret">${form.advancedSettingsOpen ? "&#9650;" : "&#9660;"}</span>
          </button>
          ${form.advancedSettingsOpen ? `
            <label class="search-field">
              <span>Fallback timezone</span>
              <input type="text" name="timezone" value="${escapeAttr(form.timezone)}" data-action="training-load-schedule-form-field" required>
            </label>
            <p class="muted">Used only for an athlete whose own device timezone isn't known yet.</p>
          ` : ""}
        </div>
      </div>
      <div class="tests-schedule-form-actions">
        <button type="button" class="plain-button" data-action="training-load-schedule-submit" data-training-load-schedule-submit ${externalScheduleSubmitDisabled(form) ? "disabled" : ""}>${externalScheduleSubmitLabel(form)}</button>
      </div>
      ${form.recipientPickerOpen ? renderExternalRecipientPickerHtml(form) : ""}
    </section>
  `;
}

// ------------------------------------------------------------
// Schedule detail (Edit/Pause/Resume/Cancel/Schedule again).
// ------------------------------------------------------------

function externalEventTypeLabel(value) {
  return EXTERNAL_EVENT_TYPES.find((t) => t.value === value)?.label || "";
}

export function renderExternalScheduleDetailHtml() {
  const detail = state.trainingLoad.scheduleDetail;
  if (detail.loading) return `<p class="muted training-load-empty">Loading...</p>`;
  if (detail.error) return `<p class="builder-error">${escapeHtml(detail.error)}</p>`;
  const { schedule, targets } = detail;
  if (!schedule) return "";
  return `
    <section class="panel training-load-schedule-detail">
      <button type="button" class="plain-button compact-button" data-action="training-load-close-external-schedule">&larr; Back to schedule</button>
      <h3>${escapeHtml(schedule.eventName)}${renderOutsidePlanBadgeHtml()}</h3>
      <p class="muted">${schedule.eventType ? `${escapeHtml(externalEventTypeLabel(schedule.eventType))} · ` : ""}${schedule.scheduleKind === "recurring" ? "Daily" : schedule.scheduleKind === "dates" ? `Dates (${(schedule.dates || []).length})` : "One-time"}</p>
      <p class="muted">${escapeHtml((schedule.opensTime || "").slice(0, 5))}&ndash;${escapeHtml((schedule.closesTime || "").slice(0, 5))} (fallback timezone: ${escapeHtml(schedule.timezone)})</p>
      ${schedule.scheduleKind === "dates" && (schedule.dates || []).length ? `<p class="muted">Dates: ${schedule.dates.map((d) => escapeHtml(d)).join(", ")}</p>` : ""}
      ${schedule.eventNote ? `<p>${escapeHtml(schedule.eventNote)}</p>` : ""}
      <p>Targets: ${targets.map((t) => escapeHtml(t.name || t.athleteId || t.teamId || t.clubId)).join(", ") || "none"}</p>
      ${schedule.status === "cancelled"
        ? `
        <p class="muted">Cancelled - read-only. Historical results, if any, remain available in Results.</p>
        <div class="tests-schedule-actions">
          <button type="button" class="plain-button compact-button" data-action="training-load-external-schedule-again" data-schedule-id="${escapeAttr(schedule.id)}">Schedule again</button>
        </div>
      `
        : `
        <div class="tests-schedule-actions">
          <button type="button" class="plain-button compact-button" data-action="training-load-open-edit-external-schedule" data-schedule-id="${escapeAttr(schedule.id)}">Edit</button>
          ${schedule.status === "active"
            ? `<button type="button" class="plain-button compact-button" data-action="training-load-set-external-schedule-status" data-schedule-id="${escapeAttr(schedule.id)}" data-status="pause">Pause</button>`
            : `<button type="button" class="plain-button compact-button" data-action="training-load-set-external-schedule-status" data-schedule-id="${escapeAttr(schedule.id)}" data-status="resume">Resume</button>`}
          <button type="button" class="plain-button compact-button" data-action="training-load-external-schedule-again" data-schedule-id="${escapeAttr(schedule.id)}">Schedule again</button>
          <button type="button" class="plain-button compact-button training-load-cancel-button" data-action="training-load-set-external-schedule-status" data-schedule-id="${escapeAttr(schedule.id)}" data-status="cancel">Cancel</button>
        </div>
      `}
    </section>
  `;
}

// ------------------------------------------------------------
// Today tab: an OUTSIDE PLAN group's per-athlete status + manual reminder.
// Derives its rows live from the already-loaded weekly.today payload
// (never a second fetch) - a reminder send or a fresh rating is reflected
// the instant Today's own weekly data next re-fetches.
// ------------------------------------------------------------

function currentTodayGroupSessions() {
  const open = state.trainingLoad.todayGroupDetail;
  if (!open) return [];
  const day = state.trainingLoad.weekly.today.data?.days.find((d) => d.date === open.date);
  return (day?.sessions || []).filter((s) => s.source === "scheduled_external" && s.scheduleId === open.scheduleId);
}

// Mirrors tests-view.js's own reminderSelectedSet - falls back to "every
// not-yet-completed athlete" whenever no explicit selection was made yet,
// or the group's own current assignment-id set has moved on since (a
// stale selection self-corrects on the very next render).
function externalReminderSelectedSet(scheduleId, sessions) {
  const pending = sessions.filter((s) => !s.rated);
  const currentIds = pending.map((s) => s.externalAssignmentId).sort();
  const saved = state.trainingLoad.reminderSelection[scheduleId];
  if (saved && saved.fingerprint === currentIds.join(",")) return new Set(saved.ids);
  return new Set(currentIds);
}

export function renderTodayGroupDetailHtml() {
  const open = state.trainingLoad.todayGroupDetail;
  const sessions = currentTodayGroupSessions();
  const rated = sessions.filter((s) => s.rated);
  const pending = sessions.filter((s) => !s.rated);
  const selected = externalReminderSelectedSet(open.scheduleId, sessions);
  const sending = state.trainingLoad.remindingScheduleId === open.scheduleId;
  const result = state.trainingLoad.reminderResult && state.trainingLoad.reminderResult.scheduleId === open.scheduleId ? state.trainingLoad.reminderResult : null;
  return `
    <section class="panel training-load-schedule-detail">
      <button type="button" class="plain-button compact-button" data-action="training-load-close-external-group">&larr; Back to Today</button>
      <h3>${escapeHtml(open.eventName)}${renderOutsidePlanBadgeHtml()}</h3>
      <p class="muted">${rated.length}/${sessions.length} rated</p>
      ${result ? `<p class="muted">${escapeHtml(result.message)}</p>` : ""}
      <div class="training-load-reminder-list">
        ${sessions.map((s) => `
          <div class="training-load-reminder-row">
            ${!s.rated ? `
              <label class="training-load-reminder-checkbox">
                <input type="checkbox" data-action="training-load-external-reminder-toggle-athlete" data-assignment-id="${escapeAttr(s.externalAssignmentId)}" ${selected.has(s.externalAssignmentId) ? "checked" : ""}>
              </label>
            ` : `<span class="training-load-reminder-checkbox" aria-hidden="true"></span>`}
            <span class="training-load-session-name">${escapeHtml(s.athleteName)}</span>
            <span class="training-load-status-pill training-load-status-${s.rated ? "rated" : "unrated"}">${s.rated ? escapeHtml(formatFeedbackSummary(s.feedback)) : "Not rated"}</span>
          </div>
        `).join("")}
      </div>
      ${pending.length ? `
        <div class="tests-schedule-actions">
          <button type="button" class="plain-button compact-button" data-action="training-load-external-reminder-select-all">Select all</button>
          <button type="button" class="plain-button compact-button" data-action="training-load-external-reminder-clear">Clear</button>
          <button type="button" class="plain-button" data-action="training-load-send-external-reminder" data-schedule-id="${escapeAttr(open.scheduleId)}" ${sending || !selected.size ? "disabled" : ""}>${sending ? "Sending..." : "Send reminder"}</button>
        </div>
      ` : `<p class="muted">Everyone has answered.</p>`}
    </section>
  `;
}

export function renderTrainingLoadResultsHtml() {
  const nav = state.trainingLoad.weekly.results;
  if (nav.loading && !nav.data) return `<p class="muted training-load-empty">Loading results...</p>`;
  if (nav.error) return `<p class="builder-error">${escapeHtml(nav.error)}</p>`;
  if (!nav.data) return "";
  const agg = computeWeeklyAggregates(nav.data);
  const ratedDays = nav.data.days.map((day) => ({ ...day, sessions: day.sessions.filter((s) => s.rated) }));
  const selectedDate = nav.selectedDate || nav.data.weekStart;
  const selectedDaySrpe = agg.dailySrpe.find((d) => d.date === selectedDate)?.srpe || 0;
  return `
    <div class="training-load-results-summary">
      <div class="training-load-summary-grid">
        <div class="training-load-summary-tile"><span class="training-load-summary-value">${escapeHtml(formatSrpe(agg.totalSrpe))}</span><span class="training-load-summary-label">Weekly sRPE</span></div>
        <div class="training-load-summary-tile"><span class="training-load-summary-value">${agg.avgRpe != null ? agg.avgRpe.toFixed(1) : "-"}</span><span class="training-load-summary-label">Avg RPE</span></div>
        <div class="training-load-summary-tile"><span class="training-load-summary-value">${agg.totalDuration} min</span><span class="training-load-summary-label">Total duration</span></div>
        <div class="training-load-summary-tile"><span class="training-load-summary-value">${agg.ratedCount}/${agg.plannedCount}</span><span class="training-load-summary-label">Rated / planned</span></div>
      </div>
      ${renderTrainingLoadBarChartHtml(agg.dailySrpe)}
    </div>
    ${renderTrainingLoadWeeklyShellHtml({
      section: "results",
      days: ratedDays,
      weekStart: nav.data.weekStart,
      weekEnd: nav.data.weekEnd,
      selectedDate: nav.selectedDate,
      emptyAgendaText: "No submitted results this day.",
      renderSessionRow: renderResultsSessionRowHtml,
      agendaHeaderExtra: `<p class="muted training-load-daily-total">Day total: <strong>${escapeHtml(formatSrpe(selectedDaySrpe))}</strong></p>`,
    })}
  `;
}

// ------------------------------------------------------------
// Coach root: tab switcher + Club/Team/Athletes filter button.
// ------------------------------------------------------------

function trainingLoadFilterCount() {
  const { clubIds, teamIds, athleteIds } = state.trainingLoad.filter;
  return clubIds.length + teamIds.length + athleteIds.length;
}

export function renderTrainingLoadCoachHtml() {
  const section = state.trainingLoad.section;
  const count = trainingLoadFilterCount();
  return `
    <div class="training-load-root">
      <div class="training-load-toolbar">
        <div class="training-load-tabs" role="tablist">
          ${["today", "schedule", "results"].map((s) => `
            <button type="button" class="training-load-tab ${section === s ? "is-active" : ""}" role="tab" aria-selected="${section === s ? "true" : "false"}" data-action="training-load-section" data-section="${s}">${s === "today" ? "Today" : s === "schedule" ? "Schedule" : "Results"}</button>
          `).join("")}
        </div>
        <button type="button" class="plain-button compact-button training-load-filter-button ${count ? "is-active" : ""}" data-action="training-load-filter-open">Filter${count ? ` (${count})` : ""}</button>
      </div>
      ${section === "today" ? renderTrainingLoadTodayHtml() : ""}
      ${section === "schedule" ? renderTrainingLoadScheduleHtml() : ""}
      ${section === "results" ? renderTrainingLoadResultsHtml() : ""}
      ${state.trainingLoad.filterPicker.open ? renderTrainingLoadFilterPickerHtml() : ""}
    </div>
  `;
}

// ------------------------------------------------------------
// Coach filter picker - Builder-style (reuses the exact same .builder-
// athlete-overlay/-picker/-option/checkbox-toggle-all CSS the Tests
// recipient picker and Builder's own athlete picker already share), own
// action namespace, own state (state.trainingLoad.filterPicker/.filter -
// never state.tests).
// ------------------------------------------------------------

const FILTER_PICKER_TABS = [
  { id: "clubs", label: "Clubs" },
  { id: "teams", label: "Teams" },
  { id: "athletes", label: "Athletes" },
];

function renderFilterSelectAllHtml({ items, selectedIds, kind }) {
  const selected = new Set(selectedIds);
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  return `
    <button type="button" class="checkbox-toggle-all ${allSelected ? "is-checked" : ""}" data-action="training-load-filter-select-all" data-kind="${kind}" aria-label="${allSelected ? "Uncheck all" : "Check all"}" ${items.length ? "" : "disabled"}>
      <span aria-hidden="true">${allSelected ? "&#10003;" : ""}</span>
    </button>
    <span class="muted">Select all</span>
    <button type="button" class="plain-button compact-button" data-action="training-load-filter-clear" data-kind="${kind}" ${selectedIds.length ? "" : "disabled"}>Clear all</button>
  `;
}

function renderFilterOptionsHtml({ items, selectedIds, kind, emptyLabel }) {
  if (!items.length) return `<p class="muted">${escapeHtml(emptyLabel)}</p>`;
  const selected = new Set(selectedIds);
  return items.map((item) => {
    const isSelected = selected.has(item.id);
    return `
      <button type="button" class="builder-athlete-option ${isSelected ? "is-selected" : ""}" data-action="training-load-filter-toggle" data-kind="${kind}" data-id="${escapeAttr(item.id)}">
        <span class="builder-athlete-trigger-icon">${escapeHtml(initialsFor(item.name))}</span>
        <span><strong>${escapeHtml(item.name)}</strong>${item.subtitle ? `<small>${escapeHtml(item.subtitle)}</small>` : ""}</span>
        <span class="builder-checkmark" aria-hidden="true">${isSelected ? "&#10003;" : ""}</span>
      </button>
    `;
  }).join("");
}

// Correction: the athlete roster for this picker must come from
// state.trainingLoad.orgPickerData (GET /api/organization - already
// scoped to the CURRENT active workspace, exactly like the Clubs/Teams
// tabs right above), never the global state.athletes roster (GET /api/
// admin/athletes - the union of every athlete this account can reach
// through ANY of its roles, regardless of which workspace is active
// right now). Using the wrong roster let a Club A picker show Club B's
// athletes too - the backend's own mandatory workspace scope already
// rejected them, so picking one just produced a silently-empty result,
// but the picker itself was showing options that could never actually
// match anything.
export function trainingLoadFilterVisibleAthletes() {
  const roster = state.trainingLoad.orgPickerData?.athletes || [];
  const search = state.trainingLoad.filterPicker.search.trim().toLowerCase();
  return search ? roster.filter((athlete) => (athlete.name || "").toLowerCase().includes(search)) : roster;
}

function renderFilterTabPanelHtml() {
  const orgData = state.trainingLoad.orgPickerData;
  const picker = state.trainingLoad.filterPicker;
  const filter = state.trainingLoad.filter;
  if (picker.tab === "clubs") {
    const clubs = orgData?.clubs || [];
    return `
      <div class="builder-athlete-select-all">${renderFilterSelectAllHtml({ items: clubs, selectedIds: filter.clubIds, kind: "club" })}</div>
      <div class="builder-athlete-options">${renderFilterOptionsHtml({ items: clubs.map((c) => ({ id: c.id, name: c.name })), selectedIds: filter.clubIds, kind: "club", emptyLabel: "No clubs available." })}</div>
    `;
  }
  if (picker.tab === "teams") {
    const teams = orgData?.teams || [];
    return `
      <div class="builder-athlete-select-all">${renderFilterSelectAllHtml({ items: teams, selectedIds: filter.teamIds, kind: "team" })}</div>
      <div class="builder-athlete-options">${renderFilterOptionsHtml({ items: teams.map((t) => ({ id: t.id, name: t.name, subtitle: t.club_name || "" })), selectedIds: filter.teamIds, kind: "team", emptyLabel: "No teams available." })}</div>
    `;
  }
  const visible = trainingLoadFilterVisibleAthletes();
  return `
    <label class="search-field">
      <span>Search athletes</span>
      <input type="search" placeholder="Search athletes by name" value="${escapeAttr(picker.search)}" data-action="training-load-filter-athlete-search">
    </label>
    <div class="builder-athlete-select-all">${renderFilterSelectAllHtml({ items: visible.map((a) => ({ id: a.id })), selectedIds: filter.athleteIds, kind: "athlete" })}</div>
    <div class="builder-athlete-options">${renderFilterOptionsHtml({ items: visible.map((a) => ({ id: a.id, name: a.name, subtitle: a.athlete_id ? `ID ${a.athlete_id}` : "" })), selectedIds: filter.athleteIds, kind: "athlete", emptyLabel: "No athletes match." })}</div>
  `;
}

export function renderTrainingLoadFilterPickerHtml() {
  const picker = state.trainingLoad.filterPicker;
  return `
    <div class="builder-athlete-overlay training-load-filter-overlay">
      <button class="builder-athlete-backdrop" type="button" data-action="training-load-filter-cancel" aria-label="Close filter"></button>
      <section class="panel builder-athlete-picker training-load-filter-picker" role="dialog" aria-modal="true" aria-label="Filter by Club, Team, or Athletes">
        <div class="builder-section-panel-head">
          <div>
            <strong>Filter</strong>
            <p class="muted">Any mix of clubs, teams and individual athletes.</p>
          </div>
          <div class="builder-athlete-picker-head-actions">
            <button class="plain-button icon-button builder-athlete-picker-cancel" type="button" data-action="training-load-filter-cancel" aria-label="Cancel" title="Cancel">&times;</button>
            <button class="plain-button icon-button builder-athlete-picker-continue" type="button" data-action="training-load-filter-confirm" aria-label="Apply" title="Apply">&#10003;</button>
          </div>
        </div>
        <div class="training-load-filter-tabs" role="tablist">
          ${FILTER_PICKER_TABS.map((tab) => `
            <button type="button" class="tests-recipient-picker-tab ${picker.tab === tab.id ? "is-active" : ""}" role="tab" aria-selected="${picker.tab === tab.id ? "true" : "false"}" data-action="training-load-filter-set-tab" data-filter-tab="${tab.id}">${tab.label}</button>
          `).join("")}
        </div>
        ${renderFilterTabPanelHtml()}
      </section>
    </div>
  `;
}

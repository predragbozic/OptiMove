import { state } from "./state.js";
import { escapeAttr, escapeHtml, formatDate, formatDayMonth, formatWeekday, initialsFor, localDateIso } from "./utils.js";

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
    <button type="button" class="panel training-load-home-card" data-action="training-load-home-card-open" data-count="${unrated.length}" data-session-id="${escapeAttr(unrated[0]?.sessionId || "")}">
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
        <span class="training-load-list-row-name">${escapeHtml(sessionLabel(session))}</span>
        <span class="training-load-status-pill training-load-status-rated">${escapeHtml(formatFeedbackSummary(session.feedback))}</span>
      </div>
    `;
  }
  return `
    <button type="button" class="training-load-list-row" data-action="training-load-open-rpe-form" data-session-id="${escapeAttr(session.sessionId)}">
      <span class="training-load-list-row-name">${escapeHtml(sessionLabel(session))}</span>
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
          <span class="training-load-session-name">${escapeHtml(sessionLabel(session))}</span>
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
    <button type="button" class="training-load-session-row is-clickable" data-action="training-load-open-rpe-form" data-session-id="${escapeAttr(session.sessionId)}">
      <span class="training-load-session-time">${escapeHtml((session.sessionTime || "").slice(0, 5))}</span>
      <span class="training-load-session-main">
        <span class="training-load-session-name">${escapeHtml(sessionLabel(session))}</span>
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
            <h3>${escapeHtml(sessionLabel(form))}</h3>
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

function renderCoachSessionRowHtml(session) {
  const status = session.rated
    ? { label: formatFeedbackSummary(session.feedback), cls: "rated" }
    : { label: "Not rated", cls: "unrated" };
  return `
    <div class="training-load-session-row">
      <span class="training-load-session-time">${escapeHtml((session.sessionTime || "").slice(0, 5))}</span>
      <span class="training-load-session-main">
        <span class="training-load-session-name">${escapeHtml(session.athleteName)}</span>
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
  return renderTrainingLoadWeeklyShellHtml({
    section: "today",
    days: nav.data.days,
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
function renderScheduleSessionRowHtml(session, date) {
  const status = session.rated
    ? { label: formatFeedbackSummary(session.feedback), cls: "rated" }
    : { label: "Not rated", cls: "unrated" };
  const clickable = !session.historical;
  const attrs = clickable
    ? `type="button" data-action="training-load-open-weekly-plan" data-athlete-id="${escapeAttr(session.athleteId)}" data-date="${escapeAttr(date)}"`
    : "";
  const Tag = clickable ? "button" : "div";
  return `
    <${Tag} class="training-load-session-row ${clickable ? "is-clickable" : ""}" ${attrs}>
      <span class="training-load-session-time">${escapeHtml((session.sessionTime || "").slice(0, 5))}</span>
      <span class="training-load-session-main">
        <span class="training-load-session-name">${escapeHtml(session.athleteName)}</span>
        <span class="training-load-session-subtitle">${escapeHtml(sessionLabel(session))}</span>
      </span>
      <span class="training-load-status-pill training-load-status-${status.cls}">${escapeHtml(status.label)}</span>
    </${Tag}>
  `;
}

export function renderTrainingLoadScheduleHtml() {
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
  return { totalSrpe, totalDuration, avgRpe, ratedCount: rated.length, plannedCount: allSessions.length, dailySrpe };
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
        <span class="training-load-session-name">${escapeHtml(session.athleteName)}</span>
        <span class="training-load-session-subtitle">${escapeHtml(sessionLabel(session))}${session.historical ? " · from a since-changed plan" : ""}</span>
      </span>
      <span class="training-load-status-pill training-load-status-rated">${escapeHtml(formatFeedbackSummary(session.feedback))}</span>
    </div>
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

function trainingLoadFilterVisibleAthletes() {
  const roster = state.athletes || [];
  const search = state.trainingLoad.filterPicker.search.trim().toLowerCase();
  return search ? roster.filter((athlete) => (athlete.athlete || "").toLowerCase().includes(search)) : roster;
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
    <div class="builder-athlete-select-all">${renderFilterSelectAllHtml({ items: visible.map((a) => ({ id: a.athlete_uuid })), selectedIds: filter.athleteIds, kind: "athlete" })}</div>
    <div class="builder-athlete-options">${renderFilterOptionsHtml({ items: visible.map((a) => ({ id: a.athlete_uuid, name: a.athlete, subtitle: `ID ${a.athlete_id}` })), selectedIds: filter.athleteIds, kind: "athlete", emptyLabel: "No athletes match." })}</div>
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

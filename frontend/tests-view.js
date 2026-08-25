import { isAthleteMode } from "./access.js";
import { els } from "./dom.js";
import { renderImage } from "./media.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml, initialsFor } from "./utils.js";

function renderWellnessAvatar(form) {
  if (form.athleteImageUrl) return renderImage(form.athleteImageUrl, "wellness-avatar wellness-avatar-photo", form.athleteName);
  return `<span class="avatar-fallback wellness-avatar">${escapeHtml(initialsFor(form.athleteName))}</span>`;
}

// Icon-above-label tabs for the coach's 4 sections (Today/Schedule/Results/
// Test Library) - same stroke-based line-icon convention as the sidebar's
// own .rail-icon (24x24 viewBox, fill:none, stroke:currentColor - see
// styles.css) so these read as part of the same visual system, not a
// separate icon set. Athlete-mode tabs (Today/Upcoming/History) are
// unrelated to this request and stay text-only, unchanged.
const TESTS_TAB_ICONS = {
  today: `<rect x="3" y="5" width="18" height="16" rx="3"></rect><path d="M8 3v3"></path><path d="M16 3v3"></path><path d="M3 10h18"></path><rect x="7" y="13" width="4" height="4" rx="1"></rect>`,
  schedule: `<path d="M12 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"></path><path d="M16 3v4"></path><path d="M8 3v4"></path><path d="M3 11h11"></path><circle cx="18" cy="18" r="4"></circle><path d="M18 16.5V18l1 1"></path>`,
  results: `<circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="9" cy="7" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="14" cy="10" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="19" cy="6" r="1.3" fill="currentColor" stroke="none"></circle><path d="M4 12l5-5 5 3 5-4"></path><path d="M4 21v-6"></path><path d="M9 21v-9"></path><path d="M14 21v-7"></path><path d="M19 21v-11"></path>`,
  library: `<path d="M3 3v18"></path><path d="M3 4.5h3"></path><path d="M3 7.5h2"></path><path d="M3 10.5h3"></path><path d="M3 13.5h2"></path><path d="M3 16.5h3"></path><path d="M3 19.5h2"></path><circle cx="14" cy="7" r="3"></circle><path d="M9 21v-3a5 5 0 0 1 10 0v3"></path><path d="M19 4h2"></path>`,
};

function renderTestsTabIcon(section) {
  const paths = TESTS_TAB_ICONS[section];
  if (!paths) return "";
  return `<svg class="tests-tab-icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}

function formatDateTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString(undefined, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return String(value);
  }
}

function statusLabel(status) {
  return { pending: "Pending", open: "Open", in_progress: "In progress", completed: "Completed", missed: "Missed", excused: "Excused", cancelled: "Cancelled" }[status] || status;
}

// ------------------------------------------------------------
// Top-level dispatch
// ------------------------------------------------------------

// Mirrors notifications.js's renderNotifications() badge pattern exactly -
// the count span already exists in athlete.html's markup (hidden by
// default), this only ever toggles its text/visibility, never fetches.
export function renderTestsBadge() {
  const badge = document.querySelector("[data-tests-count]");
  if (!badge) return;
  const count = state.tests.pendingCount;
  badge.textContent = String(count);
  badge.hidden = !count;
}

export function renderTests() {
  els.context.textContent = "Tests";
  els.title.textContent = "Tests";
  els.toolbar.innerHTML = "";
  els.content.innerHTML = `
    ${renderTestsTabsHtml()}
    <div class="tests-shell">
      ${state.tests.error ? `<p class="builder-error">${escapeHtml(state.tests.error)}</p>` : ""}
      ${renderTestsSectionHtml()}
    </div>
  `;
}

function renderTestsTabsHtml() {
  const athleteMode = isAthleteMode();
  const sections = athleteMode
    ? [["today", "Today"], ["upcoming", "Upcoming"], ["history", "History"]]
    : [["today", "Today"], ["schedule", "Schedule"], ["results", "Results"], ["library", "Test Library"]];
  return `
    <nav class="tabs tests-section-tabs ${athleteMode ? "" : "tests-section-tabs-icon"}" aria-label="Tests sections">
      ${sections.map(([value, label]) => `
        <button class="tab ${state.tests.section === value ? "is-active" : ""}" type="button" data-action="tests-section" data-section="${escapeAttr(value)}">${athleteMode ? "" : renderTestsTabIcon(value)}<span>${escapeHtml(label)}</span></button>
      `).join("")}
    </nav>
  `;
}

function renderTestsSectionHtml() {
  if (state.tests.form) return renderWellnessFormPageHtml(state.tests.form);
  if (isAthleteMode()) {
    if (state.tests.section === "upcoming") return renderAthleteUpcomingHtml();
    if (state.tests.section === "history") return renderAthleteHistoryHtml();
    return renderAthleteTodayHtml();
  }
  if (state.tests.section === "schedule") return renderCoachScheduleHtml();
  if (state.tests.section === "results") return renderCoachResultsHtml();
  if (state.tests.section === "library") return renderCoachLibraryHtml();
  return renderCoachTodayHtml();
}

// ------------------------------------------------------------
// Athlete: Today / Upcoming / History
// ------------------------------------------------------------

function renderAthleteTodayHtml() {
  const rows = state.tests.athleteToday;
  if (!rows.length) return `<p class="muted tests-empty">Nothing to check in right now.</p>`;
  return `<div class="tests-card-list">${rows.map(renderAthleteAssignmentCardHtml).join("")}</div>`;
}

function renderAthleteAssignmentCardHtml(row) {
  const completed = row.status === "completed";
  const score = row.latestAssessment?.wellnessScore;
  return `
    <button class="panel tests-assignment-card" type="button" data-action="tests-open-assignment" data-assignment-id="${escapeAttr(row.assignmentId)}">
      <div class="tests-assignment-card-head">
        <span class="tests-assignment-card-title">${escapeHtml(row.testName)}</span>
        <span class="tests-status-pill tests-status-${escapeAttr(completed ? "completed" : "pending")}">${completed ? "Completed" : "Pending"}</span>
      </div>
      <p class="muted">Closes ${escapeHtml(formatDateTime(row.occurrence.closesAt))}</p>
      ${completed && score != null ? `<p class="tests-score-inline">Wellness score: ${escapeHtml(score.toFixed(1))}/10</p>` : ""}
    </button>
  `;
}

function renderAthleteUpcomingHtml() {
  const rows = state.tests.athleteUpcoming;
  if (!rows.length) return `<p class="muted tests-empty">Nothing scheduled yet.</p>`;
  return `
    <div class="tests-card-list">
      ${rows.map((row) => `
        <div class="panel tests-assignment-card">
          <div class="tests-assignment-card-head"><span class="tests-assignment-card-title">${escapeHtml(row.testName)}</span></div>
          <p class="muted">Opens ${escapeHtml(formatDateTime(row.startDate))} (${escapeHtml(row.timezone)})</p>
        </div>
      `).join("")}
    </div>
  `;
}

function renderAthleteHistoryHtml() {
  const rows = state.tests.athleteHistory;
  if (!rows.length) return `<p class="muted tests-empty">No completed check-ins yet.</p>`;
  return `
    <div class="tests-card-list">
      ${rows.map((row) => `
        <div class="panel tests-assignment-card">
          <div class="tests-assignment-card-head">
            <span class="tests-assignment-card-title">${escapeHtml(row.testName)}</span>
            <span class="muted">${escapeHtml(formatDateTime(row.completedAt))}</span>
          </div>
          ${row.wellnessScore != null ? `<p class="tests-score-inline">Wellness score: ${escapeHtml(row.wellnessScore.toFixed(1))}/10</p>` : ""}
          ${row.injury ? `<p class="tests-injury-flag">Injury reported</p>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

// ------------------------------------------------------------
// WELLNESS form (shared: normal Tests tab + public check-in page)
// ------------------------------------------------------------

export function renderWellnessFormPageHtml(form) {
  return `
    <div class="wellness-shell">
      ${renderWellnessFormHtml(form, { backAction: "tests-close-assignment" })}
    </div>
  `;
}

export function renderWellnessFormHtml(form, { backAction = "" } = {}) {
  if (form.result) return renderWellnessResultHtml(form, { backAction });

  const answeredCount = form.parameters.filter((p) => form.answered[p.key]).length;
  const allAnswered = answeredCount === form.parameters.length;
  const canSubmit = form.canSubmit !== false;

  return `
    <section class="panel wellness-card" aria-label="WELLNESS check-in">
      ${backAction ? `<button type="button" class="plain-button icon-button wellness-back" data-action="${escapeAttr(backAction)}" aria-label="Back">&larr;</button>` : ""}
      <div class="wellness-header">
        ${renderWellnessAvatar(form)}
        <div>
          <p class="eyebrow">${escapeHtml(form.testName || "WELLNESS")}</p>
          <h3>${escapeHtml(form.athleteName)}</h3>
          <p class="muted">Closes ${escapeHtml(formatDateTime(form.closesAt))}</p>
        </div>
      </div>
      <p class="wellness-progress" aria-live="polite">${answeredCount} of ${form.parameters.length} completed</p>
      ${!canSubmit ? `<p class="builder-error">This check-in window is closed.</p>` : ""}
      ${form.error ? `<p class="builder-error" role="alert">${escapeHtml(form.error)}</p>` : ""}
      <form data-tests-form="wellness-submit" novalidate>
        ${form.parameters.map((param) => renderWellnessParamHtml(param, form)).join("")}
        <button type="submit" class="plain-button wellness-submit-button" ${allAnswered && canSubmit && !form.submitting ? "" : "disabled"}>
          ${form.submitting ? "Saving..." : "Submit"}
        </button>
      </form>
    </section>
  `;
}

function renderWellnessParamHtml(param, form) {
  const answered = Boolean(form.answered[param.key]);
  const value = form.values[param.key];
  const inputId = `wellness-input-${param.key}`;
  if (param.controlType === "yes_no") {
    return `
      <fieldset class="wellness-param ${answered ? "is-answered" : "is-unanswered"}" data-key="${escapeAttr(param.key)}">
        <legend class="wellness-param-label">${escapeHtml(labelFor(param.key))}</legend>
        ${param.helpText ? `<p class="wellness-param-help">${escapeHtml(param.helpText)}</p>` : ""}
        <div class="wellness-yesno" role="group" aria-label="${escapeAttr(labelFor(param.key))}">
          <button type="button" class="wellness-yesno-btn ${answered && value === false ? "is-selected" : ""}" data-action="tests-answer-boolean" data-key="${escapeAttr(param.key)}" data-value="false">No</button>
          <button type="button" class="wellness-yesno-btn ${answered && value === true ? "is-selected" : ""}" data-action="tests-answer-boolean" data-key="${escapeAttr(param.key)}" data-value="true">Yes</button>
        </div>
      </fieldset>
    `;
  }
  const min = param.minimum ?? 0;
  const max = param.maximum ?? 10;
  const directionClass = param.direction === "lower_better" ? "wellness-slider-lower-better" : param.direction === "higher_better" ? "wellness-slider-higher-better" : "";
  return `
    <div class="wellness-param ${answered ? "is-answered" : "is-unanswered"}" data-key="${escapeAttr(param.key)}">
      <div class="wellness-param-head">
        <label class="wellness-param-label" for="${escapeAttr(inputId)}">${escapeHtml(labelFor(param.key))}</label>
        <span class="wellness-param-value">${answered ? escapeHtml(String(value)) : "–"}</span>
      </div>
      <input
        id="${escapeAttr(inputId)}"
        type="range"
        class="wellness-slider ${directionClass}"
        min="${escapeAttr(min)}"
        max="${escapeAttr(max)}"
        step="1"
        value="${escapeAttr(answered ? value : Math.round((min + max) / 2))}"
        data-action="tests-slider-input"
        data-key="${escapeAttr(param.key)}"
        aria-valuetext="${answered ? escapeAttr(String(value)) : "Not answered"}"
      >
      <div class="wellness-param-scale">
        <span>${escapeHtml(param.minLabel || String(min))}</span>
        <span>${escapeHtml(param.maxLabel || String(max))}</span>
      </div>
    </div>
  `;
}

function labelFor(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function renderWellnessResultHtml(form, { backAction }) {
  const score = form.result.wellnessScore;
  return `
    <section class="panel wellness-card wellness-result" aria-label="WELLNESS result">
      ${backAction ? `<button type="button" class="plain-button icon-button wellness-back" data-action="${escapeAttr(backAction)}" aria-label="Back">&larr;</button>` : ""}
      <div class="wellness-header">
        ${renderWellnessAvatar(form)}
        <div>
          <p class="eyebrow">${escapeHtml(form.testName || "WELLNESS")}</p>
          <h3>${escapeHtml(form.athleteName)}</h3>
        </div>
      </div>
      <p class="wellness-result-score">Wellness score: <strong>${escapeHtml(score != null ? score.toFixed(1) : "-")}/10</strong></p>
      <p class="muted">Lower is better</p>
      ${form.injuryReported ? `<p class="tests-injury-flag">You reported pain or injury today.</p>` : ""}
      ${form.canSubmit ? `<button type="button" class="plain-button compact-button" data-action="tests-correct-answer">Correct my answer</button>` : ""}
    </section>
  `;
}

// ------------------------------------------------------------
// Coach: Today
// ------------------------------------------------------------

function renderCoachTodayHtml() {
  const groups = state.tests.coachToday;
  if (!groups.length) return `<p class="muted tests-empty">No active WELLNESS schedules yet. Create one from the Schedule tab.</p>`;
  return groups.map(renderCoachTodayGroupHtml).join("");
}

function renderCoachTodayGroupHtml(group) {
  if (!group.occurrence) {
    return `
      <section class="panel tests-today-group">
        <h3>${escapeHtml(group.schedule.testName)}</h3>
        <p class="muted">No check-in window today.</p>
      </section>
    `;
  }
  const { counts, athletes, occurrence } = group;
  return `
    <section class="panel tests-today-group">
      <div class="tests-today-head">
        <div>
          <h3>${escapeHtml(group.schedule.testName)}</h3>
          <p class="muted">${escapeHtml(formatDateTime(occurrence.scheduledDate))} &middot; closes ${escapeHtml(formatDateTime(occurrence.closesAt))}</p>
        </div>
        <button type="button" class="plain-button compact-button" data-action="tests-copy-link" data-schedule-id="${escapeAttr(group.schedule.id)}">Copy group link</button>
      </div>
      <div class="tests-counts-row">
        <span class="tests-count-chip">${counts.total} total</span>
        <span class="tests-count-chip tests-count-completed">${counts.completed} completed</span>
        <span class="tests-count-chip">${counts.pending} pending</span>
        <span class="tests-count-chip tests-count-missed">${counts.missed} missed</span>
        <span class="tests-count-chip tests-count-injury">${counts.injuries} injuries</span>
      </div>
      <div class="tests-athlete-table">
        ${athletes.map((row) => `
          <div class="tests-athlete-row">
            <span class="tests-athlete-name">${escapeHtml(row.athleteName)}</span>
            <span class="tests-status-pill tests-status-${escapeAttr(row.status)}">${escapeHtml(statusLabel(row.status))}</span>
            <span class="tests-athlete-score">${row.wellnessScore != null ? row.wellnessScore.toFixed(1) : "-"}</span>
            ${row.injury ? `<span class="tests-injury-flag">Injury</span>` : "<span></span>"}
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

// ------------------------------------------------------------
// Coach: Schedule
// ------------------------------------------------------------

function renderCoachScheduleHtml() {
  return `
    <div class="tests-schedule-toolbar">
      <button type="button" class="plain-button" data-action="tests-open-schedule-form">New WELLNESS schedule</button>
      <label class="tests-show-cancelled-toggle">
        <input type="checkbox" data-action="tests-toggle-show-cancelled" ${state.tests.showCancelledSchedules ? "checked" : ""}>
        <span>Show cancelled</span>
      </label>
    </div>
    ${state.tests.scheduleForm.open ? renderScheduleFormHtml() : ""}
    ${!state.tests.scheduleForm.open && state.tests.bulkResult ? renderBulkResultHtml(state.tests.bulkResult) : ""}
    ${state.tests.scheduleDetail ? renderScheduleDetailHtml() : renderScheduleListHtml()}
  `;
}

function renderBulkResultHtml(result) {
  const dates = result.dates.slice().sort();
  return `
    <section class="panel tests-bulk-result">
      <button type="button" class="plain-button icon-button wellness-back" data-action="tests-dismiss-bulk-result" aria-label="Dismiss">&times;</button>
      <p><strong>${result.count} date${result.count === 1 ? "" : "s"} scheduled.</strong></p>
      <p class="muted">${dates.map(escapeHtml).join(", ")}</p>
    </section>
  `;
}

function targetSummaryFor(row) {
  const parts = [];
  if (row.athleteTargetCount) parts.push(`${row.athleteTargetCount} athlete${row.athleteTargetCount === 1 ? "" : "s"}`);
  if (row.teamTargetNames) parts.push(`Team: ${row.teamTargetNames}`);
  if (row.clubTargetNames) parts.push(`Club: ${row.clubTargetNames}`);
  return parts.join(" + ") || "No targets";
}

function renderScheduleListHtml() {
  const rows = state.tests.showCancelledSchedules ? state.tests.schedules : state.tests.schedules.filter((row) => row.status !== "cancelled");
  if (!rows.length) return `<p class="muted tests-empty">No WELLNESS schedules yet.</p>`;
  return `
    <div class="tests-card-list">
      ${rows.map((row) => renderScheduleCardHtml(row)).join("")}
    </div>
  `;
}

function renderScheduleCardHtml(row) {
  const deleting = state.tests.deletingScheduleId === row.id;
  return `
    <div class="panel tests-assignment-card tests-schedule-card">
      <button type="button" class="tests-schedule-card-open" data-action="tests-open-schedule" data-schedule-id="${escapeAttr(row.id)}">
        <div class="tests-assignment-card-head">
          <span class="tests-assignment-card-title">${escapeHtml(row.testName)} &middot; ${row.scheduleKind === "recurring" ? "Daily" : "One-time"}</span>
          <span class="tests-status-pill tests-status-${escapeAttr(row.status)}">${escapeHtml(row.status)}</span>
        </div>
        <p class="muted">${targetSummaryFor(row)}</p>
        <p class="muted">${escapeHtml(row.startDate || "")} &middot; ${escapeHtml(row.opensTime)}&ndash;${escapeHtml(row.closesTime)} ${escapeHtml(row.timezone)}</p>
      </button>
      ${row.status === "cancelled"
        ? `<p class="muted tests-cancelled-note">Cancelled - read-only. Historical results, if any, remain available in History/Results. Create a new schedule to reuse these targets.</p>`
        : `
        <div class="tests-schedule-card-actions">
          <button type="button" class="plain-button compact-button" data-action="tests-open-edit-schedule" data-schedule-id="${escapeAttr(row.id)}">Edit</button>
          ${row.status === "active"
            ? `<button type="button" class="plain-button compact-button" data-action="tests-set-schedule-status" data-schedule-id="${escapeAttr(row.id)}" data-status="paused">Pause</button>`
            : `<button type="button" class="plain-button compact-button" data-action="tests-set-schedule-status" data-schedule-id="${escapeAttr(row.id)}" data-status="active">Activate</button>`}
          <button type="button" class="plain-button compact-button tests-delete-button" data-action="tests-delete-schedule" data-schedule-id="${escapeAttr(row.id)}" data-test-name="${escapeAttr(row.testName)}" data-has-occurrences="${row.hasOccurrences ? "true" : "false"}" ${deleting ? "disabled" : ""}>${deleting ? "Deleting..." : "Delete"}</button>
        </div>
      `}
    </div>
  `;
}

function renderScheduleDetailHtml() {
  const { schedule, targets, link } = state.tests.scheduleDetail;
  return `
    <section class="panel tests-schedule-detail">
      <button type="button" class="plain-button compact-button" data-action="tests-close-schedule">&larr; Back to schedules</button>
      <h3>${escapeHtml(schedule.testName)} &middot; ${schedule.scheduleKind === "recurring" ? "Daily" : "One-time"}</h3>
      <p class="muted">${escapeHtml(schedule.opensTime)}&ndash;${escapeHtml(schedule.closesTime)} ${escapeHtml(schedule.timezone)}</p>
      <p>Targets: ${targets.map((t) => escapeHtml(t.name || t.id)).join(", ") || "none"}</p>
      ${schedule.status === "cancelled"
        ? `<p class="muted tests-cancelled-note">Cancelled - read-only. It can no longer be edited or reactivated. Historical results, if any, remain available in History/Results. Create a new schedule to reuse these targets.</p>`
        : `<div class="tests-schedule-actions">
        <button type="button" class="plain-button compact-button" data-action="tests-open-edit-schedule" data-schedule-id="${escapeAttr(schedule.id)}">Edit</button>
        ${schedule.status === "active"
          ? `<button type="button" class="plain-button compact-button" data-action="tests-set-schedule-status" data-schedule-id="${escapeAttr(schedule.id)}" data-status="paused">Pause</button>`
          : `<button type="button" class="plain-button compact-button" data-action="tests-set-schedule-status" data-schedule-id="${escapeAttr(schedule.id)}" data-status="active">Activate</button>`}
        <button type="button" class="plain-button compact-button tests-delete-button" data-action="tests-delete-schedule" data-schedule-id="${escapeAttr(schedule.id)}" data-test-name="${escapeAttr(schedule.testName)}" data-has-occurrences="${schedule.hasOccurrences ? "true" : "false"}" ${state.tests.deletingScheduleId === schedule.id ? "disabled" : ""}>${state.tests.deletingScheduleId === schedule.id ? "Deleting..." : "Delete"}</button>
      </div>`}
      <div class="tests-link-box">
        ${link
          ? `<p class="muted">Group link ready - share it in WhatsApp/Viber.</p><code class="tests-link-code">${escapeHtml(checkInUrl(link.publicToken))}</code>
             <div class="tests-schedule-actions">
               <button type="button" class="plain-button compact-button" data-action="tests-copy-link-url" data-url="${escapeAttr(checkInUrl(link.publicToken))}">Copy link</button>
               <button type="button" class="plain-button compact-button" data-action="tests-revoke-link" data-link-id="${escapeAttr(link.id)}" data-schedule-id="${escapeAttr(schedule.id)}">Revoke</button>
             </div>`
          : `<button type="button" class="plain-button compact-button" data-action="tests-create-link" data-schedule-id="${escapeAttr(schedule.id)}">Generate group link</button>`}
      </div>
    </section>
  `;
}

export function checkInUrl(publicToken) {
  return `${window.location.origin}/tests/check-in/${publicToken}`;
}

function renderScheduleFormHtml() {
  const form = state.tests.scheduleForm;
  const orgData = state.tests.orgPickerData;
  const isEdit = Boolean(form.editingScheduleId);
  const isSpecificDates = form.scheduleKind === "specific_dates";
  // hasActivity (not hasOccurrences alone) is what actually blocks a
  // one_time edit now - a schedule can have an occurrence and still be
  // freely editable, as long as nothing real has happened against it yet
  // (see PATCH /schedules/:id's own comment, backend/src/routes/tests.js).
  const blockedOneTimeEdit = isEdit && form.scheduleKind === "one_time" && form.hasActivity;
  return `
    <section class="panel tests-schedule-form">
      <button type="button" class="plain-button icon-button wellness-back" data-action="tests-close-schedule-form" aria-label="Close">&times;</button>
      <h3>${isEdit ? "Edit WELLNESS schedule" : "New WELLNESS schedule"}</h3>
      ${form.error ? `<p class="builder-error">${escapeHtml(form.error)}</p>` : ""}
      ${blockedOneTimeEdit ? `
        <p class="muted">This one-time schedule already has a started or completed response, so its targets/date/time can no longer be changed. Cancel it, then create a new schedule if you need to reschedule.</p>
      ` : `
        ${isEdit && form.scheduleKind === "one_time" && form.hasOccurrences ? `<p class="tests-future-only-notice">This schedule's occurrence hasn't been started yet, so it's still fully editable - saving will regenerate it under the new date/time/targets.</p>` : ""}
        ${isEdit && form.scheduleKind === "daily" && form.hasOccurrences ? `<p class="tests-future-only-notice">Changes apply to future occurrences only - already-generated occurrences and assignments are not affected.</p>` : ""}
        <form data-tests-form="${isEdit ? "edit-schedule" : isSpecificDates ? "create-schedule-bulk" : "create-schedule"}">
          <label class="search-field">
            <span>Recurrence</span>
            <select name="scheduleKind" data-action="tests-schedule-form-field">
              <option value="one_time" ${form.scheduleKind === "one_time" ? "selected" : ""}>One-time</option>
              <option value="daily" ${form.scheduleKind === "daily" ? "selected" : ""}>Daily</option>
              ${isEdit ? "" : `<option value="specific_dates" ${isSpecificDates ? "selected" : ""}>Specific dates</option>`}
            </select>
          </label>
          <label class="search-field">
            <span>Timezone</span>
            <input type="text" name="timezone" value="${escapeAttr(form.timezone)}" data-action="tests-schedule-form-field" required>
          </label>
          ${isSpecificDates ? "" : `
          <label class="search-field">
            <span>Start date</span>
            <input type="date" name="startDate" value="${escapeAttr(form.startDate)}" data-action="tests-schedule-form-field" required>
          </label>
          `}
          <label class="search-field">
            <span>Opens</span>
            <input type="time" name="opensTime" value="${escapeAttr(form.opensTime)}" data-action="tests-schedule-form-field" required>
          </label>
          <label class="search-field">
            <span>Closes</span>
            <input type="time" name="closesTime" value="${escapeAttr(form.closesTime)}" data-action="tests-schedule-form-field" required>
          </label>
          ${isSpecificDates ? renderTestsCalendarHtml(form) : ""}
          <label class="search-field">
            <span>Club (optional quick target)</span>
            <select name="clubId" data-action="tests-schedule-form-field">
              <option value="">None</option>
              ${(orgData?.clubs || []).map((club) => `<option value="${escapeAttr(club.id)}" ${form.clubId === club.id ? "selected" : ""}>${escapeHtml(club.name)}</option>`).join("")}
            </select>
          </label>
          <label class="search-field">
            <span>Team (optional quick target)</span>
            <select name="teamId" data-action="tests-schedule-form-field">
              <option value="">None</option>
              ${(orgData?.teams || []).map((team) => `<option value="${escapeAttr(team.id)}" ${form.teamId === team.id ? "selected" : ""}>${escapeHtml(team.name)}</option>`).join("")}
            </select>
          </label>
          ${renderAthleteMultiSelectHtml(form)}
          <button type="submit" class="plain-button" data-tests-schedule-submit ${testsScheduleSubmitDisabled(form) ? "disabled" : ""}>${testsScheduleSubmitLabel(form)}</button>
        </form>
      `}
    </section>
  `;
}

function testsScheduleSubmitDisabled(form) {
  return form.submitting || (form.scheduleKind === "specific_dates" && !form.selectedDates.length);
}

function testsScheduleSubmitLabel(form) {
  if (form.submitting) return "Saving...";
  if (form.scheduleKind === "specific_dates") return `Schedule ${form.selectedDates.length} date${form.selectedDates.length === 1 ? "" : "s"}`;
  return form.editingScheduleId ? "Save changes" : "Create schedule";
}

// ------------------------------------------------------------
// Specific dates: click-and-drag calendar picker (state.tests.scheduleForm.
// calendarMonth/selectedDates). A single click toggles one date; a
// mousedown-then-drag-over-cells-then-mouseup selects the whole hovered
// range at once, same interaction shape as a booking-site date-range
// calendar. Drag tracking itself (mousedown/mouseover/mouseup) lives in
// tests-actions.js/app.js - this file only ever renders the CURRENT
// selectedDates/calendarMonth state, plus a live drag-preview class applied
// via direct DOM patching mid-drag (patchTestsCalendarDom), never a full
// re-render while the mouse button is down.
// ------------------------------------------------------------

const CALENDAR_WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthMatrix(monthIso) {
  const [year, month] = monthIso.split("-").map(Number);
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
  // Monday-first grid: JS getUTCDay() is 0=Sun..6=Sat; shift so Monday=0.
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    cells.push(iso);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function renderTestsCalendarHtml(form) {
  const monthIso = form.calendarMonth || new Date().toISOString().slice(0, 7);
  const cells = monthMatrix(monthIso);
  const [year, month] = monthIso.split("-").map(Number);
  const monthLabel = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const todayIso = new Date().toISOString().slice(0, 10);
  const selected = new Set(form.selectedDates);
  return `
    <div class="tests-calendar" data-tests-calendar>
      <div class="tests-calendar-head">
        <button type="button" class="plain-button icon-button" data-action="tests-calendar-prev-month" aria-label="Previous month">&larr;</button>
        <strong>${escapeHtml(monthLabel)}</strong>
        <button type="button" class="plain-button icon-button" data-action="tests-calendar-next-month" aria-label="Next month">&rarr;</button>
      </div>
      <div class="tests-calendar-weekdays">${CALENDAR_WEEKDAY_LABELS.map((label) => `<span>${label}</span>`).join("")}</div>
      <div class="tests-calendar-grid" data-tests-calendar-grid>
        ${cells.map((iso) => {
          if (!iso) return `<span class="tests-calendar-day tests-calendar-day-blank" aria-hidden="true"></span>`;
          const isPast = iso < todayIso;
          const isSelected = selected.has(iso);
          const dayNumber = Number(iso.slice(8, 10));
          return `<button type="button" class="tests-calendar-day ${isSelected ? "is-selected" : ""}" data-action="tests-calendar-day-mousedown" data-date="${escapeAttr(iso)}" ${isPast ? "disabled" : ""}>${dayNumber}</button>`;
        }).join("")}
      </div>
      <div class="tests-calendar-selected" data-tests-calendar-selected>
        ${renderTestsCalendarSelectedHtml(form)}
      </div>
    </div>
  `;
}

export function renderTestsCalendarSelectedHtml(form) {
  const dates = form.selectedDates.slice().sort();
  if (!dates.length) return `<p class="muted">No dates selected yet - click a day, or click and drag across several.</p>`;
  return `
    <p class="muted tests-calendar-count">${dates.length} date${dates.length === 1 ? "" : "s"} selected</p>
    <div class="tests-calendar-chips">
      ${dates.map((iso) => `
        <button type="button" class="tests-calendar-chip" data-action="tests-calendar-remove-date" data-date="${escapeAttr(iso)}" title="Remove ${escapeAttr(iso)}">
          ${escapeHtml(iso)} &times;
        </button>
      `).join("")}
    </div>
  `;
}

// Visible = currently-filtered-by-search AND already-scoped to this coach's
// own authorized roster (state.athletes is the same access-filtered roster
// Builder's own athlete picker reuses - see builder-modals.js's
// renderBuilderAthletePicker - so nothing outside this coach's access is
// ever offered here in the first place).
export function testsAthleteMultiSelectVisibleAthletes(form) {
  const roster = state.athletes || [];
  const search = form.athleteSearch.trim().toLowerCase();
  return search ? roster.filter((athlete) => (athlete.athlete || "").toLowerCase().includes(search)) : roster;
}

function renderAthleteMultiSelectHtml(form) {
  return `
    <div class="tests-athlete-picker">
      <label class="search-field">
        <span>Athletes (combinable with Team/Club above)</span>
        <input type="search" placeholder="Search athletes by name" value="${escapeAttr(form.athleteSearch)}" data-action="tests-schedule-athlete-search">
      </label>
      <div class="builder-athlete-select-all" data-tests-athlete-select-all>
        ${renderTestsAthleteSelectAllHtml(form)}
      </div>
      <div class="builder-athlete-options tests-athlete-options" data-tests-athlete-options>
        ${renderTestsAthleteOptionsHtml(form)}
      </div>
      <p class="muted tests-athlete-count" data-tests-athlete-count>${testsAthleteCountLabel(form)}</p>
    </div>
  `;
}

export function renderTestsAthleteSelectAllHtml(form) {
  const visible = testsAthleteMultiSelectVisibleAthletes(form);
  const selected = new Set(form.athleteIds);
  const allVisibleSelected = visible.length > 0 && visible.every((athlete) => selected.has(athlete.athlete_uuid));
  const search = form.athleteSearch.trim();
  return `
    <button type="button" class="checkbox-toggle-all ${allVisibleSelected ? "is-checked" : ""}" data-action="tests-schedule-select-all-athletes" aria-label="${allVisibleSelected ? "Uncheck all" : "Check all"}" ${visible.length ? "" : "disabled"}>
      <span aria-hidden="true">${allVisibleSelected ? "&#10003;" : ""}</span>
    </button>
    <span class="muted">Select all${search ? " (filtered)" : ""}</span>
    <button type="button" class="plain-button compact-button" data-action="tests-schedule-clear-all-athletes" ${form.athleteIds.length ? "" : "disabled"}>Clear all</button>
  `;
}

export function renderTestsAthleteOptionsHtml(form) {
  const visible = testsAthleteMultiSelectVisibleAthletes(form);
  const selected = new Set(form.athleteIds);
  if (!visible.length) return `<p class="muted">No athletes match "${escapeHtml(form.athleteSearch)}".</p>`;
  return visible.map((athlete) => {
    const isSelected = selected.has(athlete.athlete_uuid);
    return `
      <button type="button" class="builder-athlete-option ${isSelected ? "is-selected" : ""}" data-action="tests-schedule-toggle-athlete" data-athlete-uuid="${escapeAttr(athlete.athlete_uuid)}">
        <span class="builder-athlete-trigger-icon">${escapeHtml(initialsFor(athlete.athlete))}</span>
        <span><strong>${escapeHtml(athlete.athlete)}</strong><small>ID ${escapeHtml(athlete.athlete_id)}</small></span>
        <span class="builder-checkmark" aria-hidden="true">${isSelected ? "&#10003;" : ""}</span>
      </button>
    `;
  }).join("");
}

export function testsAthleteCountLabel(form) {
  return `${form.athleteIds.length} athlete${form.athleteIds.length === 1 ? "" : "s"} selected`;
}

// Targeted DOM patch (search box, select-all button, options list, count) -
// deliberately NOT a full renderTests(), which would replace #content's
// innerHTML and drop focus/cursor out of the search input mid-keystroke
// (the exact bug already fixed for Builder's create-name field - see
// frontend/tests/builder-performance-fixes.test.mjs's sibling issue).
export function patchTestsAthletePickerDom() {
  const form = state.tests.scheduleForm;
  const selectAllEl = document.querySelector("[data-tests-athlete-select-all]");
  if (selectAllEl) selectAllEl.innerHTML = renderTestsAthleteSelectAllHtml(form);
  const optionsEl = document.querySelector("[data-tests-athlete-options]");
  if (optionsEl) optionsEl.innerHTML = renderTestsAthleteOptionsHtml(form);
  const countEl = document.querySelector("[data-tests-athlete-count]");
  if (countEl) countEl.textContent = testsAthleteCountLabel(form);
}

// Targeted DOM patch for the Specific-dates calendar - same reasoning as
// patchTestsAthletePickerDom above: called on every mousedown/mouseover
// during a drag selection, so it must never do a full renderTests() (would
// abort the drag by replacing the very grid the mouse is over). Only the
// day cells' own is-selected class and the selected-dates summary are
// touched; the month header/grid structure itself doesn't change here
// (that's patchTestsCalendarDom's caller's job when the month itself
// changes - see tests-calendar-prev-month/-next-month, which do a full
// renderTests() since there's no drag in progress at that point).
export function patchTestsCalendarDom() {
  const form = state.tests.scheduleForm;
  const selected = new Set(form.selectedDates);
  const gridEl = document.querySelector("[data-tests-calendar-grid]");
  if (gridEl) {
    gridEl.querySelectorAll("[data-date]").forEach((cell) => {
      cell.classList.toggle("is-selected", selected.has(cell.dataset.date));
    });
  }
  const selectedEl = document.querySelector("[data-tests-calendar-selected]");
  if (selectedEl) selectedEl.innerHTML = renderTestsCalendarSelectedHtml(form);
  // The submit button's own label/disabled state depends on
  // selectedDates.length too (see testsScheduleSubmitLabel/-Disabled) -
  // it lives outside both patched regions above, so a drag that never
  // reaches a full renderTests() would otherwise leave it showing a stale
  // "Schedule 0 dates"/disabled from whatever render last touched it. Found
  // live: dragging a real range in the browser selected the days
  // correctly but the button stayed disabled until something else forced a
  // full re-render - this patch is what closes that gap.
  const submitEl = document.querySelector("[data-tests-schedule-submit]");
  if (submitEl) {
    submitEl.disabled = testsScheduleSubmitDisabled(form);
    submitEl.textContent = testsScheduleSubmitLabel(form);
  }
}

// ------------------------------------------------------------
// Coach: Results
// ------------------------------------------------------------

function renderCoachResultsHtml() {
  const rows = state.tests.results;
  if (!rows.length) return `<p class="muted tests-empty">No WELLNESS results yet.</p>`;
  return `
    <div class="tests-results-table">
      ${rows.map((row) => `
        <button class="panel tests-assignment-card" type="button" data-action="tests-open-result" data-assessment-id="${escapeAttr(row.assessmentId)}">
          <div class="tests-assignment-card-head">
            <span class="tests-assignment-card-title">${escapeHtml(row.athleteName)}</span>
            <span class="muted">${escapeHtml(formatDateTime(row.completedAt))}</span>
          </div>
          <p class="tests-score-inline">Wellness score: ${row.wellnessScore != null ? row.wellnessScore.toFixed(1) : "-"}/10</p>
          ${row.injury ? `<p class="tests-injury-flag">Injury reported</p>` : ""}
        </button>
      `).join("")}
    </div>
  `;
}

// ------------------------------------------------------------
// Coach: Test Library (read-only)
// ------------------------------------------------------------

function renderCoachLibraryHtml() {
  const { tests, batteries } = state.tests.library;
  return `
    <div class="tests-library">
      <h3>Tests</h3>
      <div class="tests-card-list">
        ${tests.map((t) => `
          <div class="panel tests-assignment-card">
            <div class="tests-assignment-card-head">
              <span class="tests-assignment-card-title">${escapeHtml(t.name)}</span>
              ${t.schedulable ? `<span class="tests-status-pill tests-status-completed">Schedulable</span>` : `<span class="tests-status-pill">Read-only</span>`}
            </div>
            ${t.description ? `<p class="muted">${escapeHtml(t.description)}</p>` : ""}
          </div>
        `).join("")}
      </div>
      <h3>Batteries</h3>
      <div class="tests-card-list">
        ${batteries.map((b) => `
          <div class="panel tests-assignment-card">
            <div class="tests-assignment-card-head">
              <span class="tests-assignment-card-title">${escapeHtml(b.name)}</span>
              <span class="tests-status-pill">Read-only</span>
            </div>
            ${b.description ? `<p class="muted">${escapeHtml(b.description)}</p>` : ""}
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

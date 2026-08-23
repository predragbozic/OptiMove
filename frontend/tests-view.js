import { isAthleteMode } from "./access.js";
import { els } from "./dom.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml, initialsFor } from "./utils.js";

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
  const sections = isAthleteMode()
    ? [["today", "Today"], ["upcoming", "Upcoming"], ["history", "History"]]
    : [["today", "Today"], ["schedule", "Schedule"], ["results", "Results"], ["library", "Test Library"]];
  return `
    <nav class="tabs tests-section-tabs" aria-label="Tests sections">
      ${sections.map(([value, label]) => `
        <button class="tab ${state.tests.section === value ? "is-active" : ""}" type="button" data-action="tests-section" data-section="${escapeAttr(value)}">${escapeHtml(label)}</button>
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
        <span class="avatar-fallback wellness-avatar">${escapeHtml(initialsFor(form.athleteName))}</span>
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
        <span class="avatar-fallback wellness-avatar">${escapeHtml(initialsFor(form.athleteName))}</span>
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
    ${state.tests.scheduleDetail ? renderScheduleDetailHtml() : renderScheduleListHtml()}
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
      ${row.status === "cancelled" ? "" : `
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
      <div class="tests-schedule-actions">
        ${schedule.status !== "cancelled" ? `<button type="button" class="plain-button compact-button" data-action="tests-open-edit-schedule" data-schedule-id="${escapeAttr(schedule.id)}">Edit</button>` : ""}
        ${schedule.status === "active"
          ? `<button type="button" class="plain-button compact-button" data-action="tests-set-schedule-status" data-schedule-id="${escapeAttr(schedule.id)}" data-status="paused">Pause</button>`
          : schedule.status === "paused"
            ? `<button type="button" class="plain-button compact-button" data-action="tests-set-schedule-status" data-schedule-id="${escapeAttr(schedule.id)}" data-status="active">Activate</button>`
            : ""}
        ${schedule.status !== "cancelled" ? `<button type="button" class="plain-button compact-button tests-delete-button" data-action="tests-delete-schedule" data-schedule-id="${escapeAttr(schedule.id)}" data-test-name="${escapeAttr(schedule.testName)}" data-has-occurrences="${schedule.hasOccurrences ? "true" : "false"}" ${state.tests.deletingScheduleId === schedule.id ? "disabled" : ""}>${state.tests.deletingScheduleId === schedule.id ? "Deleting..." : "Delete"}</button>` : ""}
      </div>
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
  const blockedOneTimeEdit = isEdit && form.scheduleKind === "one_time" && form.hasOccurrences;
  return `
    <section class="panel tests-schedule-form">
      <button type="button" class="plain-button icon-button wellness-back" data-action="tests-close-schedule-form" aria-label="Close">&times;</button>
      <h3>${isEdit ? "Edit WELLNESS schedule" : "New WELLNESS schedule"}</h3>
      ${form.error ? `<p class="builder-error">${escapeHtml(form.error)}</p>` : ""}
      ${blockedOneTimeEdit ? `
        <p class="muted">This one-time schedule already has its occurrence and can no longer be edited. Cancel or delete it instead, then create a new one.</p>
      ` : `
        ${isEdit && form.scheduleKind === "daily" && form.hasOccurrences ? `<p class="tests-future-only-notice">Changes apply to future occurrences only - already-generated occurrences and assignments are not affected.</p>` : ""}
        <form data-tests-form="${isEdit ? "edit-schedule" : "create-schedule"}">
          <label class="search-field">
            <span>Recurrence</span>
            <select name="scheduleKind" data-action="tests-schedule-form-field">
              <option value="one_time" ${form.scheduleKind === "one_time" ? "selected" : ""}>One-time</option>
              <option value="daily" ${form.scheduleKind === "daily" ? "selected" : ""}>Daily</option>
            </select>
          </label>
          <label class="search-field">
            <span>Timezone</span>
            <input type="text" name="timezone" value="${escapeAttr(form.timezone)}" data-action="tests-schedule-form-field" required>
          </label>
          <label class="search-field">
            <span>Start date</span>
            <input type="date" name="startDate" value="${escapeAttr(form.startDate)}" data-action="tests-schedule-form-field" required>
          </label>
          <label class="search-field">
            <span>Opens</span>
            <input type="time" name="opensTime" value="${escapeAttr(form.opensTime)}" data-action="tests-schedule-form-field" required>
          </label>
          <label class="search-field">
            <span>Closes</span>
            <input type="time" name="closesTime" value="${escapeAttr(form.closesTime)}" data-action="tests-schedule-form-field" required>
          </label>
          <label class="search-field">
            <span>Team (optional quick target)</span>
            <select name="teamId" data-action="tests-schedule-form-field">
              <option value="">None</option>
              ${(orgData?.teams || []).map((team) => `<option value="${escapeAttr(team.id)}" ${form.teamId === team.id ? "selected" : ""}>${escapeHtml(team.name)}</option>`).join("")}
            </select>
          </label>
          <label class="search-field">
            <span>Club (optional quick target)</span>
            <select name="clubId" data-action="tests-schedule-form-field">
              <option value="">None</option>
              ${(orgData?.clubs || []).map((club) => `<option value="${escapeAttr(club.id)}" ${form.clubId === club.id ? "selected" : ""}>${escapeHtml(club.name)}</option>`).join("")}
            </select>
          </label>
          ${renderAthleteMultiSelectHtml(form)}
          <button type="submit" class="plain-button" ${form.submitting ? "disabled" : ""}>${form.submitting ? "Saving..." : isEdit ? "Save changes" : "Create schedule"}</button>
        </form>
      `}
    </section>
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

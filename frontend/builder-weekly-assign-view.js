// Weekly program templates (docs/ai/weekly-program-template-plan.md, part WT-B):
// the dated assign dialog and its question. Pure template strings; the actions
// are builder-weekly-assign-actions.js.
import { athleteFilterAttrs, matchingAthletes, renderAthleteFilter, sortAthletes } from "./athlete-list-tools.js";
import { renderImage } from "./media.js";
import { escapeAttr, escapeHtml, formatDate, initialsFor, localDateIso } from "./utils.js";
const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function shortDay(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  return `${WEEKDAY[(date.getUTCDay() + 6) % 7]} ${String(date.getUTCDate()).padStart(2, "0")}.${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
function addDays(iso, days) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function weeklyAssignPreviewText(startDate, weekCount) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ""))) return "Choose the date of Day 1.";
  const last = addDays(startDate, weekCount * 7 - 1);
  return `Day 1 is ${shortDay(startDate)}, the last day ${shortDay(last)} ${last.slice(0, 4)}. Each day goes into the athlete's weekly plan of its week.`;
}

const REASON_TEXT = { has_results: "has results", linked_to_event: "is linked to an event" };
const CANNOT_TEXT = {
  not_editable: "You can't change this week. It stays as it is.",
  being_edited: "Someone is editing this week right now. It stays as it is.",
  several_plans: "This week has more than one plan. It stays as it is.",
};

function renderConflictHtml(conflict, changedAgain = false) {
  const keptCount = conflict.athletes.reduce((n, a) => n + a.weeks.reduce((m, w) => m + (w.kept || []).length, 0), 0);
  return `
    <div class="builder-tw-conflict" data-tw-conflict tabindex="-1">
      ${changedAgain ? `<p class="builder-tw-conflict-changed"><strong>The plans changed since you looked. Check again.</strong></p>` : ""}
      <p class="builder-tw-conflict-title" role="alert"><strong>${conflict.athletes.length} athlete${conflict.athletes.length === 1 ? "" : "s"} already ${conflict.athletes.length === 1 ? "has" : "have"} plans in these weeks.</strong></p>
      ${conflict.newWeeks ? `<p class="muted">${conflict.newWeeks} new weekly plan${conflict.newWeeks === 1 ? " is" : "s are"} created either way, where there is no plan yet.</p>` : ""}
      <ul class="builder-tw-conflict-list">
        ${conflict.athletes.map((athlete) => `
          <li><strong>${escapeHtml(athlete.name || "Athlete")}</strong>
            <ul>${athlete.weeks.map((week) => `
              <li>Week of ${escapeHtml(formatDate(week.weekStart))}: ${week.cannot
                ? escapeHtml(CANNOT_TEXT[week.cannot] || CANNOT_TEXT.not_editable)
                : `${(week.contentDays || []).length ? `planned on ${escapeHtml(week.contentDays.map(shortDay).join(", "))}` : "a plan without sessions on these days"}${week.draft ? " (not published yet: it stays a draft)" : ""}`}
                ${(week.kept || []).length ? `<ul class="builder-tw-kept">${week.kept.map((k) => `<li>${escapeHtml(k.name || "Session")} · ${escapeHtml(shortDay(k.day))}${k.amPm ? ` · ${escapeHtml(k.amPm)}` : ""} ${escapeHtml(k.reasons.map((r) => REASON_TEXT[r] || r).join(" and "))}, so it stays.</li>`).join("")}</ul>` : ""}
              </li>`).join("")}</ul>
          </li>`).join("")}
      </ul>
      <p class="muted">Replace: the program's days take the place of what is planned on those days${keptCount ? "; sessions with results or a link to an event stay, and the program's sessions follow them" : ""}. Days outside the program are not changed.</p>
      <div class="builder-tw-conflict-actions">
        <button class="plain-button danger-action" type="button" data-action="builder-tw-assign-choice" data-choice="replace">Replace</button>
        <button class="plain-button" type="button" data-action="builder-tw-assign-choice" data-choice="skip">Skip weeks that already have a plan</button>
        <button class="plain-button" type="button" data-action="builder-tw-assign-back">Back</button>
      </div>
    </div>
  `;
}

export function renderWeeklyAssignModalHtml(state) {
  const assign = state.builder.weeklyAssign;
  if (!assign?.open) return "";
  const draft = state.builder.draft;
  const weekCount = Number(draft?.plan?.weekCount) || 1;
  const selected = new Set((assign.athleteIds || []).map(String));
  const shown = matchingAthletes(state.athletes || [], "builder-tw-assign").map((a) => String(a.athlete_id)).filter(Boolean);
  const allShown = shown.length > 0 && shown.every((id) => selected.has(id));
  const startDate = assign.startDate || localDateIso();
  if (assign.result) {
    const r = assign.result;
    return `
      <div class="builder-modal-overlay">
        <button class="builder-modal-backdrop" type="button" data-action="builder-tw-assign-close" aria-label="Close"></button>
        <section class="panel builder-compact-modal builder-tw-assign-modal" role="dialog" aria-modal="true" aria-label="Program assigned">
          <div class="builder-modal-head"><div><p class="eyebrow">Assign weekly program</p><h3>${escapeHtml(draft.plan.name || "Weekly program")}</h3></div></div>
          ${r.created.length + r.replaced.length === 0
            ? `<p role="status"><strong>Nothing was assigned:</strong> every week already had a plan and was left as it was.</p>`
            : `<p role="status"><strong>Assigned.</strong> ${r.created.length} new weekly plan${r.created.length === 1 ? "" : "s"}${r.replaced.length ? `, ${r.replaced.length} week${r.replaced.length === 1 ? "" : "s"} replaced` : ""}${r.skipped.length ? `, ${r.skipped.length} week${r.skipped.length === 1 ? "" : "s"} left as ${r.skipped.length === 1 ? "it was" : "they were"}` : ""}.${r.kept ? ` ${r.kept} session${r.kept === 1 ? "" : "s"} with results or an event link stayed.` : ""}</p>`}
          <p class="muted">The athletes' weeks are a copy: changing this template later does not change them.</p>
          <div class="builder-copy-plan-footer"><span></span><button class="plain-button" type="button" data-action="builder-tw-assign-close">Done</button></div>
        </section>
      </div>`;
  }
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-tw-assign-close" aria-label="Close assignment setup"></button>
      <section class="panel builder-compact-modal builder-tw-assign-modal${assign.conflict ? " is-question" : " builder-copy-plan-modal"}" ${assign.conflict ? "" : "data-athlete-filter-scope"} role="dialog" aria-modal="true" aria-label="Assign weekly program">
        <div class="builder-modal-head">
          <div>
            <p class="eyebrow">Assign weekly program</p>
            <h3>${escapeHtml(draft.plan.name || "Weekly program")}</h3>
            <p class="muted">${weekCount} week${weekCount === 1 ? "" : "s"} go into each athlete's weekly plans, starting on the date you choose.</p>
          </div>
          <button class="plain-button icon-button" type="button" data-action="builder-tw-assign-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        ${assign.conflict ? renderConflictHtml(assign.conflict, assign.changedAgain) : `
          <label class="search-field builder-copy-week"><span>Start date (Day 1)</span><input data-tw-start-date type="date" value="${escapeAttr(startDate)}" required><small data-tw-start-preview>${escapeHtml(weeklyAssignPreviewText(startDate, weekCount))}</small></label>
          ${renderAthleteFilter("builder-tw-assign", state.athletes || [])}
          <div class="builder-athlete-select-all">
            <button class="checkbox-toggle-all ${allShown ? "is-checked" : ""}" type="button" data-athlete-select-all data-action="builder-tw-assign-toggle-all" aria-label="${allShown ? "Uncheck all shown athletes" : "Check all shown athletes"}" ${shown.length ? "" : "disabled"}><span aria-hidden="true">${allShown ? "&#10003;" : ""}</span></button>
            <span class="muted">Select all shown athletes</span>
          </div>
          <div class="builder-athlete-options">
            ${sortAthletes(state.athletes || []).map((athlete) => {
              const isSelected = selected.has(String(athlete.athlete_id));
              return `<button class="builder-athlete-option ${isSelected ? "is-selected" : ""}" ${athleteFilterAttrs(athlete, "builder-tw-assign")} type="button" data-action="builder-tw-assign-toggle" data-athlete-id="${escapeAttr(athlete.athlete_id)}" aria-pressed="${isSelected}">
                ${athlete.athlete_image_url || athlete.image_url ? renderImage(athlete.athlete_image_url || athlete.image_url, "builder-athlete-avatar") : `<span class="builder-athlete-trigger-icon">${escapeHtml(initialsFor(athlete.athlete))}</span>`}
                <span><strong>${escapeHtml(athlete.athlete)}</strong><small>ID ${escapeHtml(athlete.athlete_id)}</small></span>
                <span class="builder-checkmark" aria-hidden="true">${isSelected ? "&#10003;" : ""}</span>
              </button>`;
            }).join("")}
          </div>`}
        ${assign.error ? `<p class="builder-error" role="alert">${escapeHtml(assign.error)}</p>` : ""}
        ${assign.conflict ? "" : `
          <div class="builder-copy-plan-footer">
            <span class="muted">${selected.size ? `${selected.size} athlete${selected.size === 1 ? "" : "s"} selected` : "Choose at least one athlete"}</span>
            <button class="plain-button" type="button" data-action="builder-tw-assign-submit" ${selected.size && !assign.sending ? "" : "disabled"}>${assign.sending ? "Assigning…" : "Assign"}</button>
          </div>`}
      </section>
    </div>
  `;
}

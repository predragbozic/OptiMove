// Weekly program templates in the Builder (docs/ai/weekly-program-template-plan.md):
// the week strip, the dated assign dialog with its one question, and Save as
// template from chosen weeks. Pure template strings; the actions are
// builder-weekly-template-actions.js.
import { athleteFilterAttrs, matchingAthletes, renderAthleteFilter, sortAthletes } from "./athlete-list-tools.js";
import { renderImage } from "./media.js";
import { escapeAttr, escapeHtml, formatDate, initialsFor, localDateIso } from "./utils.js";

export const isWeeklyTemplateDraft = (draft) => draft?.plan?.planType === "program" && draft?.plan?.templateKind === "weekly";
export const weekOfBlock = (block) => Math.floor((Number(block.index) - 1) / 7) + 1;
export const dayOfBlock = (block) => ((Number(block.index) - 1) % 7) + 1;

// The week on screen, kept inside the template's weeks.
export function currentTemplateWeek(state) {
  const count = Number(state.builder.draft?.plan?.weekCount) || 1;
  const week = Number(state.builder.templateWeek) || 1;
  return Math.min(Math.max(week, 1), count);
}

export function templateWeekBlocks(draft, week) {
  return (draft.blocks || []).filter((block) => weekOfBlock(block) === week).sort((a, b) => a.index - b.index);
}

const sessionCount = (draft, week) => templateWeekBlocks(draft, week).reduce((n, block) => n + (block.sessions || []).length, 0);

export function renderTemplateWeekStripHtml(state) {
  const draft = state.builder.draft;
  const count = Number(draft.plan.weekCount) || 1;
  const week = currentTemplateWeek(state);
  const busy = Boolean(state.builder.templateWeekBusy);
  const confirm = Number(state.builder.templateWeekDeleteConfirm) === week;
  const tabs = Array.from({ length: count }, (_, i) => i + 1).map((w) => {
    const n = sessionCount(draft, w);
    return `<button class="builder-week-tab${w === week ? " is-active" : ""}" type="button" role="tab" aria-selected="${w === week}" data-action="builder-tw-select-week" data-week="${w}">
      <strong>Week ${w}</strong><small>${n} session${n === 1 ? "" : "s"}</small></button>`;
  }).join("");
  return `
    <div class="builder-week-strip">
      <div class="builder-week-tabs" role="tablist" aria-label="Template weeks">
        ${tabs}
        <button class="builder-week-tab builder-week-add" type="button" data-action="builder-tw-add-week" ${busy || count >= 52 ? "disabled" : ""} aria-label="Add an empty week"><strong>+ Week</strong><small>Empty</small></button>
      </div>
      <div class="builder-week-actions" role="group" aria-label="Week ${week}">
        <button class="plain-button compact-button" type="button" data-action="builder-tw-duplicate-week" data-week="${week}" ${busy || count >= 52 ? "disabled" : ""}>Duplicate week ${week}</button>
        <button class="plain-button compact-button" type="button" data-action="builder-tw-move-week" data-week="${week}" data-to="${week - 1}" ${busy || week === 1 ? "disabled" : ""} aria-label="Move week ${week} earlier">&larr; Earlier</button>
        <button class="plain-button compact-button" type="button" data-action="builder-tw-move-week" data-week="${week}" data-to="${week + 1}" ${busy || week === count ? "disabled" : ""} aria-label="Move week ${week} later">Later &rarr;</button>
        ${count > 1 ? `<button class="plain-button compact-button danger-action" type="button" data-action="builder-tw-delete-week" data-week="${week}" ${busy ? "disabled" : ""}>Delete week ${week}</button>` : ""}
      </div>
      ${confirm ? `
        <div class="builder-week-confirm" role="alertdialog" aria-label="Delete week ${week}">
          <p>Delete week ${week}${sessionCount(draft, week) ? ` and its ${sessionCount(draft, week)} session${sessionCount(draft, week) === 1 ? "" : "s"}` : ""}? The weeks after it move up.</p>
          <div class="builder-week-confirm-actions">
            <button class="plain-button danger-action" type="button" data-action="builder-tw-delete-week-confirm" data-week="${week}">Delete week</button>
            <button class="plain-button" type="button" data-action="builder-tw-delete-week-cancel">Cancel</button>
          </div>
        </div>` : ""}
      ${state.builder.templateNotice ? `<p class="builder-tw-notice" role="status">${escapeHtml(state.builder.templateNotice)}</p>` : ""}
      ${state.builder.templateWeekError ? `<p class="builder-error" role="alert">${escapeHtml(state.builder.templateWeekError)}</p>` : ""}
    </div>
  `;
}

// ---- assign from a date ----------------------------------------------------

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

// ---- save as template from chosen weeks ------------------------------------

export function renderSaveWeeksModalHtml(state) {
  const save = state.builder.saveWeeks;
  if (!save?.open) return "";
  const selected = new Set((save.planIds || []).map(String));
  const plans = save.plans || [];
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-tw-save-close" aria-label="Close"></button>
      <section class="panel builder-compact-modal builder-tw-save-modal" role="dialog" aria-modal="true" aria-label="Save weeks as template">
        <div class="builder-modal-head">
          <div>
            <p class="eyebrow">Save as template</p>
            <h3>${escapeHtml(save.athleteName || "Athlete")}'s weeks</h3>
            <p class="muted">Choose any weeks. Each becomes one template week, in date order. Only the plan is copied: no results, RPE or event links.</p>
          </div>
          <button class="plain-button icon-button" type="button" data-action="builder-tw-save-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        <label class="search-field"><span>Template name</span><input data-tw-save-name value="${escapeAttr(save.name || "")}" placeholder="e.g. Preseason weeks" required></label>
        ${save.loading ? `<p class="muted" role="status">Loading weeks…</p>` : plans.length ? `
          <div class="builder-athlete-options builder-tw-week-options">
            ${plans.map((plan) => {
              const isSelected = selected.has(String(plan.plan_id));
              return `<button class="builder-athlete-option ${isSelected ? "is-selected" : ""}" type="button" data-action="builder-tw-save-toggle" data-plan-id="${escapeAttr(plan.plan_id)}" aria-pressed="${isSelected}">
                <span><strong>Week of ${escapeHtml(formatDate(plan.week_start))}${String(plan.plan_id) === String(save.currentPlanId) ? " (open now)" : ""}</strong><small>${escapeHtml(plan.plan_name || "Weekly plan")} · ${Number(plan.session_count) || 0} session${Number(plan.session_count) === 1 ? "" : "s"}</small></span>
                <span class="builder-checkmark" aria-hidden="true">${isSelected ? "&#10003;" : ""}</span>
              </button>`;
            }).join("")}
          </div>` : `<p class="muted">This athlete has no weekly plans yet.</p>`}
        ${save.error ? `<p class="builder-error" role="alert">${escapeHtml(save.error)}</p>` : ""}
        <div class="builder-copy-plan-footer">
          <span class="muted">${selected.size ? `${selected.size} week${selected.size === 1 ? "" : "s"} chosen` : "Choose at least one week"}</span>
          <button class="plain-button" type="button" data-action="builder-tw-save-submit" ${selected.size && !save.sending ? "" : "disabled"}>${save.sending ? "Saving…" : "Save template"}</button>
        </div>
      </section>
    </div>
  `;
}

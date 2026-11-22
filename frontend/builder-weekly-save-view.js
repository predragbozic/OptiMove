// Weekly program templates (docs/ai/weekly-program-template-plan.md, part WT-C):
// the Save as template dialog. Pure template strings; the actions are
// builder-weekly-save-actions.js.
import { escapeAttr, escapeHtml, formatDate } from "./utils.js";

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

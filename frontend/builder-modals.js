import { renderImage } from "./media.js";
import { escapeAttr, escapeHtml, initialsFor, localDateIso, weekMondayIso } from "./utils.js";

export function renderBuilderAthletePicker(state) {
  return `
    <div class="builder-athlete-overlay">
      <button class="builder-athlete-backdrop" type="button" data-action="builder-close-athlete-picker" aria-label="Close athlete picker"></button>
      <section class="panel builder-athlete-picker" role="dialog" aria-modal="true" aria-label="Assign athlete">
        <div class="builder-section-panel-head"><div><p class="eyebrow">Draft assignment</p><h3>Assign an athlete</h3><p class="muted">Choose an athlete or keep this draft reusable.</p></div><button class="plain-button icon-button" type="button" data-action="builder-close-athlete-picker" aria-label="Close athlete picker"><span class="button-icon">×</span></button></div>
        ${state.builder.planType === "weekly" ? "" : `<button class="builder-athlete-option ${state.builder.createAthleteId ? "" : "is-selected"}" type="button" data-action="builder-select-athlete" data-athlete-id="">
          <span class="builder-athlete-trigger-icon">+</span><span><strong>Reusable template</strong><small>Not assigned to an athlete</small></span>
        </button>`}
        <div class="builder-athlete-options">
          ${state.athletes.map((athlete) => `
            <button class="builder-athlete-option ${String(athlete.athlete_id) === String(state.builder.createAthleteId) ? "is-selected" : ""}" type="button" data-action="builder-select-athlete" data-athlete-id="${escapeAttr(athlete.athlete_id)}">
              ${athlete.athlete_image_url || athlete.image_url ? renderImage(athlete.athlete_image_url || athlete.image_url, "builder-athlete-avatar") : `<span class="builder-athlete-trigger-icon">${escapeHtml(initialsFor(athlete.athlete))}</span>`}
              <span><strong>${escapeHtml(athlete.athlete)}</strong><small>ID ${escapeHtml(athlete.athlete_id)}</small></span>
            </button>
          `).join("")}
        </div>
      </section>
    </div>
  `;
}

export function renderCopyPlanModal(state) {
  if (!state.builder.copyPlanId) return "";
  const selectedAthlete = state.athletes.find((athlete) => String(athlete.athlete_id) === String(state.builder.copyAthleteId));
  const isWeeklyCopy = state.builder.copyPlanType === "weekly";
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-close-copy-plan" aria-label="Close copy setup"></button>
      <section class="panel builder-compact-modal builder-copy-plan-modal" role="dialog" aria-modal="true" aria-label="Create editable copy">
        <div class="builder-modal-head"><div><p class="eyebrow">Editable copy</p><h3>${escapeHtml(state.builder.copyPlanName || "Program")}</h3><p class="muted">${isWeeklyCopy ? "Choose an athlete and the new week for this independent copy." : "Choose an athlete for a specific program, or keep the copy reusable as a template."}</p></div><button class="plain-button icon-button" type="button" data-action="builder-close-copy-plan" aria-label="Close"><span class="button-icon">x</span></button></div>
        ${isWeeklyCopy ? `<label class="search-field builder-copy-week"><span>Target week</span><input data-builder-copy-week-start type="date" value="${escapeAttr(state.builder.copyWeekStart || weekMondayIso(localDateIso()))}"><small>The copied week will begin on Monday.</small></label>` : `<button class="builder-athlete-option ${state.builder.copyAthleteId ? "" : "is-selected"}" type="button" data-action="builder-select-copy-athlete" data-athlete-id=""><span class="builder-athlete-trigger-icon">+</span><span><strong>Reusable template</strong><small>Keep this editable copy unassigned</small></span></button>`}
        <div class="builder-athlete-options">
          ${state.athletes.map((athlete) => `
            <button class="builder-athlete-option ${String(athlete.athlete_id) === String(state.builder.copyAthleteId) ? "is-selected" : ""}" type="button" data-action="builder-select-copy-athlete" data-athlete-id="${escapeAttr(athlete.athlete_id)}">
              ${athlete.athlete_image_url || athlete.image_url ? renderImage(athlete.athlete_image_url || athlete.image_url, "builder-athlete-avatar") : `<span class="builder-athlete-trigger-icon">${escapeHtml(initialsFor(athlete.athlete))}</span>`}
              <span><strong>${escapeHtml(athlete.athlete)}</strong><small>ID ${escapeHtml(athlete.athlete_id)}</small></span>
            </button>
          `).join("")}
        </div>
        <div class="builder-copy-plan-footer"><span class="muted">${selectedAthlete ? `${isWeeklyCopy ? "Weekly plan for" : "Specific program for"} ${escapeHtml(selectedAthlete.athlete)}` : isWeeklyCopy ? "Choose an athlete" : "Reusable template"}</span><button class="plain-button" type="button" data-action="builder-confirm-duplicate-plan" ${isWeeklyCopy && !selectedAthlete ? "disabled" : ""}>Create editable copy</button></div>
      </section>
    </div>
  `;
}

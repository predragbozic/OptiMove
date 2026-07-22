import { renderImage } from "./media.js";
import { escapeAttr, escapeHtml, initialsFor, localDateIso, weekMondayIso } from "./utils.js";

export function renderBuilderAthletePicker(state) {
  const selectedIds = new Set((state.builder.createAthleteIds || []).map(String));
  const selectedCount = selectedIds.size;
  const isWeekly = state.builder.planType === "weekly";
  const athleteIds = (state.athletes || []).map((athlete) => String(athlete.athlete_id)).filter(Boolean);
  const allSelected = athleteIds.length > 0 && athleteIds.every((id) => selectedIds.has(id));
  return `
    <div class="builder-athlete-overlay">
      <button class="builder-athlete-backdrop" type="button" data-action="builder-close-athlete-picker" aria-label="Close athlete picker"></button>
      <section class="panel builder-athlete-picker" role="dialog" aria-modal="true" aria-label="Assign athletes">
        <div class="builder-section-panel-head">
          <div>
            <p class="eyebrow">Draft assignment</p>
            <h3>${isWeekly ? "Choose athletes" : "Choose athletes or template"}</h3>
            <p class="muted">${isWeekly ? "A separate weekly plan will be created for each selected athlete." : "Select one or more athletes, or keep this as a reusable template."}</p>
          </div>
          <button class="plain-button icon-button" type="button" data-action="builder-close-athlete-picker" aria-label="Close athlete picker"><span class="button-icon">x</span></button>
        </div>
        ${isWeekly ? "" : `<button class="builder-athlete-option ${selectedCount ? "" : "is-selected"}" type="button" data-action="builder-select-athlete" data-athlete-id="">
          <span class="builder-athlete-trigger-icon">+</span><span><strong>Reusable template</strong><small>Not assigned to an athlete</small></span>
        </button>`}
        <div class="builder-athlete-select-all">
          <button class="checkbox-toggle-all ${allSelected ? "is-checked" : ""}" type="button" data-action="builder-toggle-select-all-athletes" aria-label="${allSelected ? "Uncheck all athletes" : "Check all athletes"}" ${athleteIds.length ? "" : "disabled"}>
            <span aria-hidden="true">${allSelected ? "&#10003;" : ""}</span>
          </button>
          <span class="muted">Select all athletes</span>
        </div>
        <div class="builder-athlete-options" data-builder-athlete-list>
          ${state.athletes.map((athlete) => {
            const isSelected = selectedIds.has(String(athlete.athlete_id));
            return `
              <button class="builder-athlete-option ${isSelected ? "is-selected" : ""}" type="button" data-action="builder-select-athlete" data-athlete-id="${escapeAttr(athlete.athlete_id)}">
                ${athlete.athlete_image_url || athlete.image_url ? renderImage(athlete.athlete_image_url || athlete.image_url, "builder-athlete-avatar") : `<span class="builder-athlete-trigger-icon">${escapeHtml(initialsFor(athlete.athlete))}</span>`}
                <span><strong>${escapeHtml(athlete.athlete)}</strong><small>ID ${escapeHtml(athlete.athlete_id)}</small></span>
                <span class="builder-checkmark" aria-hidden="true">${isSelected ? "&#10003;" : ""}</span>
              </button>
            `;
          }).join("")}
        </div>
        <div class="builder-copy-plan-footer">
          <span class="muted">${selectedCount ? `${selectedCount} athlete${selectedCount === 1 ? "" : "s"} selected` : isWeekly ? "Choose at least one athlete" : "Reusable template"}</span>
          <button class="plain-button" type="button" data-action="builder-confirm-athlete-picker" ${isWeekly && !selectedCount ? "disabled" : ""}>Continue</button>
        </div>
      </section>
    </div>
  `;
}

export function renderCopyPlanModal(state) {
  if (!state.builder.copyPlanId) return "";
  const selectedIds = new Set((state.builder.copyAthleteIds || []).map(String));
  const selectedAthletes = state.athletes.filter((athlete) => selectedIds.has(String(athlete.athlete_id)));
  const selectedCount = selectedAthletes.length;
  const isWeeklyCopy = state.builder.copyPlanType === "weekly";
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-close-copy-plan" aria-label="Close copy setup"></button>
      <section class="panel builder-compact-modal builder-copy-plan-modal" role="dialog" aria-modal="true" aria-label="Create editable copy">
        <div class="builder-modal-head">
          <div>
            <p class="eyebrow">Editable copy</p>
            <h3>${escapeHtml(state.builder.copyPlanName || "Program")}</h3>
            <p class="muted">${isWeeklyCopy ? "Choose athletes and the new week. Each athlete gets an independent copy." : "Choose athletes for specific copies, or keep the copy reusable as a template."}</p>
          </div>
          <button class="plain-button icon-button" type="button" data-action="builder-close-copy-plan" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        ${isWeeklyCopy ? `<label class="search-field builder-copy-week"><span>Target week</span><input data-builder-copy-week-start type="date" value="${escapeAttr(state.builder.copyWeekStart || weekMondayIso(localDateIso()))}"><small>The copied week will begin on Monday.</small></label>` : `<button class="builder-athlete-option ${selectedCount ? "" : "is-selected"}" type="button" data-action="builder-select-copy-athlete" data-athlete-id=""><span class="builder-athlete-trigger-icon">+</span><span><strong>Reusable template</strong><small>Keep this editable copy unassigned</small></span></button>`}
        <div class="builder-athlete-options">
          ${state.athletes.map((athlete) => {
            const isSelected = selectedIds.has(String(athlete.athlete_id));
            return `
              <button class="builder-athlete-option ${isSelected ? "is-selected" : ""}" type="button" data-action="builder-select-copy-athlete" data-athlete-id="${escapeAttr(athlete.athlete_id)}">
                ${athlete.athlete_image_url || athlete.image_url ? renderImage(athlete.athlete_image_url || athlete.image_url, "builder-athlete-avatar") : `<span class="builder-athlete-trigger-icon">${escapeHtml(initialsFor(athlete.athlete))}</span>`}
                <span><strong>${escapeHtml(athlete.athlete)}</strong><small>ID ${escapeHtml(athlete.athlete_id)}</small></span>
                <span class="builder-checkmark" aria-hidden="true">${isSelected ? "&#10003;" : ""}</span>
              </button>
            `;
          }).join("")}
        </div>
        <div class="builder-copy-plan-footer">
          <span class="muted">${selectedCount ? `${selectedCount} athlete${selectedCount === 1 ? "" : "s"} selected` : isWeeklyCopy ? "Choose at least one athlete" : "Reusable template"}</span>
          <button class="plain-button" type="button" data-action="builder-confirm-duplicate-plan" ${isWeeklyCopy && !selectedCount ? "disabled" : ""}>Create editable copy</button>
        </div>
      </section>
    </div>
  `;
}

export function renderBuilderInfoModal(kind) {
  const programInfo = kind === "program";
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-close-info" aria-label="Close structure example"></button>
      <section class="panel builder-info-modal" role="dialog" aria-modal="true" aria-label="Program structure example">
        <div class="builder-modal-head"><div><p class="eyebrow">Structure guide</p><h3>${programInfo ? "Program and block example" : "Day and session example"}</h3></div><button class="plain-button icon-button" type="button" data-action="builder-close-info" aria-label="Close"><span class="button-icon">x</span></button></div>
        ${programInfo ? `
          <div class="builder-schema"><div class="schema-level schema-program">Program</div><div class="schema-line"></div><div class="schema-level schema-block">MD-4 day block</div><div class="schema-line"></div><div class="schema-split"><span>Before training session</span><span>After training session</span></div></div>
          <p class="muted">A program can have one or many blocks. A block can represent a calendar day, a microcycle day, or any named unit.</p>
        ` : `
          <div class="builder-schema-tree"><div class="schema-before"><strong>Before training session</strong><span>Exercise domain: Power and potentiation</span><span>Exercise category: Warm up or Power</span><span>Exercise section: Mobility, Stability, Activation</span><span>Exercises: selected movements</span></div><div class="schema-after"><strong>After training session</strong><span>Exercise category: Strength</span><span>Exercise section: Warm up for strength, Strength legs and core</span><span>Exercise category: Sauna or Compressive leggings</span></div></div>
          <p class="muted">Not every path needs all levels. You can add an Exercise section directly to a session, directly below an Exercise domain, or below an Exercise category. Only Exercise sections contain exercises.</p>
        `}
      </section>
    </div>
  `;
}

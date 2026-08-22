import { builderIconGlyph, sessionLabel } from "./builder-helpers.js";
import { ICON_CHECK, ICON_X } from "./builder-structure.js";
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
          <div class="builder-athlete-picker-head-actions">
            <button class="plain-button icon-button builder-athlete-picker-cancel" type="button" data-action="builder-close-athlete-picker" aria-label="Cancel" title="Cancel">${ICON_X}</button>
            <button class="plain-button icon-button builder-athlete-picker-continue" type="button" data-action="builder-confirm-athlete-picker" aria-label="Continue" title="Continue" ${isWeekly && !selectedCount ? "disabled" : ""}>${ICON_CHECK}</button>
          </div>
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
  const isAssign = state.builder.copyIntent === "assign";
  // Assigning always targets one or more specific athletes - "reusable
  // template" (no athlete) isn't a valid outcome of "Assign to athlete", so
  // it must require a selection exactly like the weekly-copy case already
  // does, and never offer the "keep unassigned" option.
  const requiresAthlete = isWeeklyCopy || isAssign;
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-close-copy-plan" aria-label="Close ${isAssign ? "assignment" : "copy"} setup"></button>
      <section class="panel builder-compact-modal builder-copy-plan-modal" role="dialog" aria-modal="true" aria-label="${isAssign ? "Assign to athlete" : "Create editable copy"}">
        <div class="builder-modal-head">
          <div>
            <p class="eyebrow">${isAssign ? "Assign to athlete" : "Editable copy"}</p>
            <h3>${escapeHtml(state.builder.copyPlanName || "Program")}</h3>
            <p class="muted">${isAssign
              ? "The athlete gets an independent copy of the latest saved version of this template. Editing the template later never changes it."
              : isWeeklyCopy ? "Choose athletes and the new week. Each athlete gets an independent copy." : "Choose athletes for specific copies, or keep the copy reusable as a template."}</p>
          </div>
          <button class="plain-button icon-button" type="button" data-action="builder-close-copy-plan" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        ${isWeeklyCopy ? `<label class="search-field builder-copy-week"><span>Target week</span><input data-builder-copy-week-start type="date" value="${escapeAttr(state.builder.copyWeekStart || weekMondayIso(localDateIso()))}"><small>The copied week will begin on Monday.</small></label>` : ""}
        ${!isWeeklyCopy && !isAssign ? `<button class="builder-athlete-option ${selectedCount ? "" : "is-selected"}" type="button" data-action="builder-select-copy-athlete" data-athlete-id=""><span class="builder-athlete-trigger-icon">+</span><span><strong>Reusable template</strong><small>Keep this editable copy unassigned</small></span></button>` : ""}
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
          <span class="muted">${selectedCount ? `${selectedCount} athlete${selectedCount === 1 ? "" : "s"} selected` : requiresAthlete ? "Choose at least one athlete" : "Reusable template"}</span>
          <button class="plain-button" type="button" data-action="builder-confirm-duplicate-plan" ${requiresAthlete && !selectedCount ? "disabled" : ""}>${isAssign ? "Assign" : "Create editable copy"}</button>
        </div>
      </section>
    </div>
  `;
}

// Same .exit-confirm-modal/-backdrop/-dialog/-actions/-exit-button pattern
// messages.js's renderHideConfirmHtml already uses for its own "are you
// sure?" prompt (frontend/styles.css:6369-6422) - not window.confirm, and
// not a third one-off style. state.builder.overwriteDayConfirm carries just
// enough to redo the paste (sourceType/sourceId/targetDayId), set by
// builder-actions.js when POST /days/:id/copy-into/:targetId or
// POST /blocks/:id/copy-into/:targetId comes back 409 (target day already
// has sessions) - sourceType tells the retry which of those two endpoints
// to call again with confirmOverwrite: true.
export function renderOverwriteDayConfirmHtml(state) {
  if (!state.builder.overwriteDayConfirm) return "";
  return `
    <div class="exit-confirm-modal builder-overwrite-day-confirm-modal">
      <div class="exit-confirm-backdrop" data-action="builder-overwrite-day-cancel"></div>
      <div class="exit-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="builderOverwriteDayTitle" aria-describedby="builderOverwriteDayText">
        <h3 id="builderOverwriteDayTitle">Replace this day's content?</h3>
        <p id="builderOverwriteDayText">This day already has sessions. Pasting will remove them and put the copied day in their place.</p>
        <div class="exit-confirm-actions">
          <button class="plain-button" type="button" data-action="builder-overwrite-day-cancel">Cancel</button>
          <button class="plain-button exit-confirm-exit-button" type="button" data-action="builder-overwrite-day-confirm">Replace</button>
        </div>
      </div>
    </div>
  `;
}

// Phase 2: "Copy a block from another plan" picker (opened from a weekly
// day's header, frontend/builder-structure.js). A small wizard rather than
// one big form, since there's no existing "browse plans" screen inside the
// Builder to fall back on (frontend/builder-modals.js's renderCopyPlanModal
// only ever operates on ONE already-selected plan): choose a source type ->
// (if Specific program) choose an athlete -> choose that athlete's program
// (or, for Template, choose straight from the coach's template library) ->
// choose a block. Choosing a block sets state.builder.clipboard to
// {type: "cross-plan-block", sourcePlanId, blockId, name} and closes this -
// from there it's the exact same Paste-day button/overwrite-confirm flow
// Phase 1 already built (renderPasteDayIconButton doesn't care whether the
// clipboard's source was a same-plan day or a cross-plan block).
export function renderBlockPickerModal(state) {
  const picker = state.builder.blockPicker;
  if (!picker.open) return "";
  const title = picker.sessionName || picker.blockName || picker.planName
    || (picker.sourceType === "program" ? (picker.athleteId ? "Choose a program" : "Choose an athlete")
      : picker.sourceType === "weekly" ? (picker.athleteId ? "Choose a weekly plan" : "Choose an athlete")
      : picker.sourceType === "template" ? "Choose a template" : "Copy from another plan");
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-close-block-picker" aria-label="Close copy from another plan"></button>
      <section class="panel builder-compact-modal builder-block-picker-modal" role="dialog" aria-modal="true" aria-label="Copy a block from another plan">
        <div class="builder-modal-head">
          <div>
            <p class="eyebrow">Copy from another plan</p>
            <h3>${escapeHtml(title)}</h3>
          </div>
          <button class="plain-button icon-button" type="button" data-action="builder-close-block-picker" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        ${picker.error ? `<p class="builder-error" role="alert">${escapeHtml(picker.error)}</p>` : ""}
        ${renderBlockPickerBody(state, picker)}
      </section>
    </div>
  `;
}

function renderBlockPickerOption({ action, dataAttrs = "", label, meta }) {
  return `
    <button class="builder-block-picker-option" type="button" data-action="${escapeAttr(action)}" ${dataAttrs}>
      <strong>${escapeHtml(label)}</strong>
      ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
    </button>
  `;
}

// Combines the session's own custom name (if any) with the same AM/PM +
// training-phase badge text sessionLabel() (builder-helpers.js) already
// renders throughout the real Builder tree, additive not replacing - the
// same convention Phase 3's session-name feature established everywhere
// else this label appears.
function pickerSessionLabel(session) {
  const badge = sessionLabel(session);
  return session.name ? `${session.name} (${badge})` : badge;
}

function renderPickerNodeIcon(iconUrl) {
  if (iconUrl && /^https?:\/\//i.test(iconUrl)) return `<img class="builder-node-icon-image" src="${escapeAttr(iconUrl)}" alt="">`;
  return builderIconGlyph(iconUrl);
}

// Read-only, recursive - deliberately NOT reusing renderBuilderNodeTree
// (builder-structure.js), which is heavily entangled with live edit-mode
// state (inline-add forms, move/copy/delete actions, the paste clipboard).
// Every node here is directly clickable to copy just that node+its
// subtree, same interaction as the Builder's own tree, just without any of
// the editing chrome.
function renderPickerNodeTree(nodes, parentId) {
  const children = nodes.filter((node) => (node.parentId || "") === parentId);
  if (!children.length) return "";
  return `
    <div class="builder-block-picker-node-tree">
      ${children.map((node) => `
        <div class="builder-block-picker-node builder-node-${escapeAttr(node.type)}">
          <button class="builder-block-picker-node-row" type="button" data-action="builder-block-picker-choose-node" data-node-id="${escapeAttr(node.id)}" data-node-type="${escapeAttr(node.type)}" data-node-name="${escapeAttr(node.name)}" data-item-count="${escapeAttr(node.itemCount)}">
            <span class="builder-node-icon">${renderPickerNodeIcon(node.iconUrl)}</span>
            <span>${escapeHtml(node.name)}</span>
            ${node.type === "section" ? `<small>${node.itemCount} ${node.itemCount === 1 ? "exercise" : "exercises"}</small>` : ""}
          </button>
          ${renderPickerNodeTree(nodes, node.id)}
        </div>
      `).join("")}
    </div>
  `;
}

function renderBlockPickerBody(state, picker) {
  if (picker.sessionId) {
    if (picker.nodesLoading) return `<p class="muted">Loading structure...</p>`;
    return `
      <button class="plain-button builder-block-picker-copy-whole" type="button" data-action="builder-block-picker-copy-whole-session">${ICON_CHECK}<span>Copy this whole session</span></button>
      ${picker.nodes.length
        ? renderPickerNodeTree(picker.nodes, "")
        : `<p class="muted">This session has no domains, categories, or sections yet.</p>`}
      <button class="text-action" type="button" data-action="builder-block-picker-back-to-sessions">Choose a different session</button>
    `;
  }
  if (picker.blockId) {
    if (picker.sessionsLoading) return `<p class="muted">Loading sessions...</p>`;
    return `
      <button class="plain-button builder-block-picker-copy-whole" type="button" data-action="builder-block-picker-copy-whole-block">${ICON_CHECK}<span>Copy this whole day</span></button>
      <div class="builder-block-picker-list">
        ${picker.sessions.length
          ? picker.sessions.map((session) => renderBlockPickerOption({
              action: "builder-block-picker-drill-session",
              dataAttrs: `data-session-id="${escapeAttr(session.id)}" data-session-name="${escapeAttr(pickerSessionLabel(session))}"`,
              label: pickerSessionLabel(session),
              meta: `${session.itemCount} ${session.itemCount === 1 ? "exercise" : "exercises"}`,
            })).join("")
          : `<p class="muted">This day has no sessions yet.</p>`}
      </div>
      <button class="text-action" type="button" data-action="builder-block-picker-back-to-blocks">Choose a different day</button>
    `;
  }
  if (picker.planId) {
    if (picker.blocksLoading) return `<p class="muted">Loading blocks...</p>`;
    return `
      <div class="builder-block-picker-list">
        ${picker.blocks.length
          ? picker.blocks.map((block) => renderBlockPickerOption({
              action: "builder-block-picker-drill-block",
              dataAttrs: `data-block-id="${escapeAttr(block.id)}" data-block-name="${escapeAttr(block.name)}"`,
              label: block.name,
              meta: `${block.sessionCount} ${block.sessionCount === 1 ? "session" : "sessions"} - ${block.itemCount} ${block.itemCount === 1 ? "exercise" : "exercises"}`,
            })).join("")
          : `<p class="muted">This plan has no blocks yet.</p>`}
      </div>
      <button class="text-action" type="button" data-action="builder-block-picker-back-to-plans">Choose a different plan</button>
    `;
  }
  if (picker.sourceType === "template") {
    if (picker.templatesLoading) return `<p class="muted">Loading templates...</p>`;
    return `
      <div class="builder-block-picker-list">
        ${picker.templates.length
          ? picker.templates.map((template) => renderBlockPickerOption({
              action: "builder-block-picker-choose-plan",
              dataAttrs: `data-plan-id="${escapeAttr(template.plan_id)}" data-plan-name="${escapeAttr(template.plan_name)}"`,
              label: template.plan_name,
              meta: `${template.block_or_day_count || 0} blocks - ${template.item_count || 0} exercises`,
            })).join("")
          : `<p class="muted">No templates found.</p>`}
      </div>
      <button class="text-action" type="button" data-action="builder-block-picker-back-to-source">Choose a different source</button>
    `;
  }
  if (picker.sourceType === "program" || picker.sourceType === "weekly") {
    const isWeeklySource = picker.sourceType === "weekly";
    if (!picker.athleteId) {
      return `
        <div class="builder-athlete-options">
          ${(state.athletes || []).map((athlete) => `
            <button class="builder-athlete-option" type="button" data-action="builder-block-picker-choose-athlete" data-athlete-id="${escapeAttr(athlete.athlete_id)}">
              ${athlete.athlete_image_url || athlete.image_url ? renderImage(athlete.athlete_image_url || athlete.image_url, "builder-athlete-avatar") : `<span class="builder-athlete-trigger-icon">${escapeHtml(initialsFor(athlete.athlete))}</span>`}
              <span><strong>${escapeHtml(athlete.athlete)}</strong><small>ID ${escapeHtml(athlete.athlete_id)}</small></span>
            </button>
          `).join("")}
        </div>
        <button class="text-action" type="button" data-action="builder-block-picker-back-to-source">Choose a different source</button>
      `;
    }
    if (picker.athletePlansLoading) return `<p class="muted">Loading ${isWeeklySource ? "weekly plans" : "programs"}...</p>`;
    return `
      <div class="builder-block-picker-list">
        ${picker.athletePlans.length
          ? picker.athletePlans.map((plan) => renderBlockPickerOption({
              action: "builder-block-picker-choose-plan",
              dataAttrs: `data-plan-id="${escapeAttr(plan.plan_id)}" data-plan-name="${escapeAttr(plan.plan_name)}"`,
              label: plan.plan_name,
              meta: `${plan.block_or_day_count || 0} ${isWeeklySource ? "days" : "blocks"} - ${plan.item_count || 0} exercises`,
            })).join("")
          : `<p class="muted">This athlete has no ${isWeeklySource ? "weekly plans" : "specific programs"}.</p>`}
      </div>
      <button class="text-action" type="button" data-action="builder-block-picker-back-to-athletes">Choose a different athlete</button>
    `;
  }
  return `
    <div class="builder-block-picker-source-choice">
      ${renderBlockPickerOption({ action: "builder-block-picker-choose-source-type", dataAttrs: `data-source-type="template"`, label: "Template", meta: "A reusable program from your library" })}
      ${renderBlockPickerOption({ action: "builder-block-picker-choose-source-type", dataAttrs: `data-source-type="program"`, label: "Specific program", meta: "An athlete's own assigned program" })}
      ${renderBlockPickerOption({ action: "builder-block-picker-choose-source-type", dataAttrs: `data-source-type="weekly"`, label: "Weekly plan", meta: "An athlete's own weekly plan" })}
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

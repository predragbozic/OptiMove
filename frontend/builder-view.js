import {
  builderExerciseCountDots,
  builderIconGlyph,
  builderIconOptions,
  builderNodeMarker,
  canPasteNodeType,
  findBuilderNode,
  findBuilderSession,
  nodeTypeOptions,
  sessionLabel,
} from "./builder-helpers.js";
import { renderBuilderAthletePicker, renderBuilderInfoModal } from "./builder-modals.js";
import { renderBuilderSectionOverlay } from "./builder-section.js";
import {
  renderBuilderBlock,
  renderBuilderSessionModal,
  renderBuilderStructureModal,
} from "./builder-structure.js";
import { els } from "./dom.js";
import { renderImage } from "./media.js";
import { state } from "./state.js";
import {
  escapeAttr,
  escapeHtml,
  formatDate,
  initialsFor,
  localDateIso,
  weekMondayIso,
} from "./utils.js";

function builderStructureContext() {
  return {
    builderExerciseCountDots,
    builderIconGlyph,
    builderIconOptions,
    builderNodeMarker,
    canPasteNodeType,
    clipboard: state.builder.clipboard,
    findBuilderSession: (id) => findBuilderSession(state.builder.draft, id),
    nodeTypeOptions,
    selectedSessionId: state.builder.selectedSessionId,
    sessionLabel,
  };
}

export function renderBuilder() {
  const draft = state.builder.draft;
  els.context.textContent = "Program builder";
  els.title.textContent = draft ? draft.plan.name : "New program";
  els.toolbar.innerHTML = "";
  if (!draft) {
    const assignedAthlete = state.athletes.find((athlete) => String(athlete.athlete_id) === String(state.builder.createAthleteId));
    const isWeekly = state.builder.planType === "weekly";
    const weekStart = state.builder.weekStart || weekMondayIso(localDateIso());
    els.content.innerHTML = `
      <section class="content-section builder-start">
        <section class="panel builder-setup-card">
          <div class="section-heading">
            <div><p class="eyebrow">Program builder</p><h3>${isWeekly ? "Create weekly plan" : "Create program"}</h3><p class="muted">${isWeekly ? "Choose an athlete and the week to plan." : "Assign an athlete, or leave it reusable as a template."}</p></div>
          </div>
          <form class="builder-form builder-create-form" data-builder-form="create">
            <div class="builder-plan-type-control" role="group" aria-label="Plan type"><button class="${isWeekly ? "" : "is-active"}" type="button" data-action="builder-set-plan-type" data-plan-type="program">Program or template</button><button class="${isWeekly ? "is-active" : ""}" type="button" data-action="builder-set-plan-type" data-plan-type="weekly">Weekly plan</button></div>
            <div class="builder-details-row">
              <label class="search-field"><span>${isWeekly ? "Weekly plan name (optional)" : "Program name"}</span><input name="name" ${isWeekly ? "" : "required"} placeholder="${isWeekly ? "e.g. Match week" : "e.g. Preseason strength block"}"></label>
              <div class="builder-metadata-grid builder-setup-controls">
                <label class="search-field"><span>Color</span><input name="color" type="color" value="#287e77"></label>
                <label class="search-field"><span>Icon</span><select name="iconUrl">${builderIconOptions()}</select></label>
              </div>
            </div>
            <input type="hidden" name="planType" value="${isWeekly ? "weekly" : "program"}">
            <input type="hidden" name="athleteId" value="${escapeAttr(state.builder.createAthleteId)}">
            ${isWeekly ? `<label class="search-field builder-week-start"><span>Any date in the planned week</span><input name="weekStart" data-builder-week-start type="date" value="${escapeAttr(weekStart)}" required><small>The weekly plan will begin on Monday ${escapeHtml(formatDate(weekStart))}.</small></label>` : ""}
            <div class="builder-assignment-row"><span class="builder-field-label">Athlete</span><button class="builder-athlete-trigger" type="button" data-action="builder-open-athlete-picker">
              ${assignedAthlete?.athlete_image_url || assignedAthlete?.image_url ? renderImage(assignedAthlete.athlete_image_url || assignedAthlete.image_url, "builder-athlete-avatar") : `<span class="builder-athlete-trigger-icon">${assignedAthlete ? escapeHtml(initialsFor(assignedAthlete.athlete)) : "+"}</span>`}<span><strong>${escapeHtml(assignedAthlete?.athlete || (isWeekly ? "Choose athlete" : "Choose athlete or template"))}</strong>${assignedAthlete ? `<small>ID ${escapeHtml(assignedAthlete.athlete_id)}</small>` : ""}</span><span class="button-icon">></span>
            </button></div>
            ${state.builder.showNote ? `<label class="search-field"><span>Program note</span><textarea name="note" rows="2" placeholder="Optional coaching note"></textarea></label>` : `<button class="text-action builder-note-toggle" type="button" data-action="builder-toggle-note">Add note</button>`}
            <p class="builder-private-note">${isWeekly ? "Weekly plans are always assigned to the selected athlete." : "Private to your coach account until sharing and publishing are configured."}</p>
            <p class="builder-error" aria-live="polite"></p>
            <button class="plain-button builder-create-button" type="submit">${isWeekly ? "Create weekly plan" : "Create draft"}</button>
          </form>
        </section>
        ${state.builder.athletePickerOpen ? renderBuilderAthletePicker(state) : ""}
      </section>
    `;
    return;
  }

  const selectedSession = findBuilderSession(draft, state.builder.selectedSessionId);
  const selectedNode = findBuilderNode(draft, state.builder.selectedNodeId);
  const isWeekly = draft.plan.planType === "weekly";
  const isEditDraft = Boolean(draft.plan.isEditDraft);
  const closeLabel = isEditDraft ? "Cancel changes" : "Close editor";
  const saveLabel = isEditDraft ? "Apply changes" : "Save and finish";
  const structureContext = builderStructureContext();
  els.content.innerHTML = `
    <section class="content-section builder-workspace">
      <header class="builder-program-bar">
        <div><p class="eyebrow">${isEditDraft ? "Editing original" : isWeekly ? `Weekly plan - ${formatDate(draft.plan.weekStart)}` : (draft.plan.isTemplate ? "Reusable template" : "Athlete program")}</p><h3>${escapeHtml(draft.plan.name)}</h3><p class="muted">${escapeHtml(isEditDraft ? "Changes are saved only when applied." : draft.plan.athleteName || "Private coach template")}</p></div>
        <div class="builder-program-actions"><span class="item-badge">${isEditDraft ? "edit draft" : escapeHtml(draft.plan.status || "draft")}</span><button class="plain-button builder-cancel-button" type="button" data-action="builder-cancel" title="${isEditDraft ? "Discard this edit draft and keep the original unchanged." : "Close the editor. Autosaved changes remain."}">${closeLabel}</button>${draft.plan.status === "draft" ? `<button class="plain-button builder-finish-button" type="button" data-action="builder-submit-plan">${saveLabel}</button>` : `<span class="builder-finished-label">Saved</span>`}${isEditDraft ? "" : `<button class="text-action danger-action" type="button" data-action="builder-delete-plan">Delete</button>`}</div>
      </header>
      ${state.builder.clipboard?.type ? `<div class="builder-copy-hint"><span>Copied ${escapeHtml(state.builder.clipboard.type)}: <strong>${escapeHtml(state.builder.clipboard.name)}</strong>${state.builder.clipboard.itemCount ? ` (${state.builder.clipboard.itemCount} exercises)` : ""}</span><button class="text-action" type="button" data-action="builder-clear-clipboard">Clear</button></div>` : ""}
      ${isWeekly ? "" : `<section class="builder-block-creator">
        <div><p class="eyebrow">Program structure</p><strong>Add a day or block</strong></div>
        <button class="plain-button icon-button builder-info-button" type="button" data-action="builder-open-info" data-info="program" aria-label="Program structure example"><span class="button-icon">i</span></button>
        <form class="builder-inline-form builder-add-block" data-builder-form="add-block">
          <label class="search-field"><span>Block name</span><input name="name" placeholder="Day 1, MD-2, or Block 1"></label>
          <p class="builder-error" aria-live="polite"></p>
          <button class="plain-button" type="submit">Add block</button>
        </form>
      </section>`}
      <div class="builder-layout">
        <section class="panel builder-outline">
          <div class="section-heading"><div><p class="eyebrow">Day and session structure</p><h3>${isWeekly ? "Seven-day plan" : "Blocks and sessions"}</h3></div><button class="plain-button icon-button builder-info-button" type="button" data-action="builder-open-info" data-info="session" aria-label="Session structure example"><span class="button-icon">i</span></button></div>
          ${draft.blocks.length ? draft.blocks.map((block) => renderBuilderBlock(block, selectedSession?.id, selectedNode?.id, isWeekly, structureContext)).join("") : `
            <div class="empty builder-outline-empty">
              <span class="builder-outline-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg></span>
              <strong>No days or blocks yet</strong>
              <p class="muted">Use the form above to add the first day or block, then build sessions inside it.</p>
            </div>`}
        </section>
      </div>
      ${state.builder.sessionModalBlockId ? renderBuilderSessionModal(state.builder.sessionModalBlockId) : ""}
      ${state.builder.structureModalOpen && selectedSession ? renderBuilderStructureModal(selectedSession, selectedNode, structureContext) : ""}
      ${selectedNode?.type === "section" ? renderBuilderSectionOverlay(state, selectedNode) : ""}
      ${state.builder.infoOpen ? renderBuilderInfoModal(state.builder.infoOpen) : ""}
    </section>
  `;
}

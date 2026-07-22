import {
  builderExerciseCountDots,
  builderIconGlyph,
  builderIconOptions,
  builderNodeMarker,
  canPasteNodeType,
  exerciseNodeLabel,
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
    exerciseNodeLabel,
    findBuilderSession: (id) => findBuilderSession(state.builder.draft, id),
    nodeTypeOptions,
    selectedSessionId: state.builder.selectedSessionId,
    sessionLabel,
    inlineAddOpen: state.builder.inlineAddOpen,
    inlineAddType: state.builder.inlineAddType,
    inlineAddSessionId: state.builder.inlineAddSessionId,
    inlineAddParentId: state.builder.inlineAddParentId,
    previewSectionId: state.builder.previewSectionId,
  };
}

function renderBuilderBatchSwitcher(batchPlans, currentIndex) {
  if (!batchPlans.length || currentIndex < 0) return "";
  const current = batchPlans[currentIndex];
  const previous = batchPlans[currentIndex - 1];
  const next = batchPlans[currentIndex + 1];
  const syncChecked = state.builder.batchSync ? "checked" : "";
  return `
    <section class="builder-batch-switcher" aria-label="Batch athlete plans">
      <div class="builder-batch-summary">
        <p class="eyebrow">Group builder</p>
        <strong>${escapeHtml(current?.athleteName || current?.name || "Current copy")}</strong>
        <small>${currentIndex + 1} / ${batchPlans.length}</small>
      </div>
      <div class="builder-batch-controls">
        <div class="builder-batch-buttons">
          <button class="plain-button icon-button" type="button" data-action="builder-open-batch-plan" data-plan-id="${escapeAttr(previous?.id || "")}" ${previous ? "" : "disabled"} aria-label="Previous athlete"><span class="button-icon">&lt;</span></button>
          <div class="builder-batch-pills">
            ${batchPlans.map((plan, index) => `
              <button class="builder-batch-pill ${index === currentIndex ? "is-active" : ""}" type="button" data-action="builder-open-batch-plan" data-plan-id="${escapeAttr(plan.id)}" title="${escapeAttr(plan.athleteName || plan.name || "Program copy")}">
                ${escapeHtml(initialsFor(plan.athleteName || plan.name || String(index + 1)))}
              </button>
            `).join("")}
          </div>
          <button class="plain-button icon-button" type="button" data-action="builder-open-batch-plan" data-plan-id="${escapeAttr(next?.id || "")}" ${next ? "" : "disabled"} aria-label="Next athlete"><span class="button-icon">&gt;</span></button>
        </div>
        <div class="builder-batch-mode">
          <label class="builder-batch-sync">
            <input type="checkbox" data-action="builder-toggle-batch-sync" ${syncChecked}>
            <span>Apply changes to all athletes</span>
          </label>
          <small>Turn off before fine-tuning only this athlete.</small>
        </div>
      </div>
    </section>
  `;
}

function renderBuilderDraftsPanel() {
  if (state.builder.draftsLoading) {
    return `<section class="panel builder-drafts-panel"><p class="muted">Loading drafts...</p></section>`;
  }
  const drafts = state.builder.drafts || [];
  if (!drafts.length) return "";
  const isOpen = state.builder.draftsOpen;
  const selectedKeys = new Set(state.builder.selectedDraftKeys || []);
  const allSelected = drafts.length > 0 && drafts.every((item) => selectedKeys.has(item.groupKey));
  const selectedCount = selectedKeys.size;
  return `
    <section class="panel builder-drafts-panel">
      <button class="builder-drafts-toggle" type="button" data-action="builder-toggle-drafts-panel" aria-expanded="${isOpen ? "true" : "false"}">
        <span><span class="eyebrow">Continue where you left off</span><strong>${drafts.length} unfinished draft${drafts.length === 1 ? "" : "s"}</strong></span>
        <span class="button-icon">${isOpen ? "&#8963;" : "&#8964;"}</span>
      </button>
      ${isOpen ? `
        <div class="builder-drafts-body">
          <div class="builder-drafts-bulk-row">
            <div class="builder-athlete-select-all">
              <button class="checkbox-toggle-all ${allSelected ? "is-checked" : ""}" type="button" data-action="builder-toggle-select-all-drafts" aria-label="${allSelected ? "Uncheck all drafts" : "Check all drafts"}">
                <span aria-hidden="true">${allSelected ? "&#10003;" : ""}</span>
              </button>
              <span class="muted">Select all</span>
            </div>
            ${selectedCount ? `<button class="text-action danger-action" type="button" data-action="builder-discard-selected-drafts">Discard selected (${selectedCount})</button>` : ""}
          </div>
          <div class="builder-drafts-list">
            ${drafts.map((item) => {
              const typeLabel = item.planType === "weekly"
                ? `Weekly plan${item.weekStart ? ` - ${formatDate(item.weekStart)}` : ""}`
                : item.isTemplate ? "Template" : "Program";
              const athleteLabel = item.athleteNames?.length ? item.athleteNames.join(", ") : "";
              const isChecked = selectedKeys.has(item.groupKey);
              return `
                <div class="builder-draft-row">
                  <button class="checkbox-toggle-all ${isChecked ? "is-checked" : ""}" type="button" data-action="builder-toggle-select-draft" data-group-key="${escapeAttr(item.groupKey)}" aria-label="${isChecked ? "Uncheck" : "Check"} ${escapeAttr(item.name || typeLabel)}">
                    <span aria-hidden="true">${isChecked ? "&#10003;" : ""}</span>
                  </button>
                  <div class="builder-draft-info">
                    <strong>${escapeHtml(item.name || typeLabel)}</strong>
                    <small>${escapeHtml(typeLabel)}${athleteLabel ? ` &middot; ${escapeHtml(athleteLabel)}` : ""}</small>
                    <small class="muted">Last edited ${escapeHtml(formatDate(item.updatedAt))}</small>
                  </div>
                  <div class="builder-draft-actions">
                    <button class="plain-button" type="button" data-action="builder-open-draft" data-plan-id="${escapeAttr(item.openPlanId)}">Continue</button>
                    <button class="text-action danger-action" type="button" data-action="builder-discard-draft" data-plan-ids="${escapeAttr((item.planIds || []).join(","))}">Discard</button>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      ` : ""}
    </section>
  `;
}

export function renderBuilder() {
  const draft = state.builder.draft;
  const draftBatchPlans = Array.isArray(draft?.batch?.plans) ? draft.batch.plans : [];
  els.context.textContent = "Program builder";
  els.title.textContent = draft
    ? (draftBatchPlans.length > 1
      ? "Group builder"
      : (draft.plan.athleteName || (draft.plan.isTemplate ? "Reusable template" : "Draft")))
    : "New program";
  els.toolbar.innerHTML = "";
  if (!draft) {
    const selectedAthleteIds = new Set((state.builder.createAthleteIds || []).map(String));
    const assignedAthletes = state.athletes.filter((athlete) => selectedAthleteIds.has(String(athlete.athlete_id)));
    const assignedAthlete = assignedAthletes[0];
    const selectedCount = assignedAthletes.length;
    const isWeekly = state.builder.planType === "weekly";
    const weekStart = state.builder.weekStart || weekMondayIso(localDateIso());
    const athleteTitle = selectedCount > 1
      ? `${selectedCount} athletes selected`
      : assignedAthlete?.athlete || (isWeekly ? "Choose athlete" : "Choose athlete or template");
    const athleteSubtitle = selectedCount > 1
      ? "Build once for all selected athletes, then fine-tune each copy."
      : assignedAthlete ? `ID ${assignedAthlete.athlete_id}` : "";
    els.content.innerHTML = `
      <section class="content-section builder-start">
        ${renderBuilderDraftsPanel()}
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
              ${assignedAthlete?.athlete_image_url || assignedAthlete?.image_url ? renderImage(assignedAthlete.athlete_image_url || assignedAthlete.image_url, "builder-athlete-avatar") : `<span class="builder-athlete-trigger-icon">${assignedAthlete ? escapeHtml(initialsFor(assignedAthlete.athlete)) : "+"}</span>`}<span><strong>${escapeHtml(athleteTitle)}</strong>${athleteSubtitle ? `<small>${escapeHtml(athleteSubtitle)}</small>` : ""}</span><span class="button-icon">></span>
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
  const closeLabel = isEditDraft ? "Cancel changes" : "Close";
  const saveLabel = isEditDraft ? "Apply changes" : "Save and finish";
  const structureContext = builderStructureContext();
  const batchPlans = Array.isArray(draft.batch?.plans) ? draft.batch.plans : [];
  const batchIndex = batchPlans.findIndex((plan) => String(plan.id) === String(draft.plan.id));
  const hasBatch = batchPlans.length > 1 && batchIndex >= 0;
  els.content.innerHTML = `
    <section class="content-section builder-workspace">
      <header class="builder-program-bar">
        <div><p class="eyebrow">${isEditDraft ? "Editing original" : isWeekly ? "Weekly plan" : (draft.plan.isTemplate ? "Reusable template" : "Athlete program")}</p><h3>${escapeHtml(draft.plan.name)}</h3><p class="muted">${escapeHtml(isEditDraft ? "Changes are saved only when applied." : draft.plan.athleteName || "Private coach template")}</p></div>
        <div class="builder-program-actions"><span class="item-badge">${isEditDraft ? "edit draft" : escapeHtml(draft.plan.status || "draft")}</span><button class="plain-button builder-cancel-button" type="button" data-action="builder-cancel" title="${isEditDraft ? "Discard this edit draft and keep the original unchanged." : "Every change saves automatically. This just closes the editor — find the draft again later from where you started it."}">${closeLabel}</button>${draft.plan.status === "draft" ? `<button class="plain-button builder-finish-button" type="button" data-action="builder-submit-plan">${saveLabel}</button>` : `<span class="builder-finished-label">Saved</span>`}${isEditDraft ? "" : `<button class="text-action danger-action" type="button" data-action="builder-delete-plan" title="Permanently discard this draft and everything in it.">Discard draft</button>`}</div>
      </header>
      ${hasBatch ? renderBuilderBatchSwitcher(batchPlans, batchIndex) : ""}
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

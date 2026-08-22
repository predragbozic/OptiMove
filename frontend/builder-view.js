import {
  builderExerciseCountDots,
  builderIconGlyph,
  builderIconOptions,
  builderNodeMarker,
  canPasteNodeType,
  exerciseNodeLabel,
  findBuilderNode,
  findBuilderSession,
  sessionLabel,
} from "./builder-helpers.js";
import { renderBuilderAddConfirmation, renderBuilderExerciseResults, renderBuilderStickyBar } from "./builder-exercises.js";
import { renderBlockPickerModal, renderBuilderAthletePicker, renderBuilderInfoModal, renderCopyPlanModal, renderOverwriteDayConfirmHtml } from "./builder-modals.js";
import { renderBuilderAddedPanelContent, renderBuilderSectionOverlay } from "./builder-section.js";
import {
  ICON_CHECK,
  ICON_TRASH,
  ICON_X,
  renderBuilderAddBlockCard,
  renderBuilderBlock,
  renderBuilderStructureModal,
  renderImportBlockIconButton,
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

// Same figure + white-on-fill plus badge convention as ICON_ADD_ATHLETE/
// ICON_ADD_CLUB in organization-view.js - reused here rather than invented,
// so the three entry tiles read as the same "add" family as the rest of the app.
const ICON_ENTRY_WEEKLY = `<svg class="athlete-home-quick-action-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="14" height="13.5" rx="2"></rect><path d="M7 2.5v4"></path><path d="M13 2.5v4"></path><path d="M3 9.5h14"></path><circle cx="18" cy="18" r="4.5" fill="currentColor" stroke="none"></circle><path d="M18 15.8v4.4M15.8 18h4.4" stroke="var(--surface, #fff)" stroke-width="1.4" stroke-linecap="round"></path></svg>`;
const ICON_ENTRY_PROGRAM = `<svg class="athlete-home-quick-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.5h6.5L16 6v11.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z"></path><path d="M12.5 2.5V6H16"></path><path d="M7.5 10.5h5"></path><path d="M7.5 13.5h5"></path><circle cx="18" cy="18" r="4.5" fill="currentColor" stroke="none"></circle><path d="M18 15.8v4.4M15.8 18h4.4" stroke="var(--surface, #fff)" stroke-width="1.4" stroke-linecap="round"></path></svg>`;
const ICON_ENTRY_TEMPLATE = `<svg class="athlete-home-quick-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 2.5l6 3-6 3-6-3 6-3Z"></path><path d="M2.5 8.5l6 3 6-3"></path><path d="M2.5 12.5l6 3 6-3"></path><circle cx="18" cy="18" r="4.5" fill="currentColor" stroke="none"></circle><path d="M18 15.8v4.4M15.8 18h4.4" stroke="var(--surface, #fff)" stroke-width="1.4" stroke-linecap="round"></path></svg>`;

const BUILDER_ENTRY_TILES = [
  ["weekly", "Weekly plan", ICON_ENTRY_WEEKLY],
  ["program", "Program", ICON_ENTRY_PROGRAM],
  ["template", "Template", ICON_ENTRY_TEMPLATE],
];

function renderBuilderEntryTiles() {
  return `
    <section class="panel builder-setup-card builder-entry-tiles">
      <div class="section-heading">
        <div><p class="eyebrow">Program builder</p><h3>What are you creating?</h3><p class="muted">Pick one to jump straight into its setup.</p></div>
      </div>
      <div class="athlete-home-quick-actions-grid builder-entry-tiles-grid">
        ${BUILDER_ENTRY_TILES.map(([entryType, label, icon]) => `
          <button class="athlete-home-quick-action" type="button" data-action="builder-choose-entry-type" data-entry-type="${entryType}">
            ${icon}
            <span class="athlete-home-quick-action-label">${escapeHtml(label)}</span>
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

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
    selectedSessionId: state.builder.selectedSessionId,
    sessionLabel,
    inlineAddOpen: state.builder.inlineAddOpen,
    inlineAddType: state.builder.inlineAddType,
    inlineAddSessionId: state.builder.inlineAddSessionId,
    inlineAddParentId: state.builder.inlineAddParentId,
    previewSectionId: state.builder.previewSectionId,
    editNodeOpen: state.builder.editNodeOpen,
    builderNodePresets: state.builder.nodePresets || [],
    blockAddOpen: state.builder.blockAddOpen,
    sessionQuickAdd: state.builder.sessionQuickAdd,
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

const BUILDER_SCROLL_SELECTORS = [".builder-section-modal", ".builder-exercise-results"];
const BUILDER_BLOCK_GRID_SELECTOR = ".builder-block-grid";

// renderBuilder() replaces els.content's entire innerHTML on every call
// (renderBuilderInner() below), including .builder-block-grid - the row of
// block columns that scrolls horizontally. Reassigning innerHTML destroys
// and recreates that element, which resets scrollLeft to 0 with no DOM
// state to preserve it from. Every add/edit of a block, domain, category,
// or section routes through this same renderBuilder() call, so all of them
// need their horizontal position restored the same way.
//
// lastRenderedPlanId/lastRenderedBlockIds are intentionally module-level
// (not local to one call): by the time renderBuilder() runs, the mutation
// that triggered it has already updated state.builder.draft (setBuilderDraft
// happens before the render call in every action handler), so there is no
// "before" snapshot available within a single call to diff against - only
// what was remembered from the PREVIOUS render. Comparing against that is
// also what makes it safe to tell "one block was appended" apart from
// "a completely different plan was loaded into the Builder" (block count
// grew by exactly one AND every previous block is still present, vs. an
// unrelated set of ids) - the former gets the new block scrolled minimally
// into view, the latter intentionally does not restore a leftover scroll
// position from whatever plan was open before.
let lastRenderedPlanId = null;
let lastRenderedBlockIds = null;

function addedBlockId(previousIds, currentIds) {
  if (!previousIds || !previousIds.length) return null;
  if (currentIds.length !== previousIds.length + 1) return null;
  if (!previousIds.every((id) => currentIds.includes(id))) return null;
  return currentIds.find((id) => !previousIds.includes(id)) || null;
}

function captureBuilderScrollState() {
  const vertical = BUILDER_SCROLL_SELECTORS.map((selector) => {
    const el = els.content.querySelector(selector);
    return { selector, top: el ? el.scrollTop : null };
  });

  const grid = els.content.querySelector(BUILDER_BLOCK_GRID_SELECTOR);
  const currentPlanId = state.builder.draft?.plan?.id || null;
  const currentBlockIds = (state.builder.draft?.blocks || []).map((block) => block.id);
  const samePlan = currentPlanId !== null && currentPlanId === lastRenderedPlanId;
  const horizontal = grid
    ? { left: grid.scrollLeft, samePlan, addedBlockId: samePlan ? addedBlockId(lastRenderedBlockIds, currentBlockIds) : null }
    : null;

  lastRenderedPlanId = currentPlanId;
  lastRenderedBlockIds = currentBlockIds;

  return { vertical, horizontal };
}

function restoreBuilderScrollState(captured) {
  requestAnimationFrame(() => {
    captured.vertical.forEach(({ selector, top }) => {
      if (top === null) return;
      const el = els.content.querySelector(selector);
      if (el) el.scrollTop = top;
    });

    if (!captured.horizontal) return;
    const grid = els.content.querySelector(BUILDER_BLOCK_GRID_SELECTOR);
    if (!grid) return;

    if (captured.horizontal.addedBlockId) {
      const newBlockEl = [...grid.querySelectorAll("[data-block-id]")]
        .find((el) => el.dataset.blockId === captured.horizontal.addedBlockId);
      if (newBlockEl) {
        newBlockEl.scrollIntoView({ inline: "nearest", block: "nearest" });
        return;
      }
    }

    if (captured.horizontal.samePlan) grid.scrollLeft = captured.horizontal.left;
  });
}

export function renderBuilder() {
  const scrollState = captureBuilderScrollState();
  renderBuilderInner();
  restoreBuilderScrollState(scrollState);
}

// Dose/instruction edits, move up/down, and delete only change which exercises are
// in the currently open section and their order -- nothing else on screen needs to
// change. Patching just this panel (instead of the full renderBuilder(), which
// replaces the entire screen) means the search input, scroll position, and any
// other field the coach is mid-edit in are never touched by these actions.
// Returns false (caller should fall back to renderBuilder()) if the section editor
// isn't currently open.
export function renderBuilderSectionItems() {
  const selectedNode = findBuilderNode(state.builder.draft, state.builder.selectedNodeId);
  const container = els.content.querySelector(".builder-section-added");
  if (!container || !selectedNode || selectedNode.type !== "section") return false;

  // A Tab between sibling fields on the same item (e.g. Sets -> Reps) moves focus
  // to the next field synchronously, before this async save even starts -- so by
  // the time we patch the DOM, the field the coach just tabbed into is already
  // focused. Capture and restore it (and the modal's scroll) around the patch so
  // neither gets stolen out from under them.
  const scrollEl = els.content.querySelector(".builder-section-modal");
  const scrollTop = scrollEl ? scrollEl.scrollTop : null;
  const active = document.activeElement;
  const activeForm = active?.closest?.(".builder-item");
  // Three different views can render a .builder-item[data-item-id] at once
  // (compact mobile card, single-item mobile edit form, desktop full form) -
  // on mobile the compact card and the desktop form share the very same
  // item id, and a plain "first match" query after the re-render would
  // silently grab the wrong (CSS-hidden) one instead of the form the coach
  // was actually typing in. Remember which of the three scopes the focused
  // form was inside, and re-query within that same scope only.
  const activeScopeEl = activeForm?.closest?.(".builder-added-list-compact, .builder-item-edit, .builder-added-list-desktop");
  const activeScopeClass = activeScopeEl?.classList.contains("builder-added-list-compact") ? "builder-added-list-compact"
    : activeScopeEl?.classList.contains("builder-item-edit") ? "builder-item-edit"
    : activeScopeEl?.classList.contains("builder-added-list-desktop") ? "builder-added-list-desktop"
    : "";
  const focusState = activeForm && container.contains(activeForm)
    ? { itemId: activeForm.dataset.itemId, fieldName: active.getAttribute("name"), start: active.selectionStart, end: active.selectionEnd, scopeClass: activeScopeClass }
    : null;

  container.innerHTML = renderBuilderAddedPanelContent(state, selectedNode);

  if (scrollEl && scrollTop !== null) scrollEl.scrollTop = scrollTop;
  if (focusState) {
    const scopeEl = (focusState.scopeClass && container.querySelector(`.${focusState.scopeClass}`)) || container;
    const nextForm = scopeEl.querySelector(`.builder-item[data-item-id="${CSS.escape(focusState.itemId)}"]`);
    const nextField = nextForm?.querySelector(`[name="${CSS.escape(focusState.fieldName)}"]`);
    if (nextField) {
      nextField.focus({ preventScroll: true });
      if (typeof nextField.setSelectionRange === "function" && focusState.start !== null) {
        try { nextField.setSelectionRange(focusState.start, focusState.end); } catch {}
      }
    }
  }
  return true;
}

// Called after a successful add (builder-pick-exercise/add-custom-exercise,
// builder-actions.js). Patches exactly three things - the results list's
// "Added N×" badges, the sticky bar's count/thumbnails, and the inline add-
// confirmation banner - none of which share a DOM subtree with the search
// input, quick-dose fields, or filters, so this can never blur/reset them.
// Also refreshes the Added-mode panel (harmless no-op while it's hidden in
// Add-exercises mode) so its data is current whenever the coach does switch
// over. Returns false (caller falls back to renderBuilder()) if the section
// editor isn't open.
export function renderBuilderAddFeedback() {
  const selectedNode = findBuilderNode(state.builder.draft, state.builder.selectedNodeId);
  const panel = els.content.querySelector(".builder-section-panel");
  if (!panel || !selectedNode || selectedNode.type !== "section") return false;

  panel.dataset.mobileMode = state.builder.mobileMode;

  const resultsEl = panel.querySelector(".builder-exercise-results");
  if (resultsEl) resultsEl.innerHTML = renderBuilderExerciseResults(state.builder.exercises, state.markedExerciseIds, selectedNode);

  const confirmationSlot = panel.querySelector(".builder-add-confirmation");
  const confirmationHtml = renderBuilderAddConfirmation(state.builder.addConfirmation);
  if (confirmationSlot) {
    if (confirmationHtml) confirmationSlot.outerHTML = confirmationHtml;
    else confirmationSlot.remove();
  } else if (confirmationHtml && resultsEl) {
    resultsEl.insertAdjacentHTML("beforebegin", confirmationHtml);
  }

  const stickyEl = panel.querySelector(".builder-mobile-sticky-bar");
  if (stickyEl) stickyEl.outerHTML = renderBuilderStickyBar(selectedNode, state.builder.mobileMode);

  renderBuilderSectionItems();
  return true;
}

function renderBuilderInner() {
  const draft = state.builder.draft;
  const draftBatchPlans = Array.isArray(draft?.batch?.plans) ? draft.batch.plans : [];
  els.context.textContent = "Program builder";
  els.title.textContent = draft
    ? (draftBatchPlans.length > 1
      ? "Group builder"
      : (draft.plan.athleteName || (draft.plan.isTemplate ? "Reusable template" : "Draft")))
    : "New program";
  els.toolbar.innerHTML = "";
  if (!draft && !state.builder.entryType) {
    els.content.innerHTML = `
      <section class="content-section builder-start">
        ${renderBuilderDraftsPanel()}
        ${renderBuilderEntryTiles()}
      </section>
    `;
    return;
  }
  if (!draft) {
    const selectedAthleteIds = new Set((state.builder.createAthleteIds || []).map(String));
    const assignedAthletes = state.athletes.filter((athlete) => selectedAthleteIds.has(String(athlete.athlete_id)));
    const assignedAthlete = assignedAthletes[0];
    const selectedCount = assignedAthletes.length;
    const isWeekly = state.builder.planType === "weekly";
    const isTemplate = state.builder.entryType === "template";
    const weekStart = state.builder.weekStart || weekMondayIso(localDateIso());
    const heading = isWeekly ? "Create weekly plan" : (isTemplate ? "Create template" : "Create program");
    const subtitle = isWeekly
      ? "Choose an athlete and the week to plan."
      : (isTemplate ? "Reusable across athletes - leave it unassigned." : "Assign an athlete to build a program just for them.");
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
            <div><button class="text-action builder-entry-back" type="button" data-action="builder-entry-back">&larr; Back</button><p class="eyebrow">Program builder</p><h3>${heading}</h3><p class="muted">${subtitle}</p></div>
          </div>
          <form class="builder-form builder-create-form" data-builder-form="create">
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
  const saveLabel = isEditDraft ? "Apply changes" : "Save and finish";
  const structureContext = builderStructureContext();
  const batchPlans = Array.isArray(draft.batch?.plans) ? draft.batch.plans : [];
  const batchIndex = batchPlans.findIndex((plan) => String(plan.id) === String(draft.plan.id));
  const hasBatch = batchPlans.length > 1 && batchIndex >= 0;
  els.content.innerHTML = `
    <section class="content-section builder-workspace">
      <header class="builder-program-bar">
        <div><p class="eyebrow">${isEditDraft ? "Editing original" : isWeekly ? "Weekly plan" : (draft.plan.isTemplate ? "Reusable template" : "Athlete program")}</p><form class="builder-plan-name-inline" data-builder-form="update-plan" data-builder-autosave><input name="name" class="builder-plan-title-input" value="${escapeAttr(draft.plan.name || "")}" placeholder="${isWeekly ? "e.g. Match week" : "Program name"}" aria-label="${isWeekly ? "Weekly plan name" : "Program name"}"></form><p class="muted">${escapeHtml(isEditDraft ? "Changes are saved only when applied." : draft.plan.athleteName || "Private coach template")}</p></div>
        <div class="builder-program-actions">
          <span class="item-badge">${isEditDraft ? "edit draft" : escapeHtml(draft.plan.status || "draft")}</span>
          ${isEditDraft
            ? `<button class="plain-button builder-cancel-button" type="button" data-action="builder-cancel" title="Discard this edit draft and keep the original unchanged.">${ICON_X}<span>Cancel</span></button>`
            : `<span class="builder-saved-indicator" title="Every change saves automatically."><svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M5 4h11l3 3v13H5V4z"></path><path d="M8 4v5h8V4"></path><path d="M7 14h10v6H7z"></path></svg><span>Saved</span></span><button class="plain-button icon-button builder-exit-button" type="button" data-action="builder-cancel" aria-label="Exit editor" title="Exit — find this draft again later from where you started it.">${ICON_X}</button>`}
          ${draft.plan.isTemplate && !isWeekly ? `<button class="plain-button builder-assign-button" type="button" data-action="builder-duplicate-plan" data-plan-id="${escapeAttr(draft.plan.id)}" data-plan-type="program" data-intent="assign" data-is-edit-draft="${isEditDraft ? "true" : "false"}">${ICON_CHECK}<span>Assign to athlete</span></button>` : ""}
          ${draft.plan.status === "draft" ? `<button class="plain-button builder-finish-button" type="button" data-action="builder-submit-plan">${ICON_CHECK}<span>${saveLabel}</span></button>` : `<span class="builder-finished-label">Saved</span>`}
          ${isEditDraft ? "" : `<button class="plain-button icon-button danger-action" type="button" data-action="builder-delete-plan" aria-label="Discard draft" title="Permanently discard this draft and everything in it.">${ICON_TRASH}</button>`}
        </div>
      </header>
      ${state.builder.assignResult ? renderBuilderAssignResultBanner(state.builder.assignResult) : ""}
      ${hasBatch ? renderBuilderBatchSwitcher(batchPlans, batchIndex) : ""}
      ${state.builder.clipboard?.type ? `<div class="builder-copy-hint"><span>Copied ${escapeHtml(state.builder.clipboard.type === "cross-plan-block" ? "block" : state.builder.clipboard.type)}: <strong>${escapeHtml(state.builder.clipboard.name)}</strong>${state.builder.clipboard.itemCount ? ` (${state.builder.clipboard.itemCount} exercises)` : ""}</span><button class="text-action" type="button" data-action="builder-clear-clipboard">Clear</button></div>` : ""}
      <div class="builder-layout">
        <section class="panel builder-outline">
          <div class="section-heading">
            <div><p class="eyebrow">Day and session structure</p><h3>${isWeekly ? "Seven-day plan" : "Blocks and sessions"}</h3></div>
            <div class="builder-outline-info-buttons">
              ${isWeekly ? renderImportBlockIconButton() : `<button class="plain-button icon-button builder-info-button" type="button" data-action="builder-open-info" data-info="program" aria-label="Program structure example"><span class="button-icon">i</span></button>`}
              <button class="plain-button icon-button builder-info-button" type="button" data-action="builder-open-info" data-info="session" aria-label="Session structure example"><span class="button-icon">i</span></button>
            </div>
          </div>
          ${draft.blocks.length || !isWeekly ? `
            <div class="builder-block-grid">
              ${draft.blocks.map((block) => renderBuilderBlock(block, selectedSession?.id, selectedNode?.id, isWeekly, structureContext)).join("")}
              ${isWeekly ? "" : renderBuilderAddBlockCard(structureContext)}
            </div>
          ` : `
            <div class="empty builder-outline-empty">
              <span class="builder-outline-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg></span>
              <strong>No days or blocks yet</strong>
              <p class="muted">Use the form above to add the first day or block, then build sessions inside it.</p>
            </div>`}
        </section>
      </div>
      ${state.builder.structureModalOpen && selectedSession ? renderBuilderStructureModal(selectedSession, selectedNode, structureContext) : ""}
      ${selectedNode?.type === "section" ? renderBuilderSectionOverlay(state, selectedNode) : ""}
      ${state.builder.infoOpen ? renderBuilderInfoModal(state.builder.infoOpen) : ""}
      ${renderCopyPlanModal(state)}
      ${renderOverwriteDayConfirmHtml(state)}
      ${renderBlockPickerModal(state)}
    </section>
  `;
}

export function renderBuilderAssignResultBanner(result) {
  const entries = result.entries || [];
  return `
    <div class="builder-copy-hint builder-assign-result">
      <span>Assigned to ${entries.length} athlete${entries.length === 1 ? "" : "s"} - the template is unchanged and stays open.</span>
      <div class="builder-assign-result-links">
        ${entries.map((entry) => `<button class="plain-button compact-button" type="button" data-action="builder-edit-plan" data-plan-id="${escapeAttr(entry.planId)}">Open ${escapeHtml(entry.athleteName)}'s program</button>`).join("")}
      </div>
      <button class="text-action" type="button" data-action="builder-dismiss-assign-result">Dismiss</button>
    </div>
  `;
}

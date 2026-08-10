import { exerciseNodeLabel } from "./builder-helpers.js";
import {
  renderBuilderAddConfirmation,
  renderBuilderAddedList,
  renderBuilderExerciseResults,
  renderBuilderItemEdit,
  renderBuilderItems,
  renderBuilderStickyBar,
  renderCustomExerciseModal,
} from "./builder-exercises.js";
import { ICON_CHECK, ICON_X, renderCopyNodeIconButton, renderDeleteIconButton, renderNodeEditForm } from "./builder-structure.js";
import {
  filterIconSvg,
  QUICK_FILTER_KEYS,
  renderExerciseFilterControls,
  renderExerciseQuickFilters,
  renderExerciseTagModal,
} from "./exercise-library.js";
import { EXERCISE_FILTERS } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

function activeExerciseSelectFilterCount(filters) {
  return EXERCISE_FILTERS.filter((filter) => !QUICK_FILTER_KEYS.has(filter.key) && filters[filter.key]).length;
}

// Mobile "Added exercises" mode content: either the compact card list, or
// (when an item is open for editing) the single-item Sets/Reps/Load/
// Instruction view with Previous/Next. Desktop always gets the unchanged
// full-form list (renderBuilderItems) regardless of this state - see the
// ≤560px CSS gate that shows exactly one of the two lists.
export function renderBuilderAddedPanelContent(state, selectedNode) {
  const mobileList = state.builder.editItemId
    ? renderBuilderItemEdit(selectedNode, state.builder.editItemId, state.builder.editItemInstructionOpen)
    : (renderBuilderAddedList(selectedNode) || `<div class="empty">Choose exercises from the library to build this section.</div>`);
  return `
    <div class="builder-panel-label">Added to section <span>${selectedNode.items.length}</span></div>
    ${mobileList}
    ${renderBuilderItems(selectedNode) || `<div class="empty builder-added-list-desktop">Choose exercises from the library to build this section.</div>`}
  `;
}

function renderBuilderSectionPanel(state, selectedNode) {
  const query = state.builder.exerciseQuery;
  const selectFilterCount = activeExerciseSelectFilterCount(state.builder.exerciseFilters);
  return `
    <div class="builder-section-panel" data-mobile-mode="${escapeAttr(state.builder.mobileMode)}" aria-label="Section exercise editor">
      <div class="builder-section-panel-head">
        <div><p class="eyebrow">Exercise section editor</p>${renderNodeEditForm(selectedNode, exerciseNodeLabel("section"), state.builder.editNodeOpen === selectedNode.id, state.builder.nodePresets || [])}${state.builder.editNodeOpen !== selectedNode.id && selectedNode.note ? `<p class="builder-node-note">${escapeHtml(selectedNode.note)}</p>` : ""}<p class="muted">Search the library and add exercises to this section.</p></div>
        <div class="builder-section-editor-actions builder-section-editor-actions-desktop">${renderCopyNodeIconButton(selectedNode.id, "Copy section")}<button class="plain-button builder-section-cancel-button" type="button" data-action="builder-finish-section">${ICON_X}<span>Cancel</span></button><button class="plain-button builder-section-finish-button" type="button" data-action="builder-finish-section">${ICON_CHECK}<span>Finish</span></button>${renderDeleteIconButton("builder-delete-node", `data-node-id="${escapeAttr(selectedNode.id)}"`, "Delete section")}</div>
        <button class="plain-button icon-button builder-section-close-button" type="button" data-action="builder-finish-section" aria-label="Close section editor" title="Close - your changes are already saved">${ICON_X}</button>
      </div>
      <div class="builder-mobile-mode-tabs" role="tablist" aria-label="Section editor mode">
        <button class="builder-mobile-mode-tab ${state.builder.mobileMode === "add" ? "is-active" : ""}" type="button" role="tab" aria-selected="${state.builder.mobileMode === "add" ? "true" : "false"}" data-action="builder-set-mobile-mode" data-mode="add">Add exercises</button>
        <button class="builder-mobile-mode-tab ${state.builder.mobileMode === "added" ? "is-active" : ""}" type="button" role="tab" aria-selected="${state.builder.mobileMode === "added" ? "true" : "false"}" data-action="builder-set-mobile-mode" data-mode="added">Added exercises (${selectedNode.items.length})</button>
      </div>
      <div class="builder-section-grid">
        <section class="builder-section-library">
          <div class="builder-panel-label">Exercise library</div>
          <label class="search-field builder-exercise-search"><span>Search exercises</span><input data-builder-exercise-search type="search" value="${escapeAttr(query)}" placeholder="Name or code"></label>
          ${renderExerciseQuickFilters(state.builder.exerciseFilters, state.exerciseSearch.options, "data-builder-exercise-filter", `
            <details class="builder-exercise-filters" ${selectFilterCount ? "open" : ""}>
              <summary class="exercise-filter-toggle-icon" aria-label="More filters${selectFilterCount ? ` (${selectFilterCount} active)` : ""}" title="More filters">
                ${filterIconSvg()}${selectFilterCount ? `<span class="filter-count-badge">${selectFilterCount}</span>` : ""}
              </summary>
              <div class="exercise-filter-strip builder-filter-strip">
                ${renderExerciseFilterControls(state.builder.exerciseFilters, state.exerciseSearch.options, "builder-selects")}
              </div>
            </details>
            <button class="text-action builder-custom-exercise-button" type="button" data-action="builder-open-custom-exercise">Add custom exercise</button>
          `)}
          <div class="builder-dose-inputs builder-quick-dose">
            <label><span>Sets</span><input data-builder-new-dose name="sets" placeholder="3"></label>
            <label><span>Reps</span><input data-builder-new-dose name="reps" placeholder="8"></label>
            <label><span>Load</span><input data-builder-new-dose name="load" placeholder="40 kg"></label>
          </div>
          ${renderBuilderAddConfirmation(state.builder.addConfirmation)}
          <div class="builder-exercise-results">
            ${renderBuilderExerciseResults(state.builder.exercises, state.markedExerciseIds, selectedNode)}
          </div>
        </section>
        <section class="builder-section-added">
          ${renderBuilderAddedPanelContent(state, selectedNode)}
        </section>
      </div>
      ${renderBuilderStickyBar(selectedNode)}
      ${state.builder.customExerciseOpen ? renderCustomExerciseModal(selectedNode, state.builder.customExerciseDose) : ""}
      ${state.tagEditor.open ? renderExerciseTagModal(state.tagEditor) : ""}
    </div>
  `;
}

export function renderBuilderSectionOverlay(state, selectedNode) {
  return `
    <div class="builder-section-overlay">
      <button class="builder-section-backdrop" type="button" data-action="builder-finish-section" aria-label="Close Exercise section editor"></button>
      <section class="panel builder-section-modal" role="dialog" aria-modal="true" aria-label="Exercise section editor">
        ${renderBuilderSectionPanel(state, selectedNode)}
      </section>
    </div>
  `;
}

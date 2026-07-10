import {
  renderBuilderExerciseResult,
  renderBuilderItems,
  renderCustomExerciseModal,
} from "./builder-exercises.js";
import {
  renderExerciseFilterControls,
  renderExerciseQuickFilters,
  renderExerciseTagModal,
} from "./exercise-library.js";
import { EXERCISE_FILTERS } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

function activeExerciseSelectFilterCount(filters) {
  return EXERCISE_FILTERS.filter((filter) => filters[filter.key]).length;
}

function renderBuilderSectionPanel(state, selectedNode) {
  const query = state.builder.exerciseQuery;
  const selectFilterCount = activeExerciseSelectFilterCount(state.builder.exerciseFilters);
  return `
    <div class="builder-section-panel" aria-label="Section exercise editor">
      <div class="builder-section-panel-head"><div><p class="eyebrow">Exercise section editor</p><h3>${escapeHtml(selectedNode.name)}</h3><p class="muted">Search the library and add exercises to this section.</p></div><div class="builder-section-editor-actions"><button class="plain-button" type="button" data-action="builder-copy-node" data-node-id="${escapeAttr(selectedNode.id)}">Copy section</button><button class="plain-button" type="button" data-action="builder-finish-section">Finish section</button><button class="text-action danger-action" type="button" data-action="builder-delete-node" data-node-id="${escapeAttr(selectedNode.id)}">Delete</button></div></div>
      <div class="builder-section-grid">
        <section class="builder-section-library">
          <div class="builder-panel-label">Exercise library</div>
          <label class="search-field builder-exercise-search"><span>Search exercises</span><input data-builder-exercise-search type="search" value="${escapeAttr(query)}" placeholder="Name or code"></label>
          ${renderExerciseQuickFilters(state.builder.exerciseFilters, "data-builder-exercise-filter")}
          <details class="builder-exercise-filters" ${selectFilterCount ? "open" : ""}>
            <summary>More filters${selectFilterCount ? ` (${selectFilterCount})` : ""}</summary>
            <div class="exercise-filter-strip builder-filter-strip">
              ${renderExerciseFilterControls(state.builder.exerciseFilters, state.exerciseSearch.options, "builder-selects")}
            </div>
          </details>
          <button class="text-action builder-custom-exercise-button" type="button" data-action="builder-open-custom-exercise">Add custom exercise</button>
          <div class="builder-dose-inputs builder-quick-dose">
            <label><span>Sets</span><input data-builder-new-dose name="sets" placeholder="3"></label>
            <label><span>Reps</span><input data-builder-new-dose name="reps" placeholder="8"></label>
            <label><span>Load</span><input data-builder-new-dose name="load" placeholder="40 kg"></label>
          </div>
          <div class="builder-exercise-results">
            ${state.builder.exercises.map((exercise) => renderBuilderExerciseResult(exercise, state.markedExerciseIds)).join("") || `<div class="empty">No matching exercises.</div>`}
          </div>
        </section>
        <section class="builder-section-added">
          <div class="builder-panel-label">Added to section <span>${selectedNode.items.length}</span></div>
          ${renderBuilderItems(selectedNode) || `<div class="empty">Choose exercises from the library to build this section.</div>`}
        </section>
      </div>
      ${state.builder.customExerciseOpen ? renderCustomExerciseModal(selectedNode) : ""}
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

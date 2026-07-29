import { api } from "./api.js";
import { renderBuilderExerciseResult } from "./builder-exercises.js";
import { renderBuilder, renderBuilderSectionItems } from "./builder-view.js";
import { applyClientExerciseFilters, exerciseSearchUrl, loadExerciseFilterOptions } from "./exercise-data.js";
import { state } from "./state.js";

let builderExerciseRequestId = 0;

export async function loadBuilderExercises(options = {}) {
  if (state.activeTab !== "builder") return;
  const requestId = ++builderExerciseRequestId;
  await loadExerciseFilterOptions();
  const query = state.builder.exerciseQuery.trim();
  const data = await api(exerciseSearchUrl(query, 18, state.builder.exerciseFilters));
  if (requestId !== builderExerciseRequestId) return;
  state.builder.exercises = applyClientExerciseFilters(data.exercises || [], state.builder.exerciseFilters);
  // A results-only refresh (instead of the full renderBuilder()) so typing in the
  // search box never touches the search input itself or any other in-progress edit
  // (sets/reps/instruction, scroll position) elsewhere on the same screen.
  const resultsContainer = document.querySelector(".builder-exercise-results");
  if (resultsContainer && !options.forceFullRender) {
    resultsContainer.innerHTML = state.builder.exercises
      .map((exercise) => renderBuilderExerciseResult(exercise, state.markedExerciseIds))
      .join("") || `<div class="empty">No matching exercises.</div>`;
  } else {
    renderBuilder();
  }
  options.afterRender?.();
}

export async function refreshBuilderDraft(options = {}) {
  if (!state.builder.draft) return;
  state.builder.draft = await api(`/api/builder/plans/${encodeURIComponent(state.builder.draft.plan.id)}`);
  if (options.sectionItemsOnly && renderBuilderSectionItems()) return;
  renderBuilder();
}

export async function loadBuilderNodePresets() {
  if (state.builder.nodePresets.length) return;
  const data = await api("/api/taxonomy/node-presets");
  state.builder.nodePresets = data.presets || [];
}

export async function loadBuilderDrafts() {
  if (state.builder.draft) return;
  state.builder.draftsLoading = true;
  try {
    const data = await api("/api/builder/drafts");
    state.builder.drafts = data.drafts || [];
  } finally {
    state.builder.draftsLoading = false;
  }
  renderBuilder();
}

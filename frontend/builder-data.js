import { api } from "./api.js";
import { renderBuilder } from "./builder-view.js";
import { applyClientExerciseFilters, exerciseSearchUrl, loadExerciseFilterOptions } from "./exercise-data.js";
import { state } from "./state.js";

export async function loadBuilderExercises(options = {}) {
  if (state.activeTab !== "builder") return;
  await loadExerciseFilterOptions();
  const query = state.builder.exerciseQuery.trim();
  const data = await api(exerciseSearchUrl(query, 18, state.builder.exerciseFilters));
  state.builder.exercises = applyClientExerciseFilters(data.exercises || [], state.builder.exerciseFilters);
  renderBuilder();
  options.afterRender?.();
}

export async function refreshBuilderDraft() {
  if (!state.builder.draft) return;
  state.builder.draft = await api(`/api/builder/plans/${encodeURIComponent(state.builder.draft.plan.id)}`);
  renderBuilder();
}

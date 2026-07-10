import { api } from "./api.js";
import { EXERCISE_FILTERS, emptyExerciseOptions, state } from "./state.js";

export async function loadExerciseFilterOptions() {
  if (EXERCISE_FILTERS.some((filter) => state.exerciseSearch.options[filter.optionsKey]?.length)) return;
  const data = await api("/api/exercises/options");
  state.exerciseSearch.options = { ...emptyExerciseOptions(), ...data };
}

export function exerciseSearchUrl(query, limit, filters = {}) {
  const params = new URLSearchParams({ search: query || "", limit: String(limit || 30) });
  EXERCISE_FILTERS.forEach((filter) => {
    if (filters[filter.key]) params.set(filter.key, filters[filter.key]);
  });
  if (filters.favorite) params.set("favorite", "true");
  return `/api/exercises?${params.toString()}`;
}

export function applyClientExerciseFilters(exercises, filters) {
  if (!filters.marked) return exercises;
  const hasOtherFilters = EXERCISE_FILTERS.some((filter) => filters[filter.key]) || filters.favorite;
  if (!hasOtherFilters) return [...state.markedExercises.values()];
  return exercises.filter((exercise) => state.markedExerciseIds.has(exercise.id));
}

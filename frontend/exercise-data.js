import { api } from "./api.js";
import { EXERCISE_FILTERS, emptyExerciseOptions, state } from "./state.js";

export async function loadExerciseFilterOptions() {
  if (EXERCISE_FILTERS.some((filter) => state.exerciseSearch.options[filter.optionsKey]?.length)) return;
  const data = await api("/api/exercises/options");
  state.exerciseSearch.options = { ...emptyExerciseOptions(), ...data };
}

export function exerciseSearchUrl(query, limit, filters = {}) {
  const params = new URLSearchParams({ search: query || "", limit: String(limit || 30) });
  params.set("searchIn", filters.searchIn || "name");
  params.set("kind", filters.owner && !filters.kind ? "private" : filters.kind || "accessible");
  EXERCISE_FILTERS.forEach((filter) => {
    if (filters[filter.key]) params.set(filter.key, filters[filter.key]);
  });
  if (filters.favorite) params.set("favorite", "true");
  for (const key of ["visibility", "hidden", "owner"]) {
    if (filters[key]) params.set(key, filters[key]);
  }
  return `/api/exercises?${params.toString()}`;
}

export async function loadMarkedExerciseVisibility(filters) {
  if (!filters.marked) return [];
  const ids = [...state.markedExercises.keys()];
    const visibility = {};
    for (const key of ["visibility", "hidden"]) {
      if (filters[key]) visibility[key] = filters[key];
    }
    const data = await api("/api/exercises/visible-marked", { method: "POST", body: JSON.stringify({ ids, ...visibility }) });
  return data.ids || [];
}

export function applyClientExerciseFilters(exercises, filters, visibleMarkedIds = []) {
  if (!filters.marked) return exercises;
  const hasOtherFilters = EXERCISE_FILTERS.some((filter) => filters[filter.key]) || filters.favorite || ["kind", "visibility", "hidden", "owner"].some((key) => filters[key]);
  const visible = new Set(visibleMarkedIds);
  if (!hasOtherFilters) {
    return [...state.markedExercises.values()].filter((exercise) => visible.has(exercise.id));
  }
  return exercises.filter((exercise) => state.markedExerciseIds.has(exercise.id) && visible.has(exercise.id));
}

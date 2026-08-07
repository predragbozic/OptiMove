import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { loadBuilderExercises } from "./builder-data.js";
import { renderBuilder } from "./builder-view.js";
import { els } from "./dom.js";
import { applyClientExerciseFilters, exerciseSearchUrl, loadExerciseFilterOptions } from "./exercise-data.js";
import { filterIconSvg, QUICK_FILTER_KEYS, renderExerciseFilterControls, renderExerciseQuickFilters } from "./exercise-library.js";
import { emptyExerciseOptions, EXERCISE_FILTERS, state } from "./state.js";
import { debounce, escapeHtml } from "./utils.js";
import { buildContextKey, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

const EXERCISES_CACHE_NAMESPACE = "exercises";

// Mirrors exactly what exerciseSearchUrl() itself sends to the server - the
// search term, every EXERCISE_FILTERS value, `favorite` (also a real query
// param) and `limit` (this view's only form of pagination - "load more"
// bumps it and, as a different limit, is naturally a fresh fetch, never a
// stale short page). `marked` is deliberately excluded: it's a purely
// client-side filter (see applyClientExerciseFilters) that exerciseSearchUrl
// never sends to the server, so it must never fragment the cache - toggling
// it re-derives instantly from whatever's already cached under the other,
// server-relevant filters.
function exercisesContextKey(term, limit, filters) {
  return buildContextKey([
    ...currentUserWorkspaceContextParts(),
    term,
    limit,
    ...EXERCISE_FILTERS.map((filter) => filters[filter.key]),
    filters.favorite,
  ]);
}

export function invalidateExercisesCache() {
  invalidateCacheNamespace(EXERCISES_CACHE_NAMESPACE);
}

function activeExerciseSelectFilterCount(filters) {
  return EXERCISE_FILTERS.filter((filter) => !QUICK_FILTER_KEYS.has(filter.key) && filters[filter.key]).length;
}

export async function loadExercises(handlers) {
  state.navStack = [];
  // /api/exercises/options (filter dropdown data) and the initial
  // /api/exercises search never depend on each other - the search query is
  // built purely from state.exerciseSearch.filters (already-selected
  // values), never from the options list - so both start at once instead of
  // the options fetch blocking the exercise list. Options failing is
  // swallowed here (non-critical background refinement, same "silent"
  // treatment other secondary loads get elsewhere in this app) so it can
  // never stop the toolbar/list from rendering with whatever's already in
  // state.exerciseSearch.options.
  const optionsPromise = loadExerciseFilterOptions().catch(() => {});
  const searchPromise = searchExercises("", handlers);
  await optionsPromise;
  const selectFilterCount = activeExerciseSelectFilterCount(state.exerciseSearch.filters);
  els.toolbar.innerHTML = `
    <label class="search-field exercise-search-field">
      <span>Exercise search</span>
      <input id="exerciseSearch" type="search" placeholder="Name or code" value="">
    </label>
    ${renderExerciseQuickFilters(state.exerciseSearch.filters, state.exerciseSearch.options, "data-exercise-filter", `
      <details class="builder-exercise-filters" ${selectFilterCount ? "open" : ""}>
        <summary class="exercise-filter-toggle-icon" aria-label="More filters${selectFilterCount ? ` (${selectFilterCount} active)` : ""}" title="More filters">
          ${filterIconSvg()}${selectFilterCount ? `<span class="filter-count-badge">${selectFilterCount}</span>` : ""}
        </summary>
        <div class="exercise-filter-strip">
          ${renderExerciseFilterControls(state.exerciseSearch.filters, state.exerciseSearch.options)}
        </div>
      </details>
    `)}
  `;
  const input = document.querySelector("#exerciseSearch");
  input.addEventListener("input", debounce(() => {
    state.exerciseSearch.limit = 30;
    searchExercises(input.value, handlers);
  }, 250));
  document.querySelectorAll("[data-exercise-filter]").forEach((control) => {
    control.addEventListener("change", () => {
      state.exerciseSearch.filters[control.dataset.exerciseFilter] =
        control.type === "checkbox" ? control.checked : control.value;
      state.exerciseSearch.limit = 30;
      searchExercises(input.value, handlers);
    });
  });
  await searchPromise;
}

export async function searchExercises(term, handlers, { forceRefresh = false } = {}) {
  const query = term.trim();
  state.exerciseSearch.term = query;
  const { limit, filters } = state.exerciseSearch;
  const contextKey = exercisesContextKey(query, limit, filters);
  await loadCachedView({
    namespace: EXERCISES_CACHE_NAMESPACE,
    contextKey,
    forceRefresh,
    fetcher: () => api(exerciseSearchUrl(query, limit, filters)),
    showLoading: () => handlers.setLoading(query ? "Searching exercises..." : "Loading exercises..."),
    applyData: (data) => {
      state.exerciseSearch.hasMore = Boolean(data.hasMore);
      // Reads the LIVE filters, not the snapshot this fetch was keyed by -
      // `marked` isn't part of the cache key (see exercisesContextKey), so
      // it may have changed since this fetch was dispatched even though the
      // rest of the context hasn't; the render must reflect its current
      // value, not a stale one from dispatch time.
      handlers.renderExercises(applyClientExerciseFilters(data.exercises || [], state.exerciseSearch.filters));
    },
    applyError: (error) => {
      // Without this, a failed fetch leaves the "Loading/Searching
      // exercises..." placeholder from setLoading above on screen forever -
      // handlers only carries setLoading/renderExercises, neither of which is
      // an error view, so the error is rendered directly here (same pattern as
      // app.js's own renderError: a plain .error box, no new UI concept).
      els.content.innerHTML = `<div class="error">${escapeHtml(error?.message || "Could not load exercises.")}</div>`;
    },
    getCurrentContextKey: () => exercisesContextKey(state.exerciseSearch.term, state.exerciseSearch.limit, state.exerciseSearch.filters),
  });
}

export async function submitExerciseTagForm(form, handlers) {
  const formData = new FormData(form);
  const tagId = String(formData.get("tagId") || "").trim();
  const name = String(formData.get("name") || "").trim();
  if (!tagId && !name) {
    state.tagEditor.error = "Choose a tag or write a new one.";
    rerenderCurrentExerciseSurface(handlers);
    return;
  }
  try {
    await api(`/api/exercises/${encodeURIComponent(state.tagEditor.exerciseId)}/tags`, {
      method: "POST",
      body: JSON.stringify(tagId ? { tagId } : { name }),
    });
    await refreshExerciseTagEditor();
    state.exerciseSearch.options = emptyExerciseOptions();
    await loadExerciseFilterOptions();
    await refreshCurrentExerciseSearch(handlers);
  } catch (error) {
    state.tagEditor.error = error.message || "Could not add tag.";
    rerenderCurrentExerciseSurface(handlers);
  }
}

export async function handleExerciseLibraryAction(action, handlers) {
  const type = action.dataset.action;
  if (type === "exercise-load-more") {
    state.exerciseSearch.limit += 30;
    searchExercises(state.exerciseSearch.term, handlers);
    return true;
  }
  if (type === "exercise-toggle-favorite") {
    void toggleExerciseFavorite(action.dataset.exerciseId, action.dataset.favorite === "true", handlers);
    return true;
  }
  if (type === "exercise-toggle-mark") {
    toggleExerciseMark(action.dataset.exerciseId, handlers);
    return true;
  }
  if (type === "exercise-tags") {
    void openExerciseTagEditor(action.dataset.exerciseId, action.dataset.exerciseName || "Exercise", handlers);
    return true;
  }
  if (type === "exercise-tags-close") {
    closeExerciseTagEditor(handlers);
    return true;
  }
  if (type === "exercise-tag-remove") {
    void removeExerciseTag(action.dataset.exerciseId, action.dataset.tagId, handlers);
    return true;
  }
  return false;
}

export function handleExerciseDetailAction(action, handlers) {
  const type = action.dataset.action;
  if (type === "exercise-layout") {
    state.exerciseLayout = action.dataset.layout === "vertical" ? "vertical" : "horizontal";
    handlers.renderCurrentNode();
    return true;
  }
  if (type === "open-exercise") {
    const item = handlers.getItemById(action.dataset.itemId);
    if (!item) return true;
    handlers.pushAppHistory();
    handlers.renderExerciseDetail(item, action.dataset.itemId);
    return true;
  }
  if (type === "exercise-prev") {
    handlers.moveExerciseDetail(-1);
    return true;
  }
  if (type === "exercise-next") {
    handlers.moveExerciseDetail(1);
    return true;
  }
  if (type === "exercise-jump") {
    const item = handlers.getItemById(action.dataset.itemId);
    if (!item) return true;
    handlers.renderExerciseDetail(item, action.dataset.itemId);
    return true;
  }
  return false;
}

function findExerciseResultById(exerciseId) {
  return [...state.lastExerciseResults, ...state.builder.exercises].find((exercise) => String(exercise.id) === String(exerciseId)) || null;
}

async function toggleExerciseFavorite(exerciseId, isFavorite, handlers) {
  if (!exerciseId) return;
  await api(`/api/exercises/${encodeURIComponent(exerciseId)}/favorite`, {
    method: isFavorite ? "DELETE" : "POST",
  });
  if (state.activeTab === "builder" && state.builder.selectedNodeId) await loadBuilderExercises();
  // Just changed this exercise's favorite flag server-side - the cached
  // entry for the current search context still has the pre-toggle value
  // (favorite is a real server filter, so a favorites-only view could even
  // need to drop/gain this row), so this specific re-fetch must never be
  // satisfied from cache.
  else await searchExercises(state.exerciseSearch.term, handlers, { forceRefresh: true });
}

function toggleExerciseMark(exerciseId, handlers) {
  if (!exerciseId) return;
  if (state.markedExerciseIds.has(exerciseId)) {
    state.markedExerciseIds.delete(exerciseId);
    state.markedExercises.delete(exerciseId);
  } else {
    state.markedExerciseIds.add(exerciseId);
    const exercise = findExerciseResultById(exerciseId);
    if (exercise) state.markedExercises.set(exerciseId, exercise);
  }
  if (state.activeTab === "builder" && state.builder.selectedNodeId) {
    if (state.builder.exerciseFilters.marked) void loadBuilderExercises();
    else renderBuilder();
  } else {
    searchExercises(state.exerciseSearch.term, handlers);
  }
}

async function openExerciseTagEditor(exerciseId, exerciseName, handlers) {
  if (!exerciseId) return;
  const data = await api(`/api/exercises/${encodeURIComponent(exerciseId)}/tags`);
  state.tagEditor = {
    open: true,
    exerciseId,
    exerciseName,
    tags: data.tags || [],
    options: data.options || [],
    error: "",
  };
  rerenderCurrentExerciseSurface(handlers);
}

function closeExerciseTagEditor(handlers) {
  state.tagEditor = { open: false, exerciseId: "", exerciseName: "", tags: [], options: [], error: "" };
  rerenderCurrentExerciseSurface(handlers);
}

async function removeExerciseTag(exerciseId, tagId, handlers) {
  if (!exerciseId || !tagId) return;
  await api(`/api/exercises/${encodeURIComponent(exerciseId)}/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" });
  await refreshExerciseTagEditor();
  state.exerciseSearch.options = emptyExerciseOptions();
  await loadExerciseFilterOptions();
  await refreshCurrentExerciseSearch(handlers);
}

async function refreshExerciseTagEditor() {
  if (!state.tagEditor.open || !state.tagEditor.exerciseId) return;
  const data = await api(`/api/exercises/${encodeURIComponent(state.tagEditor.exerciseId)}/tags`);
  state.tagEditor = { ...state.tagEditor, tags: data.tags || [], options: data.options || [], error: "" };
  updateExerciseTagsInCache(state.tagEditor.exerciseId, state.tagEditor.tags);
}

async function refreshCurrentExerciseSearch(handlers) {
  if (state.activeTab === "builder" && state.builder.selectedNodeId) await loadBuilderExercises();
  // Called after a tag was added/removed on an exercise - the cached list
  // still has the pre-change tags for that row, so this must always be a
  // real re-fetch, never satisfied from cache.
  else await searchExercises(state.exerciseSearch.term, handlers, { forceRefresh: true });
}

function rerenderCurrentExerciseSurface(handlers) {
  if (state.activeTab === "builder" && state.builder.draft) renderBuilder();
  else handlers.renderExercises(state.lastExerciseResults);
}

function updateExerciseTagsInCache(exerciseId, tags) {
  const update = (exercise) => {
    if (String(exercise.id) === String(exerciseId)) exercise.tags = tags;
  };
  state.lastExerciseResults.forEach(update);
  state.builder.exercises.forEach(update);
  if (state.markedExercises.has(exerciseId)) {
    const exercise = state.markedExercises.get(exerciseId);
    state.markedExercises.set(exerciseId, { ...exercise, tags });
  }
}

import { api } from "./api.js";
import { renderBuilderExerciseResults } from "./builder-exercises.js";
import { findBuilderNode } from "./builder-helpers.js";
import { renderBuilder, renderBuilderSectionItems } from "./builder-view.js";
import { applyClientExerciseFilters, exerciseSearchUrl, loadExerciseFilterOptions, loadMarkedExerciseVisibility } from "./exercise-data.js";
import { EXERCISE_FILTERS, state } from "./state.js";
import { buildContextKey, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

const BUILDER_DRAFTS_CACHE_NAMESPACE = "builderDrafts";

// GET /api/builder/drafts is scoped purely to the caller's own account
// (created_by_user_id) - never workspace-dependent, unlike Coaches/
// Organization/Program Library/Exercise Library.
function builderDraftsContextKey() {
  return buildContextKey([state.currentUser?.id]);
}

export function invalidateBuilderDraftsCache() {
  invalidateCacheNamespace(BUILDER_DRAFTS_CACHE_NAMESPACE);
}

let builderExerciseRequestId = 0;
let builderExerciseController;
// The search key of the library load in flight (ensureBuilderExercises).
let builderExercisePendingKey = "";

function builderExerciseSearchKey() {
  return JSON.stringify([state.currentUser?.id, state.builder.exerciseQuery.trim(), state.builder.exerciseFilters]);
}

export async function loadBuilderExercises(options = {}) {
  if (state.activeTab !== "builder") return;
  const searchKey = builderExerciseSearchKey();
  if (options.append && (state.builder.exerciseLoading || !state.builder.exerciseHasMore || state.builder.exerciseSearchKey !== searchKey)) return;
  const requestId = ++builderExerciseRequestId;
  builderExerciseController?.abort();
  const controller = new AbortController();
  builderExerciseController = controller;
  const query = state.builder.exerciseQuery.trim();
  const filters = { ...state.builder.exerciseFilters };
  const offset = options.append ? state.builder.exerciseOffset : 0;
  state.builder.exerciseLoading = true;
  if (!options.append) builderExercisePendingKey = searchKey;
  const moreButton = document.querySelector('[data-action="builder-load-more-exercises"]');
  if (moreButton) moreButton.disabled = true;
  // A new search clears an earlier failure (also for a section editor that
  // opens while it runs), and with nothing shown yet it says it is loading.
  if (!options.append) state.builder.exerciseLoadFailed = false;
  const pendingContainer = !options.append && !state.builder.exercises.length ? document.querySelector(".builder-exercise-results") : null;
  if (pendingContainer) pendingContainer.innerHTML = renderBuilderExerciseResults([], state.markedExerciseIds, null, { loading: true, view: state.builder.exerciseView });
  try {
    const url = `${exerciseSearchUrl(query, 18, filters)}&offset=${offset}`;
    const [data, , visibleMarkedIds] = await Promise.all([
      api(url, { signal: controller.signal }),
      loadExerciseFilterOptions(),
      loadMarkedExerciseVisibility(filters),
    ]);
    if (requestId !== builderExerciseRequestId || searchKey !== builderExerciseSearchKey() || state.activeTab !== "builder") return;
    const exercises = data.exercises || [];
    const filtered = applyClientExerciseFilters(exercises, filters, visibleMarkedIds);
    state.builder.exercises = options.append ? [...state.builder.exercises, ...filtered] : filtered;
    state.builder.exerciseOffset = offset + exercises.length;
    const localMarkedOnly = filters.marked && !filters.favorite && !EXERCISE_FILTERS.some((filter) => filters[filter.key]);
    state.builder.exerciseHasMore = Boolean(data.hasMore) && !localMarkedOnly;
    state.builder.exerciseSearchKey = searchKey;
    state.builder.exerciseLoadFailed = false;
  } catch (error) {
    if (error.name === "AbortError" || requestId !== builderExerciseRequestId) return;
    // Said in place, with Try again, where the exercises would be. The
    // results of another, earlier search never stay under the new one.
    state.builder.exerciseLoadFailed = true;
    state.builder.exerciseLoading = false;
    if (!options.append && state.builder.exerciseSearchKey !== searchKey) state.builder.exercises = [];
    const failedContainer = !options.append && !state.builder.exercises.length ? document.querySelector(".builder-exercise-results") : null;
    if (failedContainer) failedContainer.innerHTML = renderBuilderExerciseResults([], state.markedExerciseIds, null, { failed: true, view: state.builder.exerciseView });
    throw error;
  } finally {
    if (requestId === builderExerciseRequestId) {
      state.builder.exerciseLoading = false;
      builderExerciseController = null;
      builderExercisePendingKey = "";
      if (moreButton) moreButton.disabled = false;
    }
  }
  if (requestId !== builderExerciseRequestId || searchKey !== builderExerciseSearchKey() || state.activeTab !== "builder") return;
  // A results-only refresh (instead of the full renderBuilder()) so typing in the
  // search box never touches the search input itself or any other in-progress edit
  // (sets/reps/instruction, scroll position) elsewhere on the same screen.
  const resultsContainer = document.querySelector(".builder-exercise-results");
  if (resultsContainer && !options.forceFullRender) {
    // The "Added N×" badge (see builderAddedCounts/renderBuilderExerciseResults
    // in builder-exercises.js) must stay correct across a fresh search/filter,
    // not just right after an add - re-derive it from whichever section is
    // currently open, same as renderBuilderSectionPanel's own initial render.
    const selectedSection = findBuilderNode(state.builder.draft, state.builder.selectedNodeId);
    const scrollTop = resultsContainer.scrollTop;
    resultsContainer.innerHTML = renderBuilderExerciseResults(state.builder.exercises, state.markedExerciseIds, selectedSection, { hasMore: state.builder.exerciseHasMore, view: state.builder.exerciseView });
    if (options.append) resultsContainer.scrollTop = scrollTop;
    else scrollBuilderResultsToTop(resultsContainer);
  } else if (options.forceFullRender) {
    renderBuilder();
  }
  options.afterRender?.();
}

// An open section editor shows the library of the current search. Opening
// a draft (Continue) does not wait for the library, so the editor loads it
// when it opens and the list on hand is of another search, of an earlier
// failed load, or of none yet - an empty search then lists every exercise.
// Returns the load's promise, or null when the list is current or already
// on its way.
export function ensureBuilderExercises() {
  if (state.activeTab !== "builder") return null;
  if (findBuilderNode(state.builder.draft, state.builder.selectedNodeId)?.type !== "section") return null;
  const searchKey = builderExerciseSearchKey();
  if (state.builder.exerciseSearchKey === searchKey && !state.builder.exerciseLoadFailed) return null;
  if (state.builder.exerciseLoading && builderExercisePendingKey === searchKey) return null;
  return loadBuilderExercises();
}

// A new search or filter shows its first results. On landscape phones the
// results have no scroll of their own (styles.css) - the section editor
// scrolls under its pinned search row instead - so the editor is brought
// back to the library's top when it was scrolled past it.
function scrollBuilderResultsToTop(resultsContainer) {
  resultsContainer.scrollTop = 0;
  if (globalThis.getComputedStyle?.(resultsContainer).overflowY !== "visible") return;
  const modal = resultsContainer.closest?.(".builder-section-modal");
  const library = resultsContainer.closest?.(".builder-section-library");
  if (!modal || !library) return;
  const libraryTop = library.getBoundingClientRect().top - modal.getBoundingClientRect().top + modal.scrollTop;
  if (modal.scrollTop > libraryTop) modal.scrollTop = libraryTop;
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

export async function loadBuilderDrafts({ forceRefresh = false } = {}) {
  if (state.builder.draft) return;
  await loadCachedView({
    namespace: BUILDER_DRAFTS_CACHE_NAMESPACE,
    contextKey: builderDraftsContextKey(),
    forceRefresh,
    fetcher: () => api("/api/builder/drafts"),
    showLoading: () => { state.builder.draftsLoading = true; },
    applyData: (data) => {
      state.builder.drafts = data.drafts || [];
      state.builder.draftsLoading = false;
      renderBuilder();
    },
    applyError: (error) => {
      // Matches the pre-cache contract exactly: this function never handled
      // its own errors, letting the caller's own .catch(renderBuilderError)
      // (see app.js's loadBuilder()) do it - only reached when nothing was
      // already cached to fall back on (see loadCachedView's keptCache
      // check), so a background refresh failure never hits this path.
      state.builder.draftsLoading = false;
      throw error;
    },
    getCurrentContextKey: builderDraftsContextKey,
  });
}

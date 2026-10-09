import { api } from "./api.js";
import { renderBuilderExerciseResults } from "./builder-exercises.js";
import { findBuilderNode } from "./builder-helpers.js";
import { renderBuilder, renderBuilderSectionItems } from "./builder-view.js";
import { applyClientExerciseFilters, exerciseSearchUrl, loadExerciseFilterOptions } from "./exercise-data.js";
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
  const moreButton = document.querySelector('[data-action="builder-load-more-exercises"]');
  if (moreButton) moreButton.disabled = true;
  try {
    const url = `${exerciseSearchUrl(query, 18, filters)}&offset=${offset}`;
    const [data] = await Promise.all([
      api(url, { signal: controller.signal }),
      loadExerciseFilterOptions(),
    ]);
    if (requestId !== builderExerciseRequestId || searchKey !== builderExerciseSearchKey() || state.activeTab !== "builder") return;
    const exercises = data.exercises || [];
    const filtered = applyClientExerciseFilters(exercises, filters);
    state.builder.exercises = options.append ? [...state.builder.exercises, ...filtered] : filtered;
    state.builder.exerciseOffset = offset + exercises.length;
    const localMarkedOnly = filters.marked && !filters.favorite && !EXERCISE_FILTERS.some((filter) => filters[filter.key]);
    state.builder.exerciseHasMore = Boolean(data.hasMore) && !localMarkedOnly;
    state.builder.exerciseSearchKey = searchKey;
  } catch (error) {
    if (error.name === "AbortError" || requestId !== builderExerciseRequestId) return;
    throw error;
  } finally {
    if (requestId === builderExerciseRequestId) {
      state.builder.exerciseLoading = false;
      builderExerciseController = null;
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
    resultsContainer.innerHTML = renderBuilderExerciseResults(state.builder.exercises, state.markedExerciseIds, selectedSection, { hasMore: state.builder.exerciseHasMore });
    resultsContainer.scrollTop = options.append ? scrollTop : 0;
  } else if (options.forceFullRender) {
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

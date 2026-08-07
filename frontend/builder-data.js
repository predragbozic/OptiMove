import { api } from "./api.js";
import { renderBuilderExerciseResult } from "./builder-exercises.js";
import { renderBuilder, renderBuilderSectionItems } from "./builder-view.js";
import { applyClientExerciseFilters, exerciseSearchUrl, loadExerciseFilterOptions } from "./exercise-data.js";
import { state } from "./state.js";
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

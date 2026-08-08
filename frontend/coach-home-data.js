import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { buildContextKey, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

const COACH_HOME_CACHE_NAMESPACE = "coach-home";

// GET /api/athletes/today is filtered per-viewer and per-workspace only
// (athleteListAccessFilter in backend/src/access.js) - the backend always
// computes "today" itself from the server clock, so no date/athlete/filter
// parameter of any kind reaches it. Account+workspace is therefore the
// complete context key, the same shape as Coaches (coach-profile-actions.js).
export function coachHomeContextKey() {
  return buildContextKey(currentUserWorkspaceContextParts());
}

// Only one entry can ever be "current" for a signed-in tab at a time (there
// is no further per-view filter to fan this out by), so there is no
// meaningful difference between invalidating "this context's entry" and
// invalidating the whole namespace - always clearing the namespace here is
// simplest and exactly as precise.
export function invalidateCoachHomeCache() {
  invalidateCacheNamespace(COACH_HOME_CACHE_NAMESPACE);
}

export async function loadCoachHome({ setLoading, renderCoachHome, forceRefresh = false } = {}) {
  const contextKey = coachHomeContextKey();
  await loadCachedView({
    namespace: COACH_HOME_CACHE_NAMESPACE,
    contextKey,
    forceRefresh,
    fetcher: () => api("/api/athletes/today"),
    showLoading: () => setLoading?.("Loading today's overview..."),
    applyData: (data) => renderCoachHome({ rows: data.rows || [], error: "" }),
    applyError: (error) => renderCoachHome({ rows: [], error: error.message || "Could not load today's overview." }),
    getCurrentContextKey: coachHomeContextKey,
  });
}

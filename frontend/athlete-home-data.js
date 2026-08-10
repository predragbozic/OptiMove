import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { buildContextKey, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

const ATHLETE_HOME_CACHE_NAMESPACE = "athlete-home";

// GET /api/athlete-home resolves the athlete exclusively from the
// authenticated session's own req.authz.athleteId - it takes no
// athleteId/date/filter parameter of any kind, so account+workspace is the
// whole context key, the exact same shape as Coach Home's
// coachHomeContextKey (coach-home-data.js).
export function athleteHomeContextKey() {
  return buildContextKey(currentUserWorkspaceContextParts());
}

export function invalidateAthleteHomeCache() {
  invalidateCacheNamespace(ATHLETE_HOME_CACHE_NAMESPACE);
}

export async function loadAthleteHome({ setLoading, renderAthleteHome, forceRefresh = false } = {}) {
  const contextKey = athleteHomeContextKey();
  await loadCachedView({
    namespace: ATHLETE_HOME_CACHE_NAMESPACE,
    contextKey,
    forceRefresh,
    fetcher: () => api("/api/athlete-home"),
    showLoading: () => setLoading?.("Loading your home..."),
    applyData: (data) => renderAthleteHome({ data, error: "" }),
    applyError: (error) => renderAthleteHome({ data: null, error: error.message || "Could not load your home." }),
    getCurrentContextKey: athleteHomeContextKey,
  });
}

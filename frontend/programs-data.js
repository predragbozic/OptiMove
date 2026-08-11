import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { state } from "./state.js";
import { buildContextKey, invalidateCacheEntry, loadCachedView } from "./view-cache.js";

const PROGRAMS_CACHE_NAMESPACE = "programs";

// GET /api/athletes/:id/program-data?program=__all_programs__ returns every
// non-weekly ("specific") program plan for one athlete in a single request -
// the same endpoint family, same athleteId-scoped shape, as Calendar's
// __weekly__ variant (see weekly-data.js's own comment for the parallel).
// state.selectedProgramId only ever picks WHICH of the already-fetched
// programs to render (see the program-toolbar click handler in app.js,
// which reads back from state.lastProgramBundle and never issues a new
// request) - it never reaches the server, so it is deliberately excluded
// from the context key, the same reasoning weekly applies to week/day/
// month selection. A different athleteId is a different key; returning to
// an athlete/program combination already visited this session is a cache
// hit.
export function programsContextKey(athleteId = state.selectedAthleteId) {
  return buildContextKey([...currentUserWorkspaceContextParts(), athleteId]);
}

export function invalidateProgramsCache(athleteId = state.selectedAthleteId) {
  invalidateCacheEntry(PROGRAMS_CACHE_NAMESPACE, programsContextKey(athleteId));
}

export async function loadPrograms(
  { renderEmpty, setLoading, renderError, renderAthleteHeader, renderProgramToolbar, renderProgramRoot } = {},
  { forceRefresh = false } = {},
) {
  if (!state.selectedAthleteId) {
    renderEmpty?.("No athlete selected.");
    return;
  }
  state.navStack = [];
  // A fresh entry into the tab always starts from an empty search - this
  // only runs once per real navigation into Specific programs (a
  // loadCachedView background refresh re-invokes applyData directly, not
  // this outer function), so it never wipes text the athlete is actively
  // typing.
  state.athleteProgramsSearchQuery = "";
  const athleteId = state.selectedAthleteId;
  await loadCachedView({
    namespace: PROGRAMS_CACHE_NAMESPACE,
    contextKey: programsContextKey(athleteId),
    forceRefresh,
    fetcher: () => api(`/api/athletes/${encodeURIComponent(athleteId)}/program-data?program=__all_programs__`),
    showLoading: () => setLoading?.("Loading specific programs..."),
    applyData: (data) => {
      state.lastProgramBundle = data;
      const programs = data.programs || [];
      if (!state.selectedProgramId) state.selectedProgramId = programs[0]?.id || null;
      renderAthleteHeader(data);
      renderProgramToolbar(programs);
      renderProgramRoot(programs.find((program) => program.id === state.selectedProgramId));
    },
    applyError: (error) => renderError?.(error),
    getCurrentContextKey: () => programsContextKey(state.selectedAthleteId),
  });
}

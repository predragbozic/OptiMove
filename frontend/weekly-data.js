import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { state } from "./state.js";
import { localDateIso, monthStartIso } from "./utils.js";
import { buildContextKey, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";
import { defaultWeekIndex } from "./weekly-plan.js";

const WEEKLY_CACHE_NAMESPACE = "weekly";

// Calendar (the rail's "Calendar" button - openWeeklyCalendarFromRail in
// app.js) and the athlete shell's "calendar" tab are both just
// state.activeTab === "weekly" plus the month-picker overlay on top of it -
// one loader, one endpoint, used by both coach and athlete workspaces.
//
// GET /api/athletes/:athleteId/program-data?program=__weekly__ never takes a
// date-range/week/month/day parameter - backend/src/routes/athletes.js's
// loadWeeklyData always returns every week of weekly-plan data for that
// athlete in one shot, and every week/day/month-picker navigation inside the
// tab (see weekly-actions.js's handleWeeklyAction) is purely client-side
// re-rendering of the already-fetched state.lastWeeklyData - there is no
// api()/fetch call anywhere in weekly-actions.js. So the cache key is
// [...workspace parts, athleteId] only; week/day/month-picker selection is
// deliberately NOT part of it - including it would fragment one identical,
// perfectly cacheable payload into many redundant entries for no reason.
export function weeklyContextKey(athleteId = state.selectedAthleteId) {
  return buildContextKey([...currentUserWorkspaceContextParts(), athleteId]);
}

export function invalidateWeeklyCache() {
  invalidateCacheNamespace(WEEKLY_CACHE_NAMESPACE);
}

export async function loadWeekly(
  { setLoading, renderEmpty, renderError, renderAthleteHeader, renderWeeklyRoot } = {},
  { forceRefresh = false } = {},
) {
  if (!state.selectedAthleteId) {
    renderEmpty?.("No athlete selected.");
    return;
  }
  state.navStack = [];
  const athleteId = state.selectedAthleteId;
  // A one-shot flag consumed exactly once per loadWeekly() call, same as
  // before caching - captured up front so a stale-cache-then-background-
  // refresh (which invokes applyData a second time within this same call)
  // can't re-read it as already-cleared, or re-apply it a second time and
  // reopen/reclose the month picker out from under whatever the user did
  // with it in between the instant cache paint and the refresh landing.
  const shouldOpenWeekCalendar = Boolean(state.openWeekCalendarOnLoad);
  state.openWeekCalendarOnLoad = false;
  let appliedInitialPickerState = false;

  await loadCachedView({
    namespace: WEEKLY_CACHE_NAMESPACE,
    contextKey: weeklyContextKey(athleteId),
    forceRefresh,
    fetcher: () => api(`/api/athletes/${encodeURIComponent(athleteId)}/program-data?program=__weekly__`),
    showLoading: () => setLoading?.("Loading weekly plans..."),
    applyData: (data) => {
      state.lastWeeklyData = data;
      if (!appliedInitialPickerState) {
        appliedInitialPickerState = true;
        state.selectedWeekIndex = defaultWeekIndex(data.weeks || []);
        state.weekSelectorOpen = shouldOpenWeekCalendar;
        if (state.weekSelectorOpen) {
          const activeWeek = data.weeks?.[state.selectedWeekIndex] || data.weeks?.[0];
          state.weekCalendarMonth = monthStartIso(activeWeek?.weekStart || localDateIso());
        }
      }
      renderAthleteHeader?.(data);
      renderWeeklyRoot?.(data);
    },
    // Calendar never had a dedicated error/retry UI before this - a failed
    // fetch just left "Loading weekly plans..." on screen with an uncaught
    // rejection. renderError is the same minimal existing error display
    // every other loader in app.js already falls back to (see
    // loadTemplates/renderError) - reusing it here is required plumbing for
    // loadCachedView's contract, not a new UI concept.
    applyError: (error) => renderError?.(error),
    getCurrentContextKey: () => weeklyContextKey(state.selectedAthleteId),
  });
}

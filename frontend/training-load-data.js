import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { state } from "./state.js";
import { localDateIsoInTimeZone, weekMondayIso } from "./utils.js";
import { buildContextKey, invalidateCacheEntriesWithPrefix, invalidateCacheEntry, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

// Training load (RPE/sRPE), first complete phase. Deliberately its own
// data module, never importing from tests-data.js/tests-actions.js - this
// reuses the SAME date-math/weekly-navigator BEHAVIOR Tests already
// established (request-generation-token race guard, "seed weekStart/
// selectedDate to today only on first visit"), not its state or code.

// perf: GET /weekly's own response for a given (account, workspace,
// weekStart, filter) is IDENTICAL no matter which of Today/Schedule/
// Results is asking for it - before this, each of the three coach tabs
// (plus the athlete's own weekly overlay) fetched it completely
// independently, so switching Today -> Schedule -> Results while looking
// at the exact same week refetched the exact same payload three times in
// a row, every time. Routed through view-cache.js's own loadCachedView
// (the same primitive weekly-data.js's Calendar already uses) so the SAME
// payload is shared across every section/nav slot asking for the same
// (weekStart, filter) this week - a switch within VIEW_CACHE_FRESHNESS_MS
// (the same 30s default every other cached view in this app already
// uses - menu-cache-policy.js's own guidance is to reuse it unless there's
// a specific reason not to, and there isn't one strong enough here to
// justify a bespoke number) shows the shared payload with NO extra
// request at all, and two callers racing for the exact same key while
// it's still in flight collapse into one real HTTP request instead of two
// (dedupeRequest, inside loadCachedView).
//
// This intentionally trades a little of the OLD "always-refresh" tab's
// own guaranteed freshness (menu-cache-policy.js's prior rationale: rated/
// not-rated status changes on nearly every visit) for real request
// reduction on the common case (browsing Today/Schedule/Results, or
// re-entering the tab, within the same short visit) - but never
// permanently: past the TTL, a re-entry paints the cached view instantly
// AND still triggers a real background refresh (loadCachedView's own
// stale-then-refresh path), and every mutation that changes what this
// view shows explicitly invalidates BEFORE reloading - never relies on
// the TTL alone for its own next paint to be genuinely fresh. Two shapes,
// depending on the mutation's own blast radius (see training-load-
// actions.js's own comment at each call site for which one applies):
//   - A mutation confined to one WEEK, but potentially spanning several
//     already-cached FILTER variants of it (a single session's RPE submit
//     or RPE-enabled toggle - the exact same session can appear in the
//     no-filter view AND in one or more athlete/team/club filter views of
//     the same week at once): captureTrainingLoadWeeklyMutationContext/
//     -AthleteWeeklyMutationContext capture the mutation's own identity
//     (account+workspace) and week BEFORE the request is sent, never re-
//     derived from current state after; invalidateTrainingLoadWeeklyContext/
//     -AthleteWeeklyContext (below) then drop every cached filter variant
//     of that exact captured (identity, week) - never just the one filter
//     that happened to be active when the mutation was sent, and never
//     re-targeting whatever workspace happens to be current by the time
//     it resolves (see trainingLoadMutationContextIsCurrentWorkspace).
//   - A mutation that can affect several cached WEEKS/filters at once (the
//     workspace master toggle, ownership resolution, an external
//     schedule's status change, or a recurring/multi-date create/edit/
//     schedule-again): invalidateAllTrainingLoadWeeklyGenerations.
const TRAINING_LOAD_WEEKLY_CACHE_NAMESPACE = "training-load-weekly";

// Item 2 correction's own request-race guard, mirrored exactly: a rapid
// double Next-week click, a rapid filter change, or a workspace switch,
// must never let an OLDER/slower response overwrite a NEWER one already
// applied. "athlete" is a fourth, independent key for the athlete's own
// single weekly nav (see loadTrainingLoadAthleteWeekly below) - entirely
// separate from the coach's three tabs, never sharing a counter with them.
// Kept alongside the view-cache.js race guard (getCurrentContextKey) as
// belt-and-suspenders - the cache guard catches "the context changed",
// this one also catches "this exact nav slot moved on to a different
// request entirely" even when dedupeRequest itself would have collapsed
// two truly-identical concurrent calls into one anyway.
const weeklyRequestGeneration = { today: 0, schedule: 0, results: 0, athlete: 0 };

function clampSelectedDateToWeek(selectedDate, data) {
  if (data.days.some((d) => d.date === selectedDate)) return selectedDate;
  return data.weekStart;
}

function trainingLoadFilterQuery() {
  const { clubIds, teamIds, athleteIds } = state.trainingLoad.filter;
  const parts = [];
  if (clubIds.length) parts.push(`clubIds=${clubIds.map(encodeURIComponent).join(",")}`);
  if (teamIds.length) parts.push(`teamIds=${teamIds.map(encodeURIComponent).join(",")}`);
  if (athleteIds.length) parts.push(`athleteIds=${athleteIds.map(encodeURIComponent).join(",")}`);
  return parts.length ? `&${parts.join("&")}` : "";
}

// [...workspace parts, weekStart, filter-query-string] - the filter query
// string already IS the exact server-relevant signature (clubIds/teamIds/
// athleteIds, in the same normalized order trainingLoadFilterQuery always
// produces), so it's folded in as-is rather than re-decomposed.
function trainingLoadWeeklyContextKey(weekStart, extraQuery) {
  return buildContextKey([...currentUserWorkspaceContextParts(), weekStart, extraQuery]);
}

// Correction round 3 (gap 3): the same key-building logic as
// trainingLoadWeeklyContextKey, but from an already-SNAPSHOTTED
// workspaceParts array instead of reading currentUserWorkspaceContextParts()
// fresh - the identity half of a mutation's own captured context (see
// captureTrainingLoadWeeklyMutationContext/-AthleteWeeklyMutationContext
// below) must never be re-derived from CURRENT state after the mutation's
// own request resolves, exactly like weekStart/filterQuery already
// weren't (correction round 2). A workspace switch mid-flight must never
// make a mutation's own post-request invalidation silently target
// whatever workspace happens to be active NOW instead of the one it was
// actually sent under.
function trainingLoadWeeklyContextKeyForIdentity(workspaceParts, weekStart, extraQuery) {
  return buildContextKey([...workspaceParts, weekStart, extraQuery]);
}

// Correction round 2/3: a mutation's own affected identity+week(+filter)
// must be recorded BEFORE its request is sent, never re-derived from
// CURRENT state after the request resolves - a week-nav click, a filter
// confirm, a workspace switch, or a section switch happening while the
// mutation's own request is still in flight must never change WHICH
// cached entry(ies) get dropped once it lands. Call this synchronously
// right before the mutation's own `await api(...)` call; pass the
// returned snapshot to invalidateTrainingLoadWeeklyContext/
// invalidateTrainingLoadAthleteWeeklyContext (below) AFTER the mutation
// succeeds - never re-read `section`/nav/currentUserWorkspaceContextParts()
// post-await, which is exactly the bug these capture helpers exist to
// prevent.
export function captureTrainingLoadWeeklyMutationContext(section) {
  const nav = state.trainingLoad.weekly[section];
  return nav.weekStart ? { workspaceParts: currentUserWorkspaceContextParts(), weekStart: nav.weekStart, filterQuery: trainingLoadFilterQuery() } : null;
}
// `date` is the actual session/assignment's own calendar date (form.date
// on the athlete's RPE form - see openRpeFormForSessionId in training-
// load-actions.js), NOT state.trainingLoad.athleteWeekly.weekStart -
// correction round 3 (gap 2): the athlete may have browsed the weekly
// overlay to a completely different week and closed it before ever
// opening the RPE form (from Home, which can rate a session from ANY
// past day, not just whatever week the overlay was last left on) - the
// cache entry that actually needs dropping is the one for the WEEK THE
// RATED SESSION IS IN, never "whichever week this overlay happened to
// show last". Applies identically to a planned or an outside-plan
// (external) submission - both share the exact same rpeForm.date field.
export function captureTrainingLoadAthleteWeeklyMutationContext(date) {
  if (!date) return null;
  return { workspaceParts: currentUserWorkspaceContextParts(), weekStart: weekMondayIso(date) };
}

// Correction round 3 (gap 3): true when it's safe for a mutation's own
// post-request invalidate+reload to proceed. `context` is `null` when the
// capture helper found nothing to snapshot in the first place (a genuine
// first-ever load for this nav slot - no weekStart set yet, unrelated to
// any workspace-switch concern) - that case must proceed exactly as
// before (this function existing at all must never block a plain first
// load), so it returns true. The real check only applies when a context
// WAS captured: does the identity snapshotted before the mutation's own
// request was sent still match the one currently active?
// resetTrainingLoadForWorkspaceChange (training-load-actions.js) already
// fully invalidates/resets everything on a genuine workspace switch on
// its own - so a mutation whose captured identity no longer matches
// current must skip its OWN post-mutation invalidate/reload entirely:
// invalidating under the (now-irrelevant) captured identity is harmless
// on its own (that whole namespace was already cleared by the switch),
// but proceeding to reload under whatever identity is CURRENT now would
// fire a pointless extra fetch for a week/section that has nothing to do
// with what this mutation actually changed.
export function trainingLoadMutationContextIsCurrentWorkspace(context) {
  if (!context) return true;
  return buildContextKey(context.workspaceParts) === buildContextKey(currentUserWorkspaceContextParts());
}

// Correction round 3 (gap 1): invalidates EVERY cached filter variant of
// this specific, already-captured (identity, week) - not just the one
// filter that happened to be active when the mutation was sent. A single
// session belongs to exactly one week, but that week's payload is
// independently cached per filter (buildContextKey folds the filter
// query string into the SAME key as the week - see
// trainingLoadWeeklyContextKey's own header), and the exact same session
// can legitimately appear in several of those filter variants at once
// (e.g. viewed with no filter, AND viewed filtered to an athlete/team/
// club that includes it) - every one of them must be dropped, or
// switching back to a still-cached filter view of this same week would
// keep reading pre-mutation data straight past the mutation. `context` is
// `null` when nothing had been fetched yet at capture time - a safe no-op.
// See invalidateAllTrainingLoadWeeklyGenerations's own header for when an
// even wider (every week, not just this one) invalidation is required
// instead (the workspace master toggle, ownership resolution, an
// external schedule's status change, or a recurring/multi-date create/
// edit).
export function invalidateTrainingLoadWeeklyContext(context) {
  if (!context) return;
  // buildContextKey joins [...workspaceParts, weekStart, ""] with "|" -
  // the trailing "" segment means this string ALREADY ends in the exact
  // "|" boundary a real stored key's own filterQuery segment starts
  // after, so it's used as the prefix verbatim: it matches
  // "...|weekStart|" + anything (every filter variant of this exact
  // week), never a different week that merely shares a numeric prefix.
  const keyPrefix = trainingLoadWeeklyContextKeyForIdentity(context.workspaceParts, context.weekStart, "");
  invalidateCacheEntriesWithPrefix(TRAINING_LOAD_WEEKLY_CACHE_NAMESPACE, keyPrefix);
}
// The athlete's own weekly overlay carries no filter concept at all
// (loadTrainingLoadAthleteWeekly always passes extraQuery "") - a single,
// precise key match under the captured identity+week is exact and
// correct here, no prefix/cross-variant invalidation needed.
export function invalidateTrainingLoadAthleteWeeklyContext(context) {
  if (!context) return;
  invalidateCacheEntry(TRAINING_LOAD_WEEKLY_CACHE_NAMESPACE, trainingLoadWeeklyContextKeyForIdentity(context.workspaceParts, context.weekStart, ""));
}

// `onPainted` (optional) fires synchronously at every point this nav
// slot's own visible state actually changed - immediately if a cache hit
// painted instantly, immediately on a genuine first-ever fetch's own
// loading state, and again once the (background or first) fetch settles.
// Callers pass their own renderTrainingLoad so nav/loading state shows up
// on screen the INSTANT it changes, never only after this whole async
// function finally resolves (see app.js's loadTrainingLoad/training-
// load-actions.js's own section-switch handler for why that mattered).
async function loadTrainingLoadWeeklyInto(nav, generationKey, extraQuery, onPainted) {
  if (!nav.weekStart) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const today = localDateIsoInTimeZone(timezone);
    nav.weekStart = weekMondayIso(today);
    nav.selectedDate = today;
  }
  const generation = ++weeklyRequestGeneration[generationKey];
  const contextKey = trainingLoadWeeklyContextKey(nav.weekStart, extraQuery);
  nav.error = "";

  const result = await loadCachedView({
    namespace: TRAINING_LOAD_WEEKLY_CACHE_NAMESPACE,
    contextKey,
    fetcher: () => api(`/api/training-load/weekly?weekStart=${encodeURIComponent(nav.weekStart)}${extraQuery}`),
    showLoading: () => {
      nav.loading = true;
      onPainted?.();
    },
    applyData: (data) => {
      if (generation !== weeklyRequestGeneration[generationKey]) return; // stale - a newer request (a nav change, a filter confirm, or a workspace switch) already started, drop this response entirely
      nav.data = data;
      nav.selectedDate = clampSelectedDateToWeek(nav.selectedDate, data);
      nav.loading = false;
      onPainted?.();
    },
    // A background refresh failing while a cached view is already showing
    // must never blank the screen or show an error over good data -
    // loadCachedView's own contract already only ever calls this for a
    // genuine first-load failure (nothing cached at all yet).
    applyError: (error) => {
      if (generation !== weeklyRequestGeneration[generationKey]) return;
      nav.loading = false;
      nav.error = error.message || "Could not load the training load calendar.";
      onPainted?.();
    },
    getCurrentContextKey: () => trainingLoadWeeklyContextKey(nav.weekStart, extraQuery),
  });
  // Correction round 3 (gap 4): if THIS request's own response was
  // discarded at the cache-primitive level (view-cache.js's own context-
  // key/revision guard - "stale-ignored") while nothing newer has since
  // superseded it at THIS level either (its own generation is still the
  // current one for this nav slot), neither applyData nor applyError ever
  // ran - showLoading()'s own `nav.loading = true` would otherwise be
  // left stuck forever, since nothing else is going to come along and
  // resolve it (a genuinely newer request, if one existed, would have
  // bumped the generation counter and this check would correctly skip).
  if (result?.outcome === "stale-ignored" && generation === weeklyRequestGeneration[generationKey] && nav.loading) {
    nav.loading = false;
    onPainted?.();
  }
}

// Coach Today/Schedule/Results tabs - each keeps its own independent week/
// date, same as tests.weekly, scoped/filtered by state.trainingLoad.filter
// + the caller's current workspace (see trainingLoad.js's own coach-side
// scoping). `onPainted` - see loadTrainingLoadWeeklyInto's own header.
export async function loadTrainingLoadWeekly(section, onPainted) {
  return loadTrainingLoadWeeklyInto(state.trainingLoad.weekly[section], section, trainingLoadFilterQuery(), onPainted);
}

// The athlete's own weekly training-load overlay (item 4 correction) -
// GET /api/training-load/weekly self-scopes automatically for an athlete
// caller (see trainingLoad.js), so no filter query is ever sent here.
export async function loadTrainingLoadAthleteWeekly(onPainted) {
  return loadTrainingLoadWeeklyInto(state.trainingLoad.athleteWeekly, "athlete", "", onPainted);
}

// Correction: called on a workspace switch, BEFORE any new fetch is
// necessarily issued (Training load might not even be the active tab
// right now) - bumping every generation counter guarantees an already-
// in-flight request for the OLD workspace can never land and overwrite
// state after the switch, even if nothing re-fetches immediately. Also
// drops every cached entry for the whole namespace - technically
// redundant (the cache key already includes the workspace, so an old
// entry would simply go unused, never misread), but keeps the cache from
// quietly accumulating orphaned entries across a long session of
// repeated workspace switching.
export function invalidateAllTrainingLoadWeeklyGenerations() {
  for (const key of Object.keys(weeklyRequestGeneration)) weeklyRequestGeneration[key] += 1;
  invalidateCacheNamespace(TRAINING_LOAD_WEEKLY_CACHE_NAMESPACE);
  invalidatePlannedRpeSettingGeneration();
}

// ------------------------------------------------------------
// (v9) Workspace-level master toggle for automatic planned-session RPE -
// its own generation counter, the exact same stale-response-drop pattern
// weeklyRequestGeneration above already establishes: a workspace switch
// must invalidate an in-flight GET for the OLD workspace so it can never
// land and overwrite the NEW workspace's own value once that's applied.
// ------------------------------------------------------------

let plannedRpeSettingGeneration = 0;

export function invalidatePlannedRpeSettingGeneration() {
  plannedRpeSettingGeneration += 1;
}

export async function loadPlannedRpeSetting() {
  const nav = state.trainingLoad.plannedRpeSetting;
  const generation = ++plannedRpeSettingGeneration;
  nav.loading = true;
  nav.error = "";
  try {
    const data = await api("/api/training-load/planned-rpe-setting");
    if (generation !== plannedRpeSettingGeneration) return; // stale - a workspace switch (or a newer load) already started
    nav.enabled = data.enabled;
    nav.enabledAt = data.enabledAt;
    nav.loaded = true;
    nav.loading = false;
  } catch (error) {
    if (generation !== plannedRpeSettingGeneration) return;
    nav.error = error.message || "Could not load the automatic RPE setting.";
    nav.loading = false;
  }
}

export async function savePlannedRpeSetting(enabled) {
  return api("/api/training-load/planned-rpe-setting", { method: "PATCH", body: JSON.stringify({ enabled }) });
}

// (correction round 2) Explicitly assigns the caller's own CURRENT
// workspace to one or more plans still stamped owner_scope='unresolved'
// - "Use current workspace for RPE" (one id) or a confirmed bulk action
// (every currently-visible unresolved id) both call this same endpoint,
// never a client-side "resolve everything" shortcut. The backend re-
// authorizes every id itself and is fully atomic - see routes/
// trainingLoad.js's own POST /plans/resolve-rpe-ownership.
export async function resolvePlanOwnership(planIds) {
  return api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", body: JSON.stringify({ planIds }) });
}

// Athlete's own today - deliberately NOT cached (same reasoning tests-
// data.js's own header gives for its whole module: rated/not-rated status
// changes on nearly every visit, most of all right after the athlete
// submits one, so a stale cache would routinely show a card that should
// already be gone).
export async function loadTrainingLoadAthleteToday() {
  const nav = state.trainingLoad.athleteToday;
  nav.loading = true;
  nav.error = "";
  try {
    const data = await api("/api/training-load/athlete/today");
    nav.date = data.date;
    nav.sessions = data.sessions || [];
    nav.loading = false;
  } catch (error) {
    nav.error = error.message || "Could not load today's training feedback.";
    nav.loading = false;
  }
}

// Coach filter picker (Club/Team/Athletes) - reuses the exact same GET
// /api/organization payload Tests' own recipient picker (tests-data.js's
// loadOrgPickerData) and the Builder's athlete picker already read; a
// second, independent fetch/cache here (not a shared import) so this
// module's state never depends on state.tests having been loaded first.
export async function loadTrainingLoadOrgPickerData() {
  if (state.trainingLoad.orgPickerData) return state.trainingLoad.orgPickerData;
  const data = await api("/api/organization");
  state.trainingLoad.orgPickerData = data;
  return data;
}

// Client sends ONLY rpe/durationMinutes/note - the backend derives sRPE
// itself and never reads a client-supplied value for it.
export async function submitRpe(sessionId, { rpe, durationMinutes, note }) {
  return api(`/api/training-load/sessions/${encodeURIComponent(sessionId)}/rpe`, {
    method: "POST",
    body: JSON.stringify({ rpe, durationMinutes, note: note || "" }),
  });
}

// An RPE session scheduled OUTSIDE any Weekly plan. Same client body shape
// as submitRpe (rpe/durationMinutes/note only - sRPE is always DB-
// derived) and the same idempotent-retry/409-on-genuine-conflict contract,
// keyed on the assignment instead of a logical session.
export async function submitExternalRpe(assignmentId, { rpe, durationMinutes, note }) {
  return api(`/api/training-load/external-assignments/${encodeURIComponent(assignmentId)}/rpe`, {
    method: "POST",
    body: JSON.stringify({ rpe, durationMinutes, note: note || "" }),
  });
}

// Training Load Schedule tab's own quick RPE ON/OFF toggle. A 409 with
// error: "hasExistingResults" is a real, expected outcome (not a failure) -
// the caller shows a confirm dialog and retries with
// confirmDisableWithResults: true if the coach confirms.
export async function toggleSessionRpeEnabled(sessionId, rpeEnabled, confirmDisableWithResults = false) {
  return api(`/api/training-load/sessions/${encodeURIComponent(sessionId)}/rpe-enabled`, {
    method: "PATCH",
    body: JSON.stringify({ rpeEnabled, ...(confirmDisableWithResults ? { confirmDisableWithResults: true } : {}) }),
  });
}

// ------------------------------------------------------------
// External (outside-plan) RPE scheduling - "New RPE session" on the
// Schedule tab. Same CRUD/lifecycle contract as WELLNESS's own schedule
// endpoints (tests-data.js), a fully independent set of routes/tables.
// ------------------------------------------------------------

export async function createExternalSchedule(body) {
  return api("/api/training-load/external-schedules", { method: "POST", body: JSON.stringify(body) });
}

export async function loadExternalScheduleDetail(scheduleId) {
  return api(`/api/training-load/external-schedules/${encodeURIComponent(scheduleId)}`);
}

export async function updateExternalSchedule(scheduleId, body) {
  return api(`/api/training-load/external-schedules/${encodeURIComponent(scheduleId)}`, { method: "PATCH", body: JSON.stringify(body) });
}

export async function setExternalScheduleStatus(scheduleId, status) {
  return api(`/api/training-load/external-schedules/${encodeURIComponent(scheduleId)}/${status}`, { method: "POST" });
}

export async function scheduleExternalAgain(scheduleId, body) {
  return api(`/api/training-load/external-schedules/${encodeURIComponent(scheduleId)}/schedule-again`, { method: "POST", body: JSON.stringify(body) });
}

// Body: { assignmentIds: [] }. Same per-item outcome-code contract as
// WELLNESS's own manual reminder (tests-data.js's sendManualReminder).
export async function sendExternalScheduleReminder(scheduleId, assignmentIds) {
  return api(`/api/training-load/external-schedules/${encodeURIComponent(scheduleId)}/remind`, {
    method: "POST",
    body: JSON.stringify({ assignmentIds }),
  });
}

import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { state } from "./state.js";
import { addDaysIso, endOfWeekIso, localDateIsoInTimeZone, monthStartIso, startOfWeekIso, weekMondayIso } from "./utils.js";
import { buildContextKey, invalidateCacheEntriesWithPrefix, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";
import { trainingLoadFilterQuery } from "./training-load-data.js";

// Training Load Frontend 3A — the unified calendar read model
// (GET /api/training-load/calendar). A genuinely separate cache namespace
// and data shape from training-load-data.js's own weekly (RPE-session-
// shaped) cache — this returns canonical-activity-shaped items instead
// (see routes/trainingLoad.js's own GET /calendar). Same request-
// generation-token race guard and capture-before-mutate invalidation
// convention that module already established, reused here rather than
// reinvented.
const CALENDAR_WEEK_NAMESPACE = "training-load-calendar-week";
const CALENDAR_MONTH_NAMESPACE = "training-load-calendar-month";
const ACTIVITY_DETAIL_NAMESPACE = "training-load-calendar-activity";
const METRIC_DEFINITIONS_NAMESPACE = "training-load-calendar-metric-defs";
// Phase D: Athletes' own "canonical activities this week" section - the
// SAME /calendar endpoint the coach-wide week/month views already use,
// filtered server-side to one athleteId (the existing athleteIds filter
// param, never a new endpoint), so this is its own cache namespace keyed
// by athleteId+week rather than reusing calendarContextKey (which has no
// athlete dimension and would collide across different athletes).
const RESULTS_ATHLETE_ACTIVITIES_NAMESPACE = "training-load-results-athlete-activities";
// Phase E: Overview's "Activity & data coverage" block - the SAME
// /calendar endpoint and the SAME (workspace, week, filter) context key
// shape Activities' own week view already uses (calendarContextKey,
// unchanged), just its own cache namespace/generation counter so
// Overview's own fetch lifecycle never shares a generation with
// Activities' - two sections reading the same underlying data
// independently, never coupled.
const OVERVIEW_COVERAGE_NAMESPACE = "training-load-overview-coverage";

let weekGeneration = 0;
let monthGeneration = 0;
let activityDetailGeneration = 0;
let resultsAthleteActivitiesGeneration = 0;
let overviewCoverageGeneration = 0;

// Item 2's own "workspace and athlete/team filters" requirement — the SAME
// Club/Team/Athletes filter picker (state.trainingLoad.filter) the old
// weekly tabs already read, applied here via the exact same
// trainingLoadFilterQuery() helper (exported from training-load-data.js,
// never duplicated) so the Calendar's own "Filter" control — which shares
// one toolbar with Schedule/Results — actually narrows what the calendar
// shows. Folded into both the fetch URL and the cache context key, so a
// filter change is its own distinct cache entry, exactly like the weekly
// cache's own (week, filter) key shape.
function calendarContextKey(dateFrom, dateTo) {
  return buildContextKey([...currentUserWorkspaceContextParts(), dateFrom, dateTo, trainingLoadFilterQuery()]);
}
function calendarContextKeyForIdentity(workspaceParts, dateFrom, dateTo) {
  return buildContextKey([...workspaceParts, dateFrom, dateTo, ""]);
}

// Same shape as training-load-data.js's own captureTrainingLoadWeeklyMutationContext
// — deliberately compatible, so a single capture at a coach-side mutation
// site can invalidate BOTH the old weekly cache AND this one without a
// second, separate capture call.
export function captureTrainingLoadCalendarMutationContext() {
  const nav = state.trainingLoad.calendar;
  return nav.weekStart ? { workspaceParts: currentUserWorkspaceContextParts(), weekStart: nav.weekStart } : null;
}

// Falls back to the WEEK's own request start (`nav.weekStart`, the local
// source of truth this fetch was actually made for) — not a field on
// `data` itself, since the backend response carries `dateFrom`/`dateTo`,
// never a `weekStart` key.
function clampSelectedDateToWeek(selectedDate, weekStart, data) {
  if (data.days.some((d) => d.date === selectedDate)) return selectedDate;
  return weekStart;
}

// `onPainted` — see training-load-data.js's own loadTrainingLoadWeeklyInto
// for why this fires synchronously at every point the nav slot's own
// visible state actually changed, never only after the whole async
// function resolves.
export async function loadTrainingLoadCalendarWeek(onPainted) {
  const nav = state.trainingLoad.calendar;
  if (!nav.weekStart) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const today = localDateIsoInTimeZone(timezone);
    nav.weekStart = weekMondayIso(today);
    nav.selectedDate = today;
  }
  const weekEnd = addDaysIso(nav.weekStart, 6);
  const generation = ++weekGeneration;
  const contextKey = calendarContextKey(nav.weekStart, weekEnd);
  nav.error = "";

  const result = await loadCachedView({
    namespace: CALENDAR_WEEK_NAMESPACE,
    contextKey,
    fetcher: () => api(`/api/training-load/calendar?dateFrom=${encodeURIComponent(nav.weekStart)}&dateTo=${encodeURIComponent(weekEnd)}${trainingLoadFilterQuery()}`),
    showLoading: () => {
      nav.loading = true;
      onPainted?.();
    },
    applyData: (data) => {
      if (generation !== weekGeneration) return; // stale — a newer request already started
      nav.data = data;
      nav.selectedDate = clampSelectedDateToWeek(nav.selectedDate, nav.weekStart, data);
      nav.loading = false;
      onPainted?.();
    },
    applyError: (error) => {
      if (generation !== weekGeneration) return;
      nav.loading = false;
      nav.error = error.message || "Could not load the training calendar.";
      onPainted?.();
    },
    getCurrentContextKey: () => calendarContextKey(nav.weekStart, weekEnd),
  });
  if (generation !== weekGeneration) return;
  // Self-heal exactly like loadTrainingLoadWeeklyInto's own retry — this
  // exact context was invalidated by an unrelated mutation while still in
  // flight; nothing else necessarily retries it.
  if (result?.outcome === "invalidated-stale") {
    await loadTrainingLoadCalendarWeek(onPainted);
    return;
  }
  if (result?.outcome === "stale-ignored" && nav.loading) {
    nav.loading = false;
    onPainted?.();
  }
}

// Month mode (item 4) — a wider [gridStart, gridEnd] range (up to 42 days,
// the full 6-row month grid) fetched through the SAME endpoint and cache
// primitive, under its OWN namespace/generation counter so a week-mode
// fetch and a month-mode fetch can never race each other's `loading`
// flag. `monthCursor` (YYYY-MM-01) is independent of weekStart — the
// selected week need not be the month's own first week.
export async function loadTrainingLoadCalendarMonth(onPainted) {
  const nav = state.trainingLoad.calendar;
  if (!nav.monthCursor) nav.monthCursor = monthStartIso(nav.selectedDate || nav.weekStart);
  const gridStart = startOfWeekIso(nav.monthCursor);
  const gridEnd = endOfWeekIso(addDaysIso(monthStartIso(addDaysIso(nav.monthCursor, 32)), -1));
  const generation = ++monthGeneration;
  const contextKey = calendarContextKey(gridStart, gridEnd);
  nav.monthError = "";

  const result = await loadCachedView({
    namespace: CALENDAR_MONTH_NAMESPACE,
    contextKey,
    fetcher: () => api(`/api/training-load/calendar?dateFrom=${encodeURIComponent(gridStart)}&dateTo=${encodeURIComponent(gridEnd)}${trainingLoadFilterQuery()}`),
    showLoading: () => {
      nav.monthLoading = true;
      onPainted?.();
    },
    applyData: (data) => {
      if (generation !== monthGeneration) return;
      nav.monthData = data;
      nav.monthLoading = false;
      onPainted?.();
    },
    applyError: (error) => {
      if (generation !== monthGeneration) return;
      nav.monthLoading = false;
      nav.monthError = error.message || "Could not load the training calendar.";
      onPainted?.();
    },
    getCurrentContextKey: () => calendarContextKey(gridStart, gridEnd),
  });
  if (generation !== monthGeneration) return;
  if (result?.outcome === "invalidated-stale") {
    await loadTrainingLoadCalendarMonth(onPainted);
    return;
  }
  if (result?.outcome === "stale-ignored" && nav.monthLoading) {
    nav.monthLoading = false;
    onPainted?.();
  }
}

// Phase D: one athlete's own canonical activities for the shared week,
// shown inside their Athletes detail as a "raw values live in Activities"
// deep-link list - never their per-activity raw metric values themselves
// (that stays a per-activity fetch, only ever made when Activities itself
// opens that one activity - see loadActivityDetail below), so this is
// exactly one request regardless of how many activities the athlete had
// that week, never N+1.
export async function loadResultsAthleteActivities(athleteId, weekStart, onPainted) {
  const nav = state.trainingLoad.resultsAthleteActivities;
  const weekEnd = addDaysIso(weekStart, 6);
  const generation = ++resultsAthleteActivitiesGeneration;
  const contextKey = buildContextKey([...currentUserWorkspaceContextParts(), athleteId, weekStart, weekEnd]);
  const isNewContext = nav.athleteId !== athleteId || nav.weekStart !== weekStart;
  nav.athleteId = athleteId;
  nav.weekStart = weekStart;
  if (isNewContext) nav.data = null;
  nav.error = "";

  const result = await loadCachedView({
    namespace: RESULTS_ATHLETE_ACTIVITIES_NAMESPACE,
    contextKey,
    fetcher: () => api(`/api/training-load/calendar?dateFrom=${encodeURIComponent(weekStart)}&dateTo=${encodeURIComponent(weekEnd)}&athleteIds=${encodeURIComponent(athleteId)}`),
    showLoading: () => {
      nav.loading = true;
      onPainted?.();
    },
    applyData: (data) => {
      if (generation !== resultsAthleteActivitiesGeneration) return;
      nav.data = data;
      nav.loading = false;
      onPainted?.();
    },
    applyError: (error) => {
      if (generation !== resultsAthleteActivitiesGeneration) return;
      nav.loading = false;
      nav.error = error.message || "Could not load this athlete's activities.";
      onPainted?.();
    },
    getCurrentContextKey: () => buildContextKey([...currentUserWorkspaceContextParts(), athleteId, weekStart, weekEnd]),
  });
  if (generation !== resultsAthleteActivitiesGeneration) return;
  if (result?.outcome === "invalidated-stale") {
    await loadResultsAthleteActivities(athleteId, weekStart, onPainted);
    return;
  }
  if (result?.outcome === "stale-ignored" && nav.loading) {
    nav.loading = false;
    onPainted?.();
  }
}

// Phase E: Overview's "Activity & data coverage" block - one fetch of the
// existing /calendar endpoint for the shared week (no athleteIds filter -
// this reads the SAME workspace/Club/Team/Athletes filter scope Activities
// itself uses, via calendarContextKey/trainingLoadFilterQuery, never a
// second copy of that filter contract), aggregated client-side in
// training-load-view.js's own computeOverviewCoverage. Deliberately a
// separate nav slot/namespace from `weekly.overview` (the RPE/training-
// load block) - never merged, per the product requirement that Overview's
// two blocks stay two distinct models. Same isNewWeek-clears-data guard as
// loadResultsAthleteActivities (Phase D) - never let a stale week's
// coverage render under what already looks like the new week's heading
// during the in-flight window.
export async function loadOverviewCoverage(weekStart, onPainted) {
  const nav = state.trainingLoad.overviewCoverage;
  const weekEnd = addDaysIso(weekStart, 6);
  const generation = ++overviewCoverageGeneration;
  const contextKey = calendarContextKey(weekStart, weekEnd);
  const isNewWeek = nav.weekStart !== weekStart;
  nav.weekStart = weekStart;
  if (isNewWeek) nav.data = null;
  nav.error = "";

  const result = await loadCachedView({
    namespace: OVERVIEW_COVERAGE_NAMESPACE,
    contextKey,
    fetcher: () => api(`/api/training-load/calendar?dateFrom=${encodeURIComponent(weekStart)}&dateTo=${encodeURIComponent(weekEnd)}${trainingLoadFilterQuery()}`),
    showLoading: () => {
      nav.loading = true;
      onPainted?.();
    },
    applyData: (data) => {
      if (generation !== overviewCoverageGeneration) return;
      nav.data = data;
      nav.loading = false;
      onPainted?.();
    },
    applyError: (error) => {
      if (generation !== overviewCoverageGeneration) return;
      nav.loading = false;
      nav.error = error.message || "Could not load activity & data coverage.";
      onPainted?.();
    },
    getCurrentContextKey: () => calendarContextKey(weekStart, weekEnd),
  });
  if (generation !== overviewCoverageGeneration) return;
  if (result?.outcome === "invalidated-stale") {
    await loadOverviewCoverage(weekStart, onPainted);
    return;
  }
  if (result?.outcome === "stale-ignored" && nav.loading) {
    nav.loading = false;
    onPainted?.();
  }
}

// Activity Detail (item 7) — the canonical read contract
// (GET /api/training-activity/:activityId), cached by activityId so
// flipping back to an already-open activity this session repaints
// instantly. A DIFFERENT activityId always starts a fresh fetch and never
// shows the PREVIOUS activity's stale detail while loading.
export async function loadActivityDetail(activityId, onPainted) {
  const nav = state.trainingLoad.calendar.activityDetail;
  if (nav.activityId !== activityId) {
    nav.activityId = activityId;
    nav.data = null;
    nav.error = "";
  }
  const generation = ++activityDetailGeneration;
  const contextKey = buildContextKey([...currentUserWorkspaceContextParts(), activityId]);

  await loadCachedView({
    namespace: ACTIVITY_DETAIL_NAMESPACE,
    contextKey,
    fetcher: () => api(`/api/training-activity/${encodeURIComponent(activityId)}`),
    showLoading: () => {
      nav.loading = true;
      onPainted?.();
    },
    applyData: (data) => {
      if (generation !== activityDetailGeneration || state.trainingLoad.calendar.activityDetail.activityId !== activityId) return;
      nav.data = data;
      nav.loading = false;
      onPainted?.();
    },
    applyError: (error) => {
      if (generation !== activityDetailGeneration || state.trainingLoad.calendar.activityDetail.activityId !== activityId) return;
      nav.loading = false;
      nav.error = error.message || "Could not load this activity.";
      onPainted?.();
    },
    getCurrentContextKey: () => (state.trainingLoad.calendar.activityDetail.activityId === activityId
      ? buildContextKey([...currentUserWorkspaceContextParts(), activityId])
      : "__superseded__"),
  });
}

// Metric picker (item 8) — reuses the existing catalog list endpoint
// (already used by the metrics catalog UI), scoped to whatever definitions
// are visible to the current workspace. Loaded once per workspace, not
// re-fetched on every picker open within the same visit.
let metricDefinitionsWorkspaceKey = "";
export async function loadCalendarMetricDefinitions() {
  const nav = state.trainingLoad.calendar.metricPicker;
  const contextKey = buildContextKey(currentUserWorkspaceContextParts());
  if (nav.definitions && metricDefinitionsWorkspaceKey === contextKey) return nav.definitions;
  nav.loading = true;
  nav.error = "";
  try {
    const rows = [];
    let cursor = null;
    // The catalog list endpoint is cursor-paginated (same convention as
    // every other keyset-paginated list in this app) — a metric picker
    // needs the FULL visible set to search/group client-side, so this
    // walks every page once, capped generously (200 x 50 = far beyond any
    // realistic catalog size) rather than risking an infinite loop on a
    // malformed cursor.
    for (let page = 0; page < 200; page += 1) {
      const query = cursor ? `?limit=100&cursorLabel=${encodeURIComponent(cursor.label)}&cursorId=${encodeURIComponent(cursor.id)}` : "?limit=100";
      const data = await api(`/api/training-load/metrics/definitions${query}`);
      rows.push(...(data.rows || []));
      if (!data.nextCursor) break;
      cursor = data.nextCursor;
    }
    // Domain/category GROUPING (item 8) — the definitions list itself
    // carries no domain/category label (metric_structure_links is a
    // separate table with no name join of its own — see
    // trainingLoadMetricsCatalog.js's own listStructureLinks/listDomains/
    // listCategories). Composed here from the SAME three already-existing,
    // already-authorized catalog endpoints the rest of this app's metrics
    // catalog UI reads — never a new backend endpoint for this.
    const [domains, categories, links] = await Promise.all([
      api("/api/training-load/metrics/domains").catch(() => ({ rows: [] })),
      api("/api/training-load/metrics/categories").catch(() => ({ rows: [] })),
      api("/api/training-load/metrics/structure-links").catch(() => ({ rows: [] })),
    ]);
    const domainNameById = new Map((domains.rows || []).map((d) => [d.id, d.name]));
    const categoryNameById = new Map((categories.rows || []).map((c) => [c.id, c.name]));
    const groupByDefId = new Map();
    for (const link of links.rows || []) {
      if (groupByDefId.has(link.metric_definition_id)) continue; // first link wins - a definition may have more than one; the picker groups by ONE label, not a cross-product
      const label = (link.domain_id && domainNameById.get(link.domain_id)) || (link.category_id && categoryNameById.get(link.category_id)) || null;
      if (label) groupByDefId.set(link.metric_definition_id, label);
    }
    // Raw catalog rows are snake_case (training_load_metrics_catalog.js's
    // own `select d.*` convention) - mapped to this app's usual camelCase
    // shape here, once, rather than every call site re-reading raw column
    // names.
    nav.definitions = rows.map((d) => ({
      id: d.id,
      label: d.label,
      shortLabel: d.short_label,
      unit: d.unit,
      iconUrl: d.icon_url,
      domainLabel: groupByDefId.get(d.id) || null,
    }));
    metricDefinitionsWorkspaceKey = contextKey;
    nav.loading = false;
    return nav.definitions;
  } catch (error) {
    nav.loading = false;
    nav.error = error.message || "Could not load metric definitions.";
    return [];
  }
}

// ------------------------------------------------------------
// Invalidation — mirrors training-load-data.js's own two-shape
// convention exactly: a mutation confined to one (workspace, week) drops
// just that week's cached entries (week + month namespaces both keyed by
// date-range strings that always fall within, or are dropped by,
// invalidateCacheEntriesWithPrefix's own prefix match on the identity —
// see below); a mutation whose blast radius isn't known/confined this
// precisely (an athlete's own RPE submit, which can materialize an
// Activity a coach's calendar cache has no way to have anticipated) uses
// the wide, whole-namespace invalidation instead.
// ------------------------------------------------------------

// `context` is the SAME {workspaceParts, weekStart} shape
// captureTrainingLoadWeeklyMutationContext/captureTrainingLoadCalendarMutationContext
// both produce — a single capture at a coach-side mutation site can
// invalidate both the old weekly cache and this one. Drops every WEEK-mode
// cache entry for that identity (there is only ever one dateFrom/dateTo
// pair per week, so a plain prefix match on the identity is exact); month
// mode uses a wider window that may or may not include this exact week, so
// it is invalidated in full instead — one extra background month refetch
// is a fair, simple price for guaranteed correctness here, and month mode
// is not the common case a single-session-toggle mutation is optimizing
// for.
export function invalidateTrainingLoadCalendarContext(context) {
  if (!context) return;
  const weekEnd = addDaysIso(context.weekStart, 6);
  invalidateCacheEntriesWithPrefix(CALENDAR_WEEK_NAMESPACE, calendarContextKeyForIdentity(context.workspaceParts, context.weekStart, weekEnd));
  invalidateCacheNamespace(CALENDAR_MONTH_NAMESPACE);
}

// Wide invalidation — an athlete's own RPE submission (no coach workspace
// context available to capture at that mutation site — the acting
// identity there is the athlete, not any particular watching coach), a
// metrics event, or a match-suggestion accept/dismiss can change what ANY
// coach's calendar shows for that day. Also bumps every generation counter
// so an in-flight request from before the mutation can never land and
// overwrite the post-mutation state.
export function invalidateAllTrainingLoadCalendarGenerations() {
  weekGeneration += 1;
  monthGeneration += 1;
  activityDetailGeneration += 1;
  resultsAthleteActivitiesGeneration += 1;
  overviewCoverageGeneration += 1;
  invalidateCacheNamespace(CALENDAR_WEEK_NAMESPACE);
  invalidateCacheNamespace(CALENDAR_MONTH_NAMESPACE);
  invalidateCacheNamespace(ACTIVITY_DETAIL_NAMESPACE);
  invalidateCacheNamespace(RESULTS_ATHLETE_ACTIVITIES_NAMESPACE);
  invalidateCacheNamespace(OVERVIEW_COVERAGE_NAMESPACE);
}

// Used after a mutation known to affect Activity Detail (a match-
// suggestion accept/dismiss, a reparent/merge) so it repaints fresh
// without a wider week/month reload. The namespace is small (one entry
// per activity actually opened this session), so a full clear here is
// simple and cheap rather than tracking one exact activityId.
export function invalidateActivityDetail() {
  invalidateCacheNamespace(ACTIVITY_DETAIL_NAMESPACE);
}

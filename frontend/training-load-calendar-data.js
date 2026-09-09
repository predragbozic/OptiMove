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

let weekGeneration = 0;
let monthGeneration = 0;
let activityDetailGeneration = 0;

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
  invalidateCacheNamespace(CALENDAR_WEEK_NAMESPACE);
  invalidateCacheNamespace(CALENDAR_MONTH_NAMESPACE);
  invalidateCacheNamespace(ACTIVITY_DETAIL_NAMESPACE);
}

// Used after a mutation known to affect Activity Detail (a match-
// suggestion accept/dismiss, a reparent/merge) so it repaints fresh
// without a wider week/month reload. The namespace is small (one entry
// per activity actually opened this session), so a full clear here is
// simple and cheap rather than tracking one exact activityId.
export function invalidateActivityDetail() {
  invalidateCacheNamespace(ACTIVITY_DETAIL_NAMESPACE);
}

import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { emptyCentralCalendarState, state } from "./state.js";
import { addDaysIso, localDateIso, monthWeeksIso, weekMondayIso } from "./utils.js";
import { buildContextKey, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

// Central calendar (K1b) - the reads of GET /api/calendar, the K1a read API
// (docs/ai/central-calendar-k1-plan.md). One request per visible range,
// never a filter parameter (the chips filter the answer in memory, plan
// decision A), and one extra read of a single day with include=athletes
// when the item panel needs names. Both go through view-cache.js'
// loadCachedView with a context key of account + workspace + range + the
// browser's date (the server derives every status from `today`, so a tab
// left open past midnight reads again). A slower older answer is dropped
// by the generation counters below, the same guard as
// training-load-calendar-data.js.
export const CENTRAL_CALENDAR_NAMESPACE = "central-calendar";
const CENTRAL_CALENDAR_DAY_NAMESPACE = "central-calendar-day";
// The week mode is a per-browser convenience (the exercise-view-modes.js
// pattern): never sent to the server, read in a try so a browser without
// storage still works.
const WEEK_MODE_STORAGE_KEY = "optimove.central-calendar.week-mode";

export const CENTRAL_CALENDAR_KINDS = Object.freeze(["planned", "activity", "external", "test"]);
export const CENTRAL_CALENDAR_VIEWS = Object.freeze(["month", "week", "day"]);

let rangeGeneration = 0;
let dayGeneration = 0;

// The days one request covers: a month is its grid of whole weeks (35 or 42
// days, under the API's cap of 62); a week and a day are the Monday-to-Sunday
// week of the anchor, so a day <-> week switch and the day arrows inside a
// week need no request.
export function centralCalendarRange(view, anchor) {
  const day = anchor || localDateIso();
  if (view === "month") {
    const weeks = monthWeeksIso(day.slice(0, 7));
    return { from: weeks[0][0], to: weeks[weeks.length - 1][6] };
  }
  const monday = weekMondayIso(day);
  return { from: monday, to: addDaysIso(monday, 6) };
}

export function centralCalendarContextKey(from, to, today) {
  return buildContextKey([...currentUserWorkspaceContextParts(), from, to, today]);
}

function dayContextKey(date, today) {
  return buildContextKey([...currentUserWorkspaceContextParts(), date, today]);
}

export function centralCalendarUrl(from, to, today, { includeAthletes = false } = {}) {
  const params = new URLSearchParams({ from, to, today });
  if (includeAthletes) params.set("include", "athletes");
  return `/api/calendar?${params.toString()}`;
}

// A plan saved or deleted in the Builder changes the planned cards of its
// days (builder-actions.js calls this at its two exits, as it does for the
// weekly plan and Coach Home); a workspace switch clears everything.
export function invalidateCentralCalendarCache() {
  invalidateCacheNamespace(CENTRAL_CALENDAR_NAMESPACE);
  invalidateCacheNamespace(CENTRAL_CALENDAR_DAY_NAMESPACE);
}

export function resetCentralCalendarForWorkspaceChange() {
  state.centralCalendar = emptyCentralCalendarState();
  rangeGeneration += 1;
  dayGeneration += 1;
}

export function readCentralCalendarWeekMode() {
  try {
    return globalThis.localStorage?.getItem(WEEK_MODE_STORAGE_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function writeCentralCalendarWeekMode(mode) {
  try {
    globalThis.localStorage?.setItem(WEEK_MODE_STORAGE_KEY, mode === "grid" ? "grid" : "list");
  } catch {
    // The choice then lives for this page only.
  }
}

// The sentence for a failed read, by the API's stable codes (plan section 7).
// `detail` carries the server's own sentence for an administrator's
// Technical details, never shown as the headline.
export function describeCentralCalendarError(error) {
  const status = Number(error?.status) || 0;
  const code = typeof error?.data?.error === "string" ? error.data.error : "";
  const detail = typeof error?.data?.message === "string" ? error.data.message : "";
  if (status === 400 && code === "invalid_today") {
    return { code, message: "Your device's date differs from the server's. Check the clock and try again.", detail: "" };
  }
  if (status === 400) return { code: code || "bad_request", message: "The calendar could not be read.", detail };
  if (status === 401) return { code: "unauthorized", message: "Please sign in again.", detail: "" };
  if (status === 403) return { code: "forbidden", message: "No calendar for this workspace.", detail: "" };
  if (status === 503 || code === "database_busy") return { code: "database_busy", message: "The server is busy. Try again in a moment.", detail: "" };
  if (!status) return { code: "network", message: "Could not reach the server.", detail: "" };
  return { code: code || `http_${status}`, message: "The calendar could not be read.", detail };
}

function currentRangeContextKey() {
  const cal = state.centralCalendar;
  const range = centralCalendarRange(cal.view, cal.anchor);
  return centralCalendarContextKey(range.from, range.to, localDateIso());
}

// The range read. Seeds the anchor (today), the selected day and the week
// mode on the first call; clears data of another range so it is never shown
// under this range's label; paints through `render` at every change of the
// visible state (loading, data, error), the convention of
// loadTrainingLoadCalendarWeek.
export async function loadCentralCalendar({ render, forceRefresh = false } = {}, { retried = false } = {}) {
  const cal = state.centralCalendar;
  const today = localDateIso();
  if (!cal.anchor) cal.anchor = today;
  if (!cal.selectedDate) cal.selectedDate = cal.anchor;
  if (!cal.weekMode) cal.weekMode = readCentralCalendarWeekMode();
  const range = centralCalendarRange(cal.view, cal.anchor);
  cal.range = range;
  if (cal.data && (cal.data.from !== range.from || cal.data.to !== range.to)) cal.data = null;
  const generation = ++rangeGeneration;
  const contextKey = centralCalendarContextKey(range.from, range.to, today);
  cal.error = "";
  cal.errorCode = "";
  cal.errorDetail = "";
  cal.refreshError = "";
  cal.notice = "";
  const current = () => generation === rangeGeneration && state.centralCalendar === cal;
  const result = await loadCachedView({
    namespace: CENTRAL_CALENDAR_NAMESPACE,
    contextKey,
    forceRefresh,
    fetcher: () => api(centralCalendarUrl(range.from, range.to, today)),
    showLoading: () => {
      if (!current()) return;
      cal.loading = true;
      render?.();
    },
    applyData: (data) => {
      if (!current()) return;
      cal.data = data;
      cal.loading = false;
      // The open item is no longer on its day in the answer (a plan deleted
      // elsewhere, a session superseded or moved): the panel closes with one
      // quiet line instead of vanishing behind an empty panel column. The
      // same lookup the view makes (the panel's day), so the two agree.
      if (cal.panel.open && !(data.days || []).find((day) => day.date === cal.panel.date)?.items?.some((item) => item.key === cal.panel.key)) {
        cal.panel = { open: false, key: "", date: "", athletes: null, loading: false, error: "" };
        cal.notice = "The item you had open is no longer on this day; the calendar is up to date.";
      }
      render?.();
    },
    applyError: (error) => {
      if (!current()) return;
      const described = describeCentralCalendarError(error);
      cal.loading = false;
      // The same range is already on screen (its cache entry was dropped by
      // an invalidation and read again): the calendar stays and the failure
      // is one note, as for a failed background refresh. Only a range with
      // nothing to show gets the error state.
      if (cal.data) {
        cal.refreshError = `${described.message} Showing the last loaded calendar.`;
      } else {
        cal.error = described.message;
        cal.errorCode = described.code;
        cal.errorDetail = described.detail;
      }
      render?.();
    },
    getCurrentContextKey: currentRangeContextKey,
  });
  if (!current()) return result;
  // This exact range was invalidated while the answer was in flight (a plan
  // saved in the Builder meanwhile); nothing else reads it again, so once.
  if (result?.outcome === "invalidated-stale" && !retried) return loadCentralCalendar({ render, forceRefresh }, { retried: true });
  // The same generation and a context key that moved on: only the browser's
  // date rolled over while the answer was in flight. Read once more with the
  // new `today` instead of leaving "Loading calendar…" on screen.
  if (result?.outcome === "stale-ignored" && !retried) return loadCentralCalendar({ render, forceRefresh }, { retried: true });
  if (result?.outcome === "background-refresh-failed") {
    cal.refreshError = "Could not refresh. Showing the last loaded calendar.";
    render?.();
  }
  if (result?.outcome === "stale-ignored" && cal.loading) {
    cal.loading = false;
    render?.();
  }
  return result;
}

export function findCentralCalendarItem(data, key) {
  for (const day of data?.days || []) {
    const item = (day.items || []).find((entry) => entry.key === key);
    if (item) return item;
  }
  return null;
}

// The panel's athletes: the item's day read again with include=athletes and
// the item picked by its key. The card's own facts stay those of the range
// answer; only `athletes` is taken from here. A late answer for a panel
// that closed or moved to another item is dropped.
export async function loadCentralCalendarDay({ render, forceRefresh = false } = {}) {
  const cal = state.centralCalendar;
  const panel = cal.panel;
  if (!panel.open || !panel.key || !panel.date) return;
  const { key, date } = panel;
  const today = localDateIso();
  const generation = ++dayGeneration;
  panel.loading = true;
  panel.error = "";
  panel.athletes = null;
  render?.();
  const current = () => generation === dayGeneration && state.centralCalendar === cal && cal.panel.open && cal.panel.key === key;
  await loadCachedView({
    namespace: CENTRAL_CALENDAR_DAY_NAMESPACE,
    contextKey: dayContextKey(date, today),
    forceRefresh,
    fetcher: () => api(centralCalendarUrl(date, date, today, { includeAthletes: true })),
    applyData: (data) => {
      if (!current()) return;
      const item = findCentralCalendarItem(data, key);
      panel.loading = false;
      if (!item) {
        panel.error = "changed";
        panel.athletes = null;
      } else {
        panel.athletes = Array.isArray(item.athletes) ? item.athletes : [];
      }
      render?.();
    },
    applyError: () => {
      if (!current()) return;
      panel.loading = false;
      panel.error = "failed";
      render?.();
    },
    getCurrentContextKey: () => {
      const open = state.centralCalendar.panel;
      return open.open ? dayContextKey(open.date, localDateIso()) : "";
    },
  });
}

// The athlete's *Upcoming events* on Home (K2b-1e, docs/ai/central-calendar-k2b-plan.md section 22, D28): her own events
// of the next 14 days. One read of the K1a calendar API in her athlete workspace - GET /api/calendar with kinds=event -
// whose event card is already reduced for her (D21, T7: the place only, never a detail, a value, notes, a teammate or a
// type id; backend/src/calendarQuery.js publicCard). Nothing here writes.
//
// What reaches the screen is an explicit pick of that card (athleteHomeEventRows): a field the server might add to the
// card later never reaches the list. The read goes through view-cache.js with a context key of account + workspace +
// her local date (the range follows from the date, and a tab left open past midnight reads again). A late answer never
// paints a stale list: loadCachedView drops an answer of another account or workspace, and the generation below drops
// an answer that started before a reset (a workspace switch) or before a newer read.
import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { emptyAthleteHomeEventsState, state } from "./state.js";
import { addDaysIso, localDateIso } from "./utils.js";
import { buildContextKey, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

export const ATHLETE_HOME_EVENTS_NAMESPACE = "athlete-home-events";
// D28: today and the 13 days after it.
export const ATHLETE_HOME_EVENTS_DAYS = 14;
// The rows shown before *Show N more* (the manager's Q5).
export const ATHLETE_HOME_EVENTS_LIMIT = 5;
// The keys of a row: the pick, and nothing else.
export const ATHLETE_HOME_EVENT_ROW_KEYS = Object.freeze(["eventId", "title", "eventKind", "eventTypeLabel", "day", "from", "to", "startTime", "endTime", "place", "cancelled"]);

const g = () => state.athleteHomeEvents;
let generation = 0;

export function athleteHomeEventsRange(today) {
  return { from: today, to: addDaysIso(today, ATHLETE_HOME_EVENTS_DAYS - 1) };
}

export function athleteHomeEventsContextKey(today) {
  return buildContextKey([...currentUserWorkspaceContextParts(), today]);
}

export function athleteHomeEventsUrl(today) {
  const { from, to } = athleteHomeEventsRange(today);
  return `/api/calendar?${new URLSearchParams({ from, to, today, kinds: "event" }).toString()}`;
}

const text = (value) => (typeof value === "string" && value.trim() ? value : null);
const isoDay = (value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);

// The place as the list shows it: a library place's name, address and note, or a one-off text. Its id is not kept.
function pickPlace(place, location) {
  if (place && typeof place === "object") {
    if (place.source === "library") {
      const picked = { source: "library", name: text(place.name), address: text(place.address), note: text(place.note) };
      // Nothing to show: no empty place line.
      return picked.name || picked.address || picked.note ? picked : null;
    }
    if (place.source === "one_off") return text(place.text) ? { source: "one_off", text: place.text } : null;
    return null;
  }
  return text(location) ? { source: "one_off", text: location } : null;
}

// One row per event, at its first day in the answer (the answer has one card per day of a multi-day event), in the
// order: that day, then the events with a start time by the time, then those without (the calendar's own day list puts
// them last, under "No time"), then the title.
export function athleteHomeEventRows(answer) {
  const rows = new Map();
  for (const day of Array.isArray(answer?.days) ? answer.days : []) {
    for (const item of Array.isArray(day?.items) ? day.items : []) {
      if (item?.kind !== "event") continue;
      const eventId = item.links?.eventId;
      if (!eventId || rows.has(String(eventId))) continue;
      const date = isoDay(item.date) || isoDay(day.date);
      if (!date) continue;
      const from = isoDay(item.span?.from) || date;
      const to = isoDay(item.span?.to) || from;
      rows.set(String(eventId), {
        eventId: String(eventId),
        title: text(item.title),
        eventKind: text(item.eventKind),
        eventTypeLabel: text(item.eventTypeLabel),
        day: date,
        from,
        to: to < from ? from : to,
        startTime: text(item.startTime),
        endTime: text(item.endTime),
        place: pickPlace(item.place, item.location),
        cancelled: item.cancelled === true,
      });
    }
  }
  return [...rows.values()].sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    if (Boolean(a.startTime) !== Boolean(b.startTime)) return a.startTime ? -1 : 1;
    if (a.startTime && b.startTime && a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1;
    const byTitle = String(a.title || "").localeCompare(String(b.title || ""));
    return byTitle || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
  });
}

// A workspace switch (app.js onWorkspaceChanged): nothing of the old workspace's list stays, and an answer on its way
// is dropped.
export function resetAthleteHomeEvents() {
  generation += 1;
  invalidateCacheNamespace(ATHLETE_HOME_EVENTS_NAMESPACE);
  state.athleteHomeEvents = emptyAthleteHomeEventsState();
}

// Home's read (and Try again). `render` paints Home again; it paints only while Home is on screen.
export async function loadAthleteHomeEvents({ render, forceRefresh = false, today = localDateIso() } = {}) {
  const run = ++generation;
  const contextKey = athleteHomeEventsContextKey(today);
  const current = () => run === generation;
  // Another date, account or workspace: the list read for the earlier one is not shown meanwhile.
  if (g().contextKey !== contextKey) state.athleteHomeEvents = { ...emptyAthleteHomeEventsState(), contextKey, today };
  // Every entry into Home starts with the first rows.
  g().expanded = false;
  await loadCachedView({
    namespace: ATHLETE_HOME_EVENTS_NAMESPACE,
    contextKey,
    forceRefresh,
    fetcher: () => api(athleteHomeEventsUrl(today)),
    showLoading: () => {
      if (!current()) return;
      // A 403 for this same context stays hidden while it is asked again: the section never flashes up (code review).
      if (g().status === "hidden" && g().contextKey === contextKey) return;
      Object.assign(g(), { status: "loading", error: "", canRetry: true });
      render?.();
    },
    applyData: (data) => {
      if (!current()) return;
      Object.assign(g(), { status: "ready", rows: athleteHomeEventRows(data), today, contextKey, error: "", canRetry: true });
      render?.();
    },
    applyError: (error) => {
      if (!current()) return;
      // 403: no athlete profile or no workspace - nothing she can do here, so the section is not shown. A lost sign-in
      // (401) is said without Try again (K2b-1d's D11).
      if (error?.status === 403) Object.assign(g(), { status: "hidden", rows: [], error: "" });
      else if (error?.status === 401) Object.assign(g(), { status: "error", rows: [], error: "Sign in again to see your events.", canRetry: false });
      else Object.assign(g(), { status: "error", rows: [], error: "Events could not be loaded.", canRetry: true });
      render?.();
    },
    // The account and workspace the read was made for; the date is the one captured above, so an answer that lands
    // just after midnight still shows (the next entry into Home reads the new day).
    getCurrentContextKey: () => athleteHomeEventsContextKey(today),
  });
}

// *Show N more* / *Show fewer*: the rows already read, no request.
export function toggleAthleteHomeEvents() {
  g().expanded = !g().expanded;
  return g().expanded;
}

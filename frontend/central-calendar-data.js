import { CC_QUESTION_SETTLED_CODES } from "./central-calendar-questions.js";
import { api } from "./api.js";
import { clearGpsReview } from "./central-calendar-gps-review.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { emptyCentralCalendarState, state } from "./state.js";
import { addDaysIso, localDateIso, monthWeeksIso, weekMondayIso } from "./utils.js";
import { buildContextKey, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

// Central calendar (K1b) - the reads of GET /api/calendar, the K1a read API
// (docs/ai/central-calendar-k1-plan.md). One request per visible range,
// never a filter parameter (the chips filter the answer in memory, plan
// decision A) - except one chosen athlete (K6, central-calendar-k6-contract.md
// 2.5: `athleteIds`, a read of its own whose cards are hers, so the numbers on
// them are her own) and `kinds` while only non-event kinds are chosen (FE-D16,
// a second read, below) - and one extra read of a single day with include=athletes
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

// The kinds in the Types chips' order: events first (K2a-2), then K1's four.
export const CENTRAL_CALENDAR_KINDS = Object.freeze(["event", "planned", "activity", "external", "test"]);
// K5-2 *Show only* (central-calendar-k5-12-contract.md 2.5): one client kind at a time, in the pills' order. The
// server's `activity` splits into GPS imports (`gps`) and Other activities (`other_activity`).
export const CENTRAL_CALENDAR_SHOW_ONLY = Object.freeze(["event", "planned", "gps", "other_activity", "external", "test"]);
export const CENTRAL_CALENDAR_VIEWS = Object.freeze(["month", "week", "day"]);
// An event's kind (D2, the seeded types' base kinds; K2a plan section 6).
export const CENTRAL_CALENDAR_EVENT_KINDS = Object.freeze(["training", "match", "test", "travel", "meeting", "day_off", "camp"]);
// What an event may expect (D19), in the server's order.
export const CENTRAL_CALENDAR_EVENT_EXPECTS = Object.freeze(["rpe", "device_data", "test_result"]);

// A team's name as the calendar shows it (K2b-1d2, plan section 23, the
// manager's Q1): with its club when the team carries one - the platform
// workspace's teams, where teams of several clubs meet - as "U19 · Borac";
// otherwise its name, as before. One helper for the team's name on cards and
// in the panel, the Groups chips, the legend and the form's names.
export function centralCalendarTeamLabel(team) {
  const name = team?.name || "Team";
  return team?.clubName ? `${name} · ${team.clubName}` : name;
}

let rangeGeneration = 0;
let kindsGeneration = 0;
let dayGeneration = 0;
let athleteGeneration = 0;
let organizationGeneration = 0;

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

// FE-D16 (central-calendar-k2b2-plan.md 9.4): a read with `kinds` has its own key; the unfiltered read keeps its key.
// K6 (central-calendar-k6-contract.md 2.5): a read of one athlete adds `athlete:<uuid>`, the same way.
export function centralCalendarContextKey(from, to, today, kinds = "", athleteId = "") {
  return buildContextKey([...currentUserWorkspaceContextParts(), from, to, today, ...(kinds ? ["kinds", kinds] : []), ...(athleteId ? ["athlete", athleteId] : [])]);
}

function dayContextKey(date, today, kinds = "", athleteId = "") {
  return buildContextKey([...currentUserWorkspaceContextParts(), date, today, ...(kinds ? ["kinds", kinds] : []), ...(athleteId ? ["athlete", athleteId] : [])]);
}

// K6: `athleteIds` alone narrows the answer to one athlete. It never goes with `clubIds` or `teamIds`: the server's
// filter is a union inside the scope (calendarAthleteFilterSql), so a team sent with the athlete would widen it.
export function centralCalendarUrl(from, to, today, { includeAthletes = false, kinds = "", athleteIds = "" } = {}) {
  const params = new URLSearchParams({ from, to, today });
  if (kinds) params.set("kinds", kinds);
  if (athleteIds) params.set("athleteIds", athleteIds);
  if (includeAthletes) params.set("include", "athletes");
  return `/api/calendar?${params.toString()}`;
}

// K6 (contract 2.5): the athlete the calendar shows, or "". Only an athlete of the rail roster (state.athletes, the
// server's roster scope) is ever chosen: a remembered id that left the roster, and any choice in the platform
// workspace (no roster there, Q2), count as Everyone, so a stale id is never sent.
export function centralCalendarChosenAthlete(cal) {
  const id = String(cal?.k6?.athleteId || "");
  if (!id || cal?.data?.workspace?.type === "platform") return "";
  return (state.athletes || []).some((athlete) => String(athlete?.athlete_uuid || "") === id) ? id : "";
}

// The filters the cards are drawn with: while an athlete is chosen the Groups choice scopes only the strip (Q3), so a
// club-wide event of hers is never hidden.
export function centralCalendarCardFilters(cal) {
  return centralCalendarChosenAthlete(cal) ? { ...cal.filters, teamIds: [] } : cal?.filters;
}

// FE-D16 (central-calendar-k2b2-plan.md 9.4): without `event` in `kinds` the server folds nothing into an event,
// so while *Show only* is a kind other than Events (no event type either), the cards come from a read of that kind:
// with "RPE requests" an RPE request an event folds is its own card again. "" otherwise: the cards are the unfiltered
// answer's, filtered in the browser (decision A). K5-2 (contract 2.5): GPS imports reads unfiltered (it needs the
// event, planned and RPE cards that hold an import), Other activities reads `kinds=activity` and leaves the imports
// out in the browser.
const SHOW_ONLY_SERVER_KINDS = Object.freeze({ planned: "planned", other_activity: "activity", external: "external", test: "test" });
export function centralCalendarServerKinds(filters) {
  const only = (filters?.kinds || [])[0] || "";
  if (!only || (filters?.eventKinds || []).length) return "";
  return SHOW_ONLY_SERVER_KINDS[only] || "";
}

// The answer the cards and the open panel are drawn from: the kinds read while it is the one asked for and covers
// the range on screen, else the unfiltered answer (which also carries the teams, the workspace, the events of the
// link suggestions and the chips' counts).
// K6 (contract 2.5): while an athlete is chosen, the most specific athlete read that covers the range (kinds +
// athlete, else athlete), and never the unfiltered answer: null while it loads or failed, so the grid shows the
// calendar's loading or error state, never everyone's cards under "Showing …".
export function centralCalendarShownSource(cal) {
  const kinds = centralCalendarServerKinds(cal?.filters);
  const inRange = (answer) => Boolean(answer && cal.data && answer.data?.from === cal.data.from && answer.data?.to === cal.data.to);
  const athleteId = centralCalendarChosenAthlete(cal);
  if (athleteId) {
    const answers = cal.k6?.answers || {};
    if (inRange(answers[`${athleteId}|${kinds}`])) return { data: answers[`${athleteId}|${kinds}`].data, kinds, athleteId };
    if (kinds && inRange(answers[`${athleteId}|`])) return { data: answers[`${athleteId}|`].data, kinds: "", athleteId };
    return { data: null, kinds, athleteId };
  }
  const answer = cal?.kindsAnswer;
  if (kinds && answer && answer.kinds === kinds && inRange(answer)) return { data: answer.data, kinds, athleteId: "" };
  return { data: cal?.data || null, kinds: "", athleteId: "" };
}

export function centralCalendarShownData(cal) {
  return centralCalendarShownSource(cal).data;
}

// A plan saved or deleted in the Builder changes the planned cards of its
// days (builder-actions.js calls this at its two exits, as it does for the
// weekly plan and Coach Home); a workspace switch clears everything.
export function invalidateCentralCalendarCache() {
  invalidateCacheNamespace(CENTRAL_CALENDAR_NAMESPACE);
  invalidateCacheNamespace(CENTRAL_CALENDAR_DAY_NAMESPACE);
  // K5-4: the GPS marks are read again with the calendar (a realtime or manual refresh).
  clearGpsReview();
}

// Settings -> Calendar changed the club's catalog (K2b-1c): the calendar is
// read again, and so are the event form's types (GET /events/types) at the
// next New event or Edit. An open event form keeps the list it was made from
// (its fields read it) until it closes.
export function centralCalendarCatalogChanged() {
  invalidateCentralCalendarCache();
  const cal = state.centralCalendar;
  catalogGeneration += 1;
  if (!cal) return;
  if (cal.form) cal.eventTypesStale = true;
  else {
    cal.eventTypes = null;
    cal.eventCatalog = null;
  }
}

// K2b-1d (the independent review, K1): the actions module's check of the open
// panel's details, run after every calendar answer applied, whoever read it
// (a save, Try again, a refresh): a panel whose card now has details reads
// them, one whose event changed reads them again.
let calendarAppliedHook = null;
export function setCentralCalendarAppliedHook(hook) {
  calendarAppliedHook = typeof hook === "function" ? hook : null;
}

export function resetCentralCalendarForWorkspaceChange() {
  state.centralCalendar = emptyCentralCalendarState();
  clearGpsReview();
  rangeGeneration += 1;
  kindsGeneration += 1;
  dayGeneration += 1;
  // K6: the chosen athlete and team, the search, the organization pairs and every athlete answer go with the state;
  // a read of the workspace left is dropped by its generation.
  athleteGeneration += 1;
  organizationGeneration += 1;
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
// The open item is no longer on its day in the answer the cards come from (a plan deleted elsewhere, a session
// superseded or moved): the panel closes with one quiet line instead of vanishing behind an empty panel column. The
// same lookup the view makes (the panel's day), so the two agree.
function closePanelMissingFrom(cal, data) {
  if (cal.panel.open && !(data.days || []).find((day) => day.date === cal.panel.date)?.items?.some((item) => item.key === cal.panel.key)) {
    cal.panel = { open: false, key: "", date: "", athletes: null, loading: false, error: "" };
    cal.notice = "The item you had open is no longer on this day; the calendar is up to date.";
  }
}

export async function loadCentralCalendar({ render, forceRefresh = false } = {}) {
  const result = await loadCentralCalendarRange({ render, forceRefresh });
  const cal = state.centralCalendar;
  // K6: the cards of a chosen athlete come from her own read (which carries the kinds), so the kinds read of
  // everyone is not needed for them. A remembered athlete no longer in the roster is dropped first.
  if (cal?.data) dropStaleCentralCalendarAthlete(cal);
  if (cal?.data && centralCalendarChosenAthlete(cal)) await loadCentralCalendarAthlete({ render, forceRefresh });
  else if (cal?.data && centralCalendarServerKinds(cal.filters)) await loadCentralCalendarKinds({ render, forceRefresh });
  if (cal?.data) void loadCentralCalendarOrganization({ render });
  return result;
}

// K6 (contract 2.5, F2): the remembered choice is checked against the current roster (and the team against the
// answer's teams) before the first read that would use it; what is no longer there is dropped, so Everyone is used.
export function dropStaleCentralCalendarAthlete(cal) {
  const k6 = cal?.k6;
  if (!k6) return;
  if (k6.athleteId && !centralCalendarChosenAthlete(cal)) k6.athleteId = "";
  const teamIds = new Set((cal.data?.teams || []).map((team) => String(team.teamId)));
  if ((cal.filters?.teamIds || []).some((id) => !teamIds.has(String(id)))) cal.filters.teamIds = cal.filters.teamIds.filter((id) => teamIds.has(String(id)));
}

export function emptyCentralCalendarK6State() {
  return { athleteId: "", search: "", searchIndex: -1, boxOpen: false, answers: {}, athleteLoading: false, athleteError: "", organization: { status: "idle", pairs: [] } };
}

export function centralCalendarK6(cal) {
  if (!cal.k6) cal.k6 = emptyCentralCalendarK6State();
  return cal.k6;
}

// K6 (contract 2.5): the read of one athlete for the range on screen, with the kinds while *Show only* asks for them.
export async function loadCentralCalendarAthlete({ render, forceRefresh = false } = {}, { retried = false } = {}) {
  const cal = state.centralCalendar;
  const athleteId = centralCalendarChosenAthlete(cal);
  if (!athleteId || !cal.data) return null;
  const k6 = centralCalendarK6(cal);
  const kinds = centralCalendarServerKinds(cal.filters);
  const today = localDateIso();
  const range = centralCalendarRange(cal.view, cal.anchor);
  const generation = ++athleteGeneration;
  const contextKey = centralCalendarContextKey(range.from, range.to, today, kinds, athleteId);
  const current = () => generation === athleteGeneration && state.centralCalendar === cal && centralCalendarChosenAthlete(cal) === athleteId;
  k6.athleteError = "";
  const result = await loadCachedView({
    namespace: CENTRAL_CALENDAR_NAMESPACE,
    contextKey,
    forceRefresh,
    fetcher: () => api(centralCalendarUrl(range.from, range.to, today, { kinds, athleteIds: athleteId })),
    showLoading: () => {
      if (!current()) return;
      k6.athleteLoading = true;
      render?.();
    },
    applyData: (data) => {
      if (!current()) return;
      k6.answers[`${athleteId}|${kinds}`] = { data };
      k6.athleteLoading = false;
      k6.athleteError = "";
      closePanelMissingFrom(cal, data);
      render?.();
    },
    applyError: (error) => {
      if (!current()) return;
      k6.athleteLoading = false;
      const described = describeCentralCalendarError(error);
      // Her cards already on screen (a refresh of the same range): one note. Nothing of hers yet: the error state.
      if (centralCalendarShownData(cal)) cal.refreshError = `${described.message} Showing the last loaded calendar.`;
      else k6.athleteError = described.message;
      render?.();
    },
    getCurrentContextKey: () => {
      const now = state.centralCalendar;
      const nowAthlete = centralCalendarChosenAthlete(now);
      if (!nowAthlete) return "";
      const nowRange = centralCalendarRange(now.view, now.anchor);
      return centralCalendarContextKey(nowRange.from, nowRange.to, localDateIso(), centralCalendarServerKinds(now.filters), nowAthlete);
    },
  });
  if (!current()) return result;
  if ((result?.outcome === "invalidated-stale" || result?.outcome === "stale-ignored") && !retried) return loadCentralCalendarAthlete({ render, forceRefresh }, { retried: true });
  if (result?.outcome === "background-refresh-failed") {
    cal.refreshError = "Could not refresh. Showing the last loaded calendar.";
    render?.();
  }
  if (k6.athleteLoading && result?.outcome === "stale-ignored") {
    k6.athleteLoading = false;
    render?.();
  }
  return result;
}

// K6 (contract 2.3): who is in which of the workspace's teams, for a club admin's grouping only. GET /api/organization
// (already read in this workspace by Training Load's filter, the Tests picker and the Builder's picker) is reduced on
// arrival to { athleteUuid, teamId } pairs: an active team membership, a team of the calendar answer's teams, an
// athlete of the roster. Nothing else of the answer is kept anywhere. Read once per workspace, in a club only.
export function reduceCentralCalendarOrganization(answer, { teamIds, rosterUuids }) {
  const pairs = [];
  const seen = new Set();
  for (const athlete of Array.isArray(answer?.athletes) ? answer.athletes : []) {
    const athleteUuid = String(athlete?.id || "");
    if (!athleteUuid || !rosterUuids.has(athleteUuid)) continue;
    for (const membership of Array.isArray(athlete?.memberships) ? athlete.memberships : []) {
      const teamId = String(membership?.teamId || "");
      if (membership?.membershipType !== "team" || membership?.status !== "active" || !teamIds.has(teamId)) continue;
      const key = `${athleteUuid}|${teamId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ athleteUuid, teamId });
    }
  }
  return pairs;
}

export async function loadCentralCalendarOrganization({ render, force = false } = {}) {
  const cal = state.centralCalendar;
  if (cal?.data?.workspace?.type !== "club") return;
  // Nothing to group without a roster (it may still be loading): read once there is one.
  if (!(state.athletes || []).some((athlete) => athlete?.athlete_uuid)) return;
  const k6 = centralCalendarK6(cal);
  const org = k6.organization;
  if (!force && (org.status === "ready" || org.status === "loading")) return;
  const generation = ++organizationGeneration;
  const current = () => generation === organizationGeneration && state.centralCalendar === cal;
  k6.organization = { status: "loading", pairs: [] };
  try {
    const answer = await api("/api/organization");
    if (!current()) return;
    const teamIds = new Set((cal.data?.teams || []).map((team) => String(team.teamId)));
    const rosterUuids = new Set((state.athletes || []).map((athlete) => String(athlete?.athlete_uuid || "")).filter(Boolean));
    k6.organization = { status: "ready", pairs: reduceCentralCalendarOrganization(answer, { teamIds, rosterUuids }) };
  } catch {
    if (!current()) return;
    k6.organization = { status: "failed", pairs: [] };
  }
  render?.();
}

// FE-D16: the read of the chosen kinds for the range on screen (after the unfiltered one), under its own key.
// `closeMissing`: a refresh closes a panel whose item is gone, with its notice; a change of the types does not (its
// caller closes the panel of a card the types hide, quietly).
export async function loadCentralCalendarKinds({ render, forceRefresh = false, closeMissing = true } = {}, { retried = false } = {}) {
  const cal = state.centralCalendar;
  const kinds = centralCalendarServerKinds(cal.filters);
  if (!kinds || !cal.data) return null;
  const today = localDateIso();
  const range = centralCalendarRange(cal.view, cal.anchor);
  const generation = ++kindsGeneration;
  const contextKey = centralCalendarContextKey(range.from, range.to, today, kinds);
  const current = () => generation === kindsGeneration && state.centralCalendar === cal;
  const result = await loadCachedView({
    namespace: CENTRAL_CALENDAR_NAMESPACE,
    contextKey,
    forceRefresh,
    fetcher: () => api(centralCalendarUrl(range.from, range.to, today, { kinds })),
    applyData: (data) => {
      if (!current()) return;
      cal.kindsAnswer = { kinds, data };
      if (closeMissing) closePanelMissingFrom(cal, data);
      render?.();
    },
    applyError: (error) => {
      if (!current()) return;
      // The cards stay the unfiltered answer's, filtered in the browser.
      cal.refreshError = `${describeCentralCalendarError(error).message} Showing the last loaded calendar.`;
      render?.();
    },
    getCurrentContextKey: () => {
      const now = state.centralCalendar;
      const nowKinds = centralCalendarServerKinds(now.filters);
      if (!nowKinds) return "";
      const nowRange = centralCalendarRange(now.view, now.anchor);
      return centralCalendarContextKey(nowRange.from, nowRange.to, localDateIso(), nowKinds);
    },
  });
  if (!current()) return result;
  // The range read's outcomes, the same way: an answer made void by an invalidation is read once more; a failed
  // refresh over cards on screen says so.
  if (result?.outcome === "invalidated-stale" && !retried) return loadCentralCalendarKinds({ render, forceRefresh, closeMissing }, { retried: true });
  if (result?.outcome === "background-refresh-failed") {
    cal.refreshError = "Could not refresh. Showing the last loaded calendar.";
    render?.();
  }
  return result;
}

async function loadCentralCalendarRange({ render, forceRefresh = false } = {}, { retried = false } = {}) {
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
      // While the cards come from the kinds read, that read decides (an RPE request it shows may be folded here).
      if (!centralCalendarServerKinds(cal.filters)) closePanelMissingFrom(cal, data);
      render?.();
      // K2b-1d3: the cards wear their type's look from the card itself; the
      // catalog is read only when the event form opens (the actions' ensureEventTypes).
      void calendarAppliedHook?.(cal, render);
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
  if (result?.outcome === "invalidated-stale" && !retried) return loadCentralCalendarRange({ render, forceRefresh }, { retried: true });
  // The same generation and a context key that moved on: only the browser's
  // date rolled over while the answer was in flight. Read once more with the
  // new `today` instead of leaving "Loading calendar…" on screen.
  if (result?.outcome === "stale-ignored" && !retried) return loadCentralCalendarRange({ render, forceRefresh }, { retried: true });
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

// ---------------------------------------------------------------------------
// Events (K2a-2, docs/ai/central-calendar-k2a-2-plan.md section 4) over the
// K2a-1a routes /api/calendar/events. The reads are plain; every write
// carries a requestKey made when it is sent, so a lost answer is checked by
// sending the very same request again (the server replays it, never saves
// twice).
// ---------------------------------------------------------------------------
const EVENTS_BASE = "/api/calendar/events";
// A write still open after this bound is a lost answer, never a refusal: the
// server's own worst case (the pool checkout, a 15 s lock wait, the bounded
// COMMIT of 15 s and its 5 s check) is well under it.
export const CENTRAL_CALENDAR_WRITE_BOUND_MS = 90_000;

export function newCentralCalendarRequestKey() {
  return globalThis.crypto.randomUUID();
}

function eventWrite(path, method, body) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(CENTRAL_CALENDAR_WRITE_BOUND_MS) : undefined;
  return api(path, { method, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}

const eventPath = (eventId) => `${EVENTS_BASE}/${encodeURIComponent(eventId)}`;
export const fetchCentralCalendarEventTypes = () => api(`${EVENTS_BASE}/types`);
export const fetchCentralCalendarEvent = (eventId) => api(eventPath(eventId));
export const createCentralCalendarEvent = (body) => eventWrite(EVENTS_BASE, "POST", body);
export const updateCentralCalendarEvent = (eventId, body) => eventWrite(eventPath(eventId), "PATCH", body);
export const cancelCentralCalendarEvent = (eventId, body) => eventWrite(`${eventPath(eventId)}/cancel`, "POST", body);
// K2b-1b's values command: { requestKey, expectedRevision, values: [{ fieldId, value }] }.
export const setCentralCalendarEventFields = (eventId, body) => eventWrite(`${eventPath(eventId)}/fields`, "POST", body);
// K2c-1: a link command of an event (central-calendar-links.js builds the
// path and the body: /sessions, /sessions/detach, /sessions/align,
// /activities, /activities/detach), sent again unchanged by Check result.
export const sendCentralCalendarLinkWrite = (path, body) => eventWrite(path, "POST", body);
// K2b-2a-2b: an event's questions. The read is for a manager while the club's
// switch is on (the identical 404 otherwise); the three writes take
// { requestKey, expectedRevision, ... } and are sent again unchanged by Check
// result.
export const fetchCentralCalendarEventQuestions = (eventId) => api(`${eventPath(eventId)}/questions`);
// The event panel package (Q7): the values of a manager's panel, read on every
// open and never cached (an athlete may change her answer while the coach looks).
export const fetchCentralCalendarAnswers = (path) => api(path);
export const centralCalendarQuestionPath = (eventId, questionId = "", tail = "") => `${eventPath(eventId)}/questions${questionId ? `/${encodeURIComponent(questionId)}` : ""}${tail ? `/${tail}` : ""}`;
export const sendCentralCalendarQuestionWrite = (path, body) => eventWrite(path, "POST", body);

// The workspace's event catalog (GET /events/types, K2b-1a): the types for
// the form and the cards, and - additively - the details, the club's places
// and the teams' default places for the form. Read once per workspace; a
// Settings -> Calendar write drops it (centralCalendarCatalogChanged). The
// cards and a form opened at the same time share one read; an answer that a
// Settings write overtook is not stored.
let catalogGeneration = 0;
let catalogRead = null;

export function readCentralCalendarCatalog(cal) {
  if (cal.eventTypes) return Promise.resolve({ types: cal.eventTypes });
  if (catalogRead && catalogRead.cal === cal && catalogRead.generation === catalogGeneration) return catalogRead.promise;
  const read = { cal, generation: catalogGeneration, promise: null };
  read.promise = readCatalogOnce(cal, read.generation).finally(() => {
    if (catalogRead === read) catalogRead = null;
  });
  catalogRead = read;
  return read.promise;
}

async function readCatalogOnce(cal, generation) {
  try {
    const data = await fetchCentralCalendarEventTypes();
    // A Settings -> Calendar write landed meanwhile: this answer may be the
    // old catalog, so the read is made again.
    if (state.centralCalendar === cal && generation !== catalogGeneration && !cal.eventTypes) return readCentralCalendarCatalog(cal);
    const types = Array.isArray(data?.types) ? data.types : [];
    if (state.centralCalendar === cal && generation === catalogGeneration) {
      cal.eventTypes = types;
      cal.eventCatalog = {
        fields: Array.isArray(data?.fields) ? data.fields : [],
        locations: Array.isArray(data?.locations) ? data.locations : [],
        teamDefaults: data?.teamDefaults && typeof data.teamDefaults === "object" ? data.teamDefaults : {},
        // K2b-2a-2b (B1): the owner club's Ask athletes switch (false without
        // a club, the platform, or a server without it).
        questionsEnabled: data?.questions?.enabled === true,
      };
      cal.eventTypesStale = false;
    }
    return { types };
  } catch (error) {
    return { error: centralCalendarErrorInfo(error) };
  }
}

export function centralCalendarErrorInfo(error) {
  const data = error?.data && typeof error.data === "object" ? error.data : null;
  const status = Number(error?.status) || 0;
  return {
    status,
    // No answer (the network, the client bound) is its own code: the screen
    // never says a write failed when it cannot know.
    code: typeof data?.error === "string" ? data.error : status ? "error" : "no_answer",
    message: typeof data?.message === "string" ? data.message : "",
    current: data?.current || null,
    // K2b-1b's invalid_value names the detail it refused.
    fieldId: typeof data?.fieldId === "string" ? data.fieldId : "",
    // K2c-1: the alignment's has_existing_results counts the answers given.
    resultCount: Number.isInteger(data?.resultCount) ? data.resultCount : null,
  };
}

// The answers that say nothing about whether a write landed: no answer, the
// service's own 503 outcome_unknown, and any other 5xx it did not write itself
// (a proxy, a restart, a body that is not JSON). `internal_error` (a certain
// rollback) and the busy pool's `try_again` are stated refusals.
export function centralCalendarOutcomeUnknown(info) {
  if (info.code === "no_answer" || info.code === "outcome_unknown") return true;
  return info.status >= 500 && info.code !== "internal_error" && info.code !== "try_again";
}

// Check result sends the same request again. Only these answers settle what
// happened to the first one: the server gives them after its request record
// showed that nothing was saved under the key (calendarEventService.js: the
// replay check precedes every check of the command), or for the body itself,
// which is the same as the first time. Every other answer (busy, no access,
// signed out, a server error) comes before that record is read, so the first
// write stays not confirmed.
const SETTLED_ON_CHECK = new Set([
  "event_changed", "event_cancelled", "type_not_available", "target_not_available", "schedule_not_available",
  "schedule_kind_mismatch", "schedule_already_referenced", "nothing_to_change",
  "invalid_type", "invalid_title", "invalid_day", "invalid_time", "invalid_timezone", "invalid_location", "invalid_expects",
  "invalid_notes", "invalid_targets", "invalid_reason", "invalid_revision", "invalid_schedule",
  // K2b-1b: the place, the details and the values command.
  "invalid_request_key", "invalid_fields", "location_not_available", "field_not_available", "invalid_values", "invalid_value",
  // K2b-2a-2b: the questions of an event (the event's runner reads its
  // request record before these).
  ...CC_QUESTION_SETTLED_CODES,
]);
export const centralCalendarCheckSettles = (info) => info.status >= 400 && info.status < 500 && SETTLED_ON_CHECK.has(info.code);

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
  // The day is read the way its cards were (FE-D16): a card only the kinds read shows is found there. K6: with the
  // chosen athlete too (Q5), unless the panel's *Show everyone* asked for the item without her.
  const source = centralCalendarShownSource(cal);
  const kinds = source.kinds;
  const athleteIds = panel.everyone ? "" : source.athleteId;
  const generation = ++dayGeneration;
  panel.loading = true;
  panel.error = "";
  panel.athletes = null;
  render?.();
  const current = () => generation === dayGeneration && state.centralCalendar === cal && cal.panel.open && cal.panel.key === key;
  await loadCachedView({
    namespace: CENTRAL_CALENDAR_DAY_NAMESPACE,
    contextKey: dayContextKey(date, today, kinds, athleteIds),
    forceRefresh,
    fetcher: () => api(centralCalendarUrl(date, date, today, { includeAthletes: true, kinds, athleteIds })),
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
      return open.open ? dayContextKey(open.date, localDateIso(), kinds, athleteIds) : "";
    },
  });
}

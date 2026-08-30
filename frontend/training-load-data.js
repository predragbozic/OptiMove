import { api } from "./api.js";
import { state } from "./state.js";
import { localDateIsoInTimeZone, weekMondayIso } from "./utils.js";

// Training load (RPE/sRPE), first complete phase. Deliberately its own
// data module, never importing from tests-data.js/tests-actions.js - this
// reuses the SAME date-math/weekly-navigator BEHAVIOR Tests already
// established (request-generation-token race guard, "seed weekStart/
// selectedDate to today only on first visit"), not its state or code.

// Item 2 correction's own request-race guard, mirrored exactly: a rapid
// double Next-week click, a rapid filter change, or a workspace switch,
// must never let an OLDER/slower response overwrite a NEWER one already
// applied. "athlete" is a fourth, independent key for the athlete's own
// single weekly nav (see loadTrainingLoadAthleteWeekly below) - entirely
// separate from the coach's three tabs, never sharing a counter with them.
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

async function loadTrainingLoadWeeklyInto(nav, generationKey, extraQuery) {
  if (!nav.weekStart) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const today = localDateIsoInTimeZone(timezone);
    nav.weekStart = weekMondayIso(today);
    nav.selectedDate = today;
  }
  const generation = ++weeklyRequestGeneration[generationKey];
  nav.loading = true;
  nav.error = "";
  try {
    const query = `?weekStart=${encodeURIComponent(nav.weekStart)}${extraQuery}`;
    const data = await api(`/api/training-load/weekly${query}`);
    if (generation !== weeklyRequestGeneration[generationKey]) return; // stale - a newer request (a nav change, a filter confirm, or a workspace switch) already started, drop this response entirely
    nav.data = data;
    nav.selectedDate = clampSelectedDateToWeek(nav.selectedDate, data);
    nav.loading = false;
  } catch (error) {
    if (generation !== weeklyRequestGeneration[generationKey]) return;
    nav.error = error.message || "Could not load the training load calendar.";
    nav.loading = false;
  }
}

// Coach Today/Schedule/Results tabs - each keeps its own independent week/
// date, same as tests.weekly, scoped/filtered by state.trainingLoad.filter
// + the caller's current workspace (see trainingLoad.js's own coach-side
// scoping).
export async function loadTrainingLoadWeekly(section) {
  return loadTrainingLoadWeeklyInto(state.trainingLoad.weekly[section], section, trainingLoadFilterQuery());
}

// The athlete's own weekly training-load overlay (item 4 correction) -
// GET /api/training-load/weekly self-scopes automatically for an athlete
// caller (see trainingLoad.js), so no filter query is ever sent here.
export async function loadTrainingLoadAthleteWeekly() {
  return loadTrainingLoadWeeklyInto(state.trainingLoad.athleteWeekly, "athlete", "");
}

// Correction: called on a workspace switch, BEFORE any new fetch is
// necessarily issued (Training load might not even be the active tab
// right now) - bumping every generation counter guarantees an already-
// in-flight request for the OLD workspace can never land and overwrite
// state after the switch, even if nothing re-fetches immediately.
export function invalidateAllTrainingLoadWeeklyGenerations() {
  for (const key of Object.keys(weeklyRequestGeneration)) weeklyRequestGeneration[key] += 1;
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

// "My training" (owner, 2026-11-16): the athlete's own recorded sessions and values, read-only. Three reads of the
// athlete-results routes (PR #578): whether she has any recorded session, her sessions of the last year, and one
// session with her values. Nothing here writes.
import { api } from "./api.js";
import { state } from "./state.js";
import { addDaysIso, localDateIso } from "./utils.js";

export const MY_TRAINING_PAGE = 30;
// The list route takes at most 366 days at a time: the last year, newest first.
const LIST_DAYS = 365;

const g = () => state.myTraining;
let listGeneration = 0;
let detailGeneration = 0;
let availabilityGeneration = 0;

// The entry's one rule: the server says whether she has a recorded session (owner: hidden for an athlete with none).
// Never guessed on the client: every real answer is followed, a "no" after a "yes" included (an imported session can be
// deleted); a failed read changes nothing.
export async function loadMyTrainingAvailability() {
  const generation = ++availabilityGeneration;
  try {
    const { hasRecordedSessions } = await api("/api/training-activity/self");
    // An answer for a workspace that was left meanwhile is not this one's (code review).
    if (generation !== availabilityGeneration) return g().available;
    if (hasRecordedSessions === true) g().available = true;
    else if (hasRecordedSessions === false) {
      g().available = false;
      // Her stored sessions are forgotten with the "no", and a list read on its way is dropped: a later "yes" reads them
      // again, so Home never names a session that was deleted (code review).
      listGeneration += 1;
      g().list = { rows: [], nextCursor: null, loaded: false, loading: false, error: "" };
    }
  } catch {
    // Unknown: nothing is shown or taken away.
  }
  return g().available;
}

// Her sessions of the last year, newest first, a page at a time (`more` reads the next page).
export async function loadMyTrainingList({ more = false } = {}, onChange) {
  const list = g().list;
  if (more && !list.nextCursor) return;
  const generation = ++listGeneration;
  const today = localDateIso();
  const params = new URLSearchParams({ dateFrom: addDaysIso(today, -LIST_DAYS), dateTo: today, limit: String(MY_TRAINING_PAGE) });
  if (more) params.set("cursor", JSON.stringify(list.nextCursor));
  list.loading = true;
  list.error = "";
  onChange?.();
  try {
    const { rows = [], nextCursor = null } = await api(`/api/training-activity?${params}`);
    if (generation !== listGeneration) return;
    list.rows = more ? [...list.rows, ...rows] : rows;
    list.nextCursor = nextCursor;
    list.loaded = true;
  } catch (error) {
    if (generation !== listGeneration) return;
    list.error = more ? "Older sessions could not be loaded. Try again." : "Your sessions could not be loaded.";
  } finally {
    if (generation === listGeneration) {
      list.loading = false;
      onChange?.();
    }
  }
}

// One session with her values.
export async function loadMyTrainingSession(activityId, onChange) {
  const generation = ++detailGeneration;
  g().openId = activityId;
  g().detail = { activityId, data: null, loading: true, error: "" };
  onChange?.();
  try {
    const data = await api(`/api/training-activity/${encodeURIComponent(activityId)}`);
    if (generation !== detailGeneration) return;
    g().detail = { activityId, data, loading: false, error: "" };
  } catch (error) {
    if (generation !== detailGeneration) return;
    g().detail = { activityId, data: null, loading: false, error: error?.status === 404 ? "This session is no longer available." : "This session could not be loaded." };
  }
  onChange?.();
}

export function closeMyTrainingSession() {
  detailGeneration += 1;
  g().openId = "";
  g().detail = { activityId: "", data: null, loading: false, error: "" };
}

// A workspace switch or a sign-out: nothing of the old answer is kept.
export function resetMyTraining() {
  listGeneration += 1;
  detailGeneration += 1;
  availabilityGeneration += 1;
  state.myTraining = {
    available: null,
    list: { rows: [], nextCursor: null, loaded: false, loading: false, error: "" },
    openId: "",
    detail: { activityId: "", data: null, loading: false, error: "" },
  };
}

import { api } from "./api.js";
import { emptyCoachHomeState, state } from "./state.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { exerciseSearchUrl } from "./exercise-data.js";
import { localDateIso, monthWeeksIso } from "./utils.js";
import { buildContextKey, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

const COACH_HOME_CACHE_NAMESPACE = "coach-home";
const COACH_HOME_DAY_NAMESPACE = "coach-home-day";
const COACH_HOME_DAYS_NAMESPACE = "coach-home-days";
// Home's two library strips live in the Exercise and Program Library's own
// namespaces, so the libraries' own invalidations (invalidateExercisesCache
// after an exercise is saved, invalidateTemplatesCache after a program
// changes) clear Home's copies too. The program strip is exactly the
// library's "My Programs" read (program-library-data.js templatesContextKey),
// so the two share one entry; the exercise strip has its own key there.
const EXERCISES_CACHE_NAMESPACE = "exercises";
const TEMPLATES_CACHE_NAMESPACE = "templates";
export const COACH_HOME_EXERCISE_PAGE = 12;

// GET /api/athletes/today is filtered per-viewer and per-workspace only
// (athleteListAccessFilter in backend/src/access.js) - the backend always
// computes "today" itself from the server clock, so no date/athlete/filter
// parameter of any kind reaches it. Account+workspace is therefore the
// complete context key, the same shape as Coaches (coach-profile-actions.js).
// Another day of Home's calendar is its own read (?date=, coach-home-day).
export function coachHomeContextKey() {
  return buildContextKey(currentUserWorkspaceContextParts());
}

// A change to any athlete's plan (builder-actions.js) or to the roster
// (app.js loadAthletes) changes today, any other day and the calendar's dots
// alike, so all three go together.
export function invalidateCoachHomeCache() {
  invalidateCacheNamespace(COACH_HOME_CACHE_NAMESPACE);
  invalidateCacheNamespace(COACH_HOME_DAY_NAMESPACE);
  invalidateCacheNamespace(COACH_HOME_DAYS_NAMESPACE);
}

export async function loadCoachHome({ setLoading, renderCoachHome, forceRefresh = false } = {}) {
  if (state.currentUser?.activeWorkspace?.type === "platform") {
    return renderCoachHome({ rows: [], error: "" });
  }
  const contextKey = coachHomeContextKey();
  await loadCachedView({
    namespace: COACH_HOME_CACHE_NAMESPACE,
    contextKey,
    forceRefresh,
    fetcher: () => api("/api/athletes/today"),
    showLoading: () => setLoading?.("Loading today's overview..."),
    applyData: (data) => renderCoachHome({ rows: data.rows || [], error: "" }),
    applyError: (error) => renderCoachHome({ rows: [], error: error.message || "Could not load today's overview." }),
    getCurrentContextKey: coachHomeContextKey,
  });
}

// The calendar's chosen day and the day that anchors the visible month or
// week, "" being today (state.js emptyCoachHomeState).
export function coachHomeSelectedDate(today = localDateIso()) {
  return state.coachHome.calendar.selected || today;
}

export function coachHomeCursorDate(today = localDateIso()) {
  return state.coachHome.calendar.cursor || coachHomeSelectedDate(today);
}

// The days the calendar shows: whole weeks around the cursor's month.
export function coachHomeGridRange(today = localDateIso()) {
  const weeks = monthWeeksIso(coachHomeCursorDate(today).slice(0, 7));
  return { from: weeks[0][0], to: weeks.at(-1)[6] };
}

export function resetCoachHomeForWorkspaceChange() {
  state.coachHome = emptyCoachHomeState();
  exerciseMoreGeneration += 1;
}

function coachHomeDayKey(date) {
  return buildContextKey([...currentUserWorkspaceContextParts(), date]);
}

// One day other than today: the same rows as /today, for that date. A late
// answer for a day the coach has already left is dropped (the context key
// names the day).
export async function loadCoachHomeDay(date, { onChange, forceRefresh = false } = {}) {
  const contextKey = coachHomeDayKey(date);
  const set = (day) => {
    state.coachHome.day = { date, rows: [], loading: false, error: "", ...day };
    onChange?.("day");
  };
  await loadCachedView({
    namespace: COACH_HOME_DAY_NAMESPACE,
    contextKey,
    forceRefresh,
    fetcher: () => api(`/api/athletes/today?date=${encodeURIComponent(date)}`),
    showLoading: () => set({ loading: true }),
    applyData: (data) => set({ rows: data.rows || [] }),
    applyError: (error) => set({ error: error.message || "Could not load this day." }),
    getCurrentContextKey: () => coachHomeDayKey(coachHomeSelectedDate()),
  });
}

function coachHomeDaysKey(from, to) {
  return buildContextKey([...currentUserWorkspaceContextParts(), from, to]);
}

// The calendar's dots. Optional: a failed read leaves the calendar without
// dots, every day still selectable.
export async function loadCoachHomeTrainingDays({ onChange, forceRefresh = false } = {}) {
  const { from, to } = coachHomeGridRange();
  const contextKey = coachHomeDaysKey(from, to);
  await loadCachedView({
    namespace: COACH_HOME_DAYS_NAMESPACE,
    contextKey,
    forceRefresh,
    fetcher: () => api(`/api/athletes/training-days?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    applyData: (data) => {
      const counts = {};
      for (const day of data.days || []) {
        if (day?.date && Number(day.athleteCount) > 0) counts[day.date] = Number(day.athleteCount);
      }
      state.coachHome.days = { from, to, counts, error: "" };
      onChange?.("day");
    },
    applyError: (error) => {
      state.coachHome.days = { from, to, counts: {}, error: error.message || "Could not load the calendar." };
      onChange?.("day");
    },
    getCurrentContextKey: () => {
      const range = coachHomeGridRange();
      return coachHomeDaysKey(range.from, range.to);
    },
  });
}

function coachHomeExercisesKey() {
  return buildContextKey([...currentUserWorkspaceContextParts(), "coach-home-strip", COACH_HOME_EXERCISE_PAGE]);
}

// The first page of every exercise the library lists by default (the same
// /api/exercises order and filters), later pages on demand.
let exerciseMoreGeneration = 0;

export async function loadCoachHomeExercises({ onChange, forceRefresh = false } = {}) {
  let drawnGeneration = exerciseMoreGeneration;
  const set = (exercises) => {
    state.coachHome.exercises = { ...state.coachHome.exercises, ...exercises };
    onChange?.("exercises");
  };
  await loadCachedView({
    namespace: EXERCISES_CACHE_NAMESPACE,
    contextKey: coachHomeExercisesKey(),
    forceRefresh,
    fetcher: () => api(exerciseSearchUrl("", COACH_HOME_EXERCISE_PAGE)),
    showLoading: () => set({ loading: true, error: "" }),
    applyData: (data, meta = {}) => {
      // A background refresh never shrinks a strip the coach paged further
      // while it was on its way (a further page started since the cached
      // first page was drawn); every other answer, the one after an
      // invalidation included, replaces the strip. Either way the loading
      // flag showLoading set is cleared.
      if (meta.fromCache === false && exerciseMoreGeneration !== drawnGeneration) {
        set({ loading: false });
        return;
      }
      drawnGeneration = ++exerciseMoreGeneration;
      set({ items: data.exercises || [], hasMore: Boolean(data.hasMore), loaded: true, loading: false, loadingMore: false, error: "", moreError: "" });
    },
    applyError: (error) => set({ loading: false, error: error.message || "Could not load exercises." }),
    getCurrentContextKey: coachHomeExercisesKey,
  });
}

export async function loadMoreCoachHomeExercises({ onChange } = {}) {
  const exercises = state.coachHome.exercises;
  if (!exercises.loaded || !exercises.hasMore || exercises.loading || exercises.loadingMore) return;
  const contextKey = coachHomeExercisesKey();
  const generation = ++exerciseMoreGeneration;
  state.coachHome.exercises = { ...exercises, loadingMore: true, moreError: "" };
  onChange?.("exercises-more", []);
  try {
    const data = await api(`${exerciseSearchUrl("", COACH_HOME_EXERCISE_PAGE)}&offset=${exercises.items.length}`);
    if (generation !== exerciseMoreGeneration || coachHomeExercisesKey() !== contextKey) return;
    const current = state.coachHome.exercises;
    const seen = new Set(current.items.map((exercise) => String(exercise.id)));
    const appended = (data.exercises || []).filter((exercise) => !seen.has(String(exercise.id)));
    state.coachHome.exercises = { ...current, items: [...current.items, ...appended], hasMore: Boolean(data.hasMore), loadingMore: false };
    onChange?.("exercises-more", appended);
  } catch (error) {
    if (generation !== exerciseMoreGeneration || coachHomeExercisesKey() !== contextKey) return;
    state.coachHome.exercises = { ...state.coachHome.exercises, loadingMore: false, moreError: error.message || "Could not load more exercises." };
    onChange?.("exercises-more", []);
  }
}

function coachHomeProgramsKey() {
  return buildContextKey([...currentUserWorkspaceContextParts(), "my_programs"]);
}

export async function loadCoachHomePrograms({ onChange, forceRefresh = false } = {}) {
  const set = (programs) => {
    state.coachHome.programs = { ...state.coachHome.programs, ...programs };
    onChange?.("programs");
  };
  await loadCachedView({
    namespace: TEMPLATES_CACHE_NAMESPACE,
    contextKey: coachHomeProgramsKey(),
    forceRefresh,
    fetcher: () => api("/api/templates?scope=my_programs"),
    showLoading: () => set({ loading: true, error: "" }),
    applyData: (data) => set({ items: data.templates || [], loaded: true, loading: false, error: "" }),
    applyError: (error) => set({ loading: false, error: error.message || "Could not load programs." }),
    getCurrentContextKey: coachHomeProgramsKey,
  });
}

// Everything on Home besides the roster, each part on its own: the calendar's
// dots, the chosen day (unless it is today, which the roster read already
// answers) and the two library strips.
export function loadCoachHomeExtras({ onChange, forceRefresh = false } = {}) {
  const today = localDateIso();
  const selected = coachHomeSelectedDate(today);
  return Promise.all([
    loadCoachHomeTrainingDays({ onChange, forceRefresh }),
    selected === today ? null : loadCoachHomeDay(selected, { onChange, forceRefresh }),
    loadCoachHomeExercises({ onChange, forceRefresh }),
    loadCoachHomePrograms({ onChange, forceRefresh }),
  ]);
}

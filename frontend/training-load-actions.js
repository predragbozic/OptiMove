import { emptyRpeForm, emptyTrainingLoadFilter, emptyTrainingLoadFilterPicker, state } from "./state.js";
import { addDaysIso, localDateIsoInTimeZone, weekMondayIso } from "./utils.js";
import {
  invalidateAllTrainingLoadWeeklyGenerations,
  loadTrainingLoadAthleteToday,
  loadTrainingLoadAthleteWeekly,
  loadTrainingLoadOrgPickerData,
  loadTrainingLoadWeekly,
  submitRpe,
} from "./training-load-data.js";
import { isRpeFormValid, renderRpeSliderInnerHtml } from "./training-load-view.js";

// Every data-action="training-load-*" click/input in the Athlete Home card/
// RPE form/weekly overlay and the coach Training Load tab routes through
// here - mirrors the per-feature dispatch convention every other tab
// already uses (handleWeeklyAction, handleTestsAction - see frontend/
// app.js's handleContentClick), deliberately its own module so this
// feature never shares state or code with tests-actions.js.

export async function handleTrainingLoadAction(action, { renderTrainingLoad, openWeeklyPlanForAthleteOnDate }) {
  const type = action.dataset.action;
  if (!type?.startsWith("training-load-")) return false;

  // -------------------- Athlete: Home card / session list --------------------

  if (type === "training-load-home-card-open") {
    const count = Number(action.dataset.count || 0);
    if (count === 1 && action.dataset.sessionId) {
      openRpeFormForSessionId(action.dataset.sessionId);
    } else {
      state.trainingLoad.rpeForm = null;
      state.trainingLoad.showSessionList = true;
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-close-list") {
    state.trainingLoad.showSessionList = false;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-open-rpe-form") {
    openRpeFormForSessionId(action.dataset.sessionId);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-close-rpe-form") {
    const hadSaved = Boolean(state.trainingLoad.rpeForm?.savedFeedback);
    state.trainingLoad.rpeForm = null;
    // Item: "Posle uspešnog unosa zahtev nestaje sa Home-a" - re-fetch once
    // the confirmation is dismissed, so the Home card/list (and the
    // weekly overlay, if that's where this was opened from) reflect the
    // new rated status immediately, not on the next unrelated visit.
    if (hadSaved) {
      await loadTrainingLoadAthleteToday();
      if (state.trainingLoad.athleteWeeklyOpen) await loadTrainingLoadAthleteWeekly();
    }
    renderTrainingLoad();
    return true;
  }

  // -------------------- Athlete: "This week" overlay (item 4 correction) --------------------
  // A permanent, always-visible entry point (unlike the Home card, which
  // only ever reflects TODAY's own unrated count and disappears at zero) -
  // a not-yet-rated session from yesterday or earlier has no other UI path
  // to reach otherwise.

  if (type === "training-load-athlete-weekly-open") {
    state.trainingLoad.athleteWeeklyOpen = true;
    if (!state.trainingLoad.athleteWeekly.data) await loadTrainingLoadAthleteWeekly();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-athlete-weekly-close") {
    state.trainingLoad.athleteWeeklyOpen = false;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-athlete-weekly-prev-week" || type === "training-load-athlete-weekly-next-week") {
    const nav = state.trainingLoad.athleteWeekly;
    const delta = type === "training-load-athlete-weekly-prev-week" ? -7 : 7;
    nav.weekStart = addDaysIso(nav.weekStart, delta);
    if (nav.selectedDate) nav.selectedDate = addDaysIso(nav.selectedDate, delta);
    await loadTrainingLoadAthleteWeekly();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-athlete-weekly-today") {
    const nav = state.trainingLoad.athleteWeekly;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const today = localDateIsoInTimeZone(timezone);
    nav.weekStart = weekMondayIso(today);
    nav.selectedDate = today;
    await loadTrainingLoadAthleteWeekly();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-athlete-weekly-select-day") {
    state.trainingLoad.athleteWeekly.selectedDate = action.dataset.date;
    renderTrainingLoad();
    return true;
  }

  // -------------------- Athlete: RPE form controls --------------------

  if (type === "training-load-rpe-slider-input") {
    const form = state.trainingLoad.rpeForm;
    if (!form) return true;
    form.rpe = Number(action.value ?? action.target?.value ?? form.rpe);
    // Targeted patch (never a full re-render) - dragging the slider must
    // never lose slider focus/drag state, same convention as this app's
    // other continuous-input controls (see tests-actions.js's own slider
    // handling).
    const block = document.querySelector("[data-training-load-slider-block]");
    if (block) block.innerHTML = renderRpeSliderInnerHtml(form);
    patchSrpePreview(form);
    patchSaveButtonDisabled(form);
    return true;
  }
  if (type === "training-load-rpe-duration-input") {
    const form = state.trainingLoad.rpeForm;
    if (!form) return true;
    const raw = action.value ?? action.target?.value ?? "";
    form.durationMinutes = raw === "" ? "" : Number(raw);
    patchSrpePreview(form);
    patchSaveButtonDisabled(form);
    return true;
  }
  if (type === "training-load-rpe-note-input") {
    const form = state.trainingLoad.rpeForm;
    if (!form) return true;
    // No DOM patch, no re-render - a textarea already shows exactly what
    // was typed; re-rendering it would just fight the user's own cursor.
    form.note = action.value ?? action.target?.value ?? "";
    return true;
  }
  if (type === "training-load-rpe-submit") {
    await submitRpeForm(renderTrainingLoad);
    return true;
  }

  // -------------------- Coach: Today/Schedule/Results tabs --------------------

  if (type === "training-load-section") {
    state.trainingLoad.section = action.dataset.section;
    // Correction: "always-refresh" (menu-cache-policy.js) means every
    // section switch is a real fetch, never skipped just because that
    // section already has SOME data from an earlier visit this session.
    await loadTrainingLoadWeekly(state.trainingLoad.section);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-weekly-prev-week" || type === "training-load-weekly-next-week") {
    const section = action.dataset.section;
    const nav = state.trainingLoad.weekly[section];
    const delta = type === "training-load-weekly-prev-week" ? -7 : 7;
    nav.weekStart = addDaysIso(nav.weekStart, delta);
    if (nav.selectedDate) nav.selectedDate = addDaysIso(nav.selectedDate, delta);
    await loadTrainingLoadWeekly(section);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-weekly-today") {
    const section = action.dataset.section;
    const nav = state.trainingLoad.weekly[section];
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const today = localDateIsoInTimeZone(timezone);
    nav.weekStart = weekMondayIso(today);
    nav.selectedDate = today;
    await loadTrainingLoadWeekly(section);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-weekly-select-day") {
    state.trainingLoad.weekly[action.dataset.section].selectedDate = action.dataset.date;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-open-weekly-plan") {
    await openWeeklyPlanForAthleteOnDate?.(action.dataset.athleteId, action.dataset.date);
    return true;
  }

  // -------------------- Coach: Club/Team/Athletes filter picker --------------------

  if (type === "training-load-filter-open") {
    await loadTrainingLoadOrgPickerData().catch(() => {});
    state.trainingLoad.filterSnapshotAtOpen = { ...state.trainingLoad.filter, clubIds: [...state.trainingLoad.filter.clubIds], teamIds: [...state.trainingLoad.filter.teamIds], athleteIds: [...state.trainingLoad.filter.athleteIds] };
    state.trainingLoad.filterPicker.open = true;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-filter-cancel") {
    if (state.trainingLoad.filterSnapshotAtOpen) state.trainingLoad.filter = state.trainingLoad.filterSnapshotAtOpen;
    state.trainingLoad.filterSnapshotAtOpen = null;
    state.trainingLoad.filterPicker.open = false;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-filter-confirm") {
    state.trainingLoad.filterSnapshotAtOpen = null;
    state.trainingLoad.filterPicker.open = false;
    // Correction: Confirm used to re-fetch only the currently-open sub-tab -
    // the OTHER two kept showing data fetched under the OLD filter until
    // someone happened to switch to them. Every section's cached data is
    // dropped now (so a later switch into it always shows a real, fresh
    // fetch under the new filter, never a stale flash) and the CURRENT
    // section is refetched immediately for instant visible feedback.
    for (const key of Object.keys(state.trainingLoad.weekly)) state.trainingLoad.weekly[key].data = null;
    renderTrainingLoad();
    await loadTrainingLoadWeekly(state.trainingLoad.section);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-filter-set-tab") {
    state.trainingLoad.filterPicker.tab = action.dataset.filterTab;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-filter-athlete-search") {
    state.trainingLoad.filterPicker.search = action.value ?? action.target?.value ?? "";
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-filter-toggle") {
    toggleFilterId(action.dataset.kind, action.dataset.id);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-filter-select-all") {
    selectAllFilter(action.dataset.kind);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-filter-clear") {
    clearFilter(action.dataset.kind);
    renderTrainingLoad();
    return true;
  }

  return false;
}

function filterListForKind(kind) {
  if (kind === "club") return state.trainingLoad.filter.clubIds;
  if (kind === "team") return state.trainingLoad.filter.teamIds;
  return state.trainingLoad.filter.athleteIds;
}

function toggleFilterId(kind, id) {
  const list = filterListForKind(kind);
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
  else list.push(id);
}

function selectAllFilter(kind) {
  const orgData = state.trainingLoad.orgPickerData;
  if (kind === "club") {
    state.trainingLoad.filter.clubIds = (orgData?.clubs || []).map((c) => c.id);
  } else if (kind === "team") {
    state.trainingLoad.filter.teamIds = (orgData?.teams || []).map((t) => t.id);
  } else {
    const roster = state.athletes || [];
    const search = state.trainingLoad.filterPicker.search.trim().toLowerCase();
    const visible = search ? roster.filter((a) => (a.athlete || "").toLowerCase().includes(search)) : roster;
    state.trainingLoad.filter.athleteIds = visible.map((a) => a.athlete_uuid);
  }
}

function clearFilter(kind) {
  if (kind === "club") state.trainingLoad.filter.clubIds = [];
  else if (kind === "team") state.trainingLoad.filter.teamIds = [];
  else state.trainingLoad.filter.athleteIds = [];
}

// ------------------------------------------------------------
// Athlete RPE form helpers
// ------------------------------------------------------------

// Resolves a session (plus the calendar date it's on) by id from whichever
// athlete-facing list currently holds it - today's Home list, or (item 4
// correction) the "This week" overlay, which can hold a past/today session
// the Home card itself never shows once its own day has rolled forward.
function findAthleteSessionById(sessionId) {
  const todayMatch = state.trainingLoad.athleteToday.sessions.find((s) => s.sessionId === sessionId);
  if (todayMatch) return { session: todayMatch, date: state.trainingLoad.athleteToday.date };
  const weeklyDays = state.trainingLoad.athleteWeekly.data?.days || [];
  for (const day of weeklyDays) {
    const match = day.sessions.find((s) => s.sessionId === sessionId);
    if (match) return { session: match, date: day.date };
  }
  return null;
}

// Correction: a session that's already rated must never open a blank,
// re-submittable form - it would only ever end in a 409. This guard, PLUS
// the corresponding rows simply not being rendered as clickable in
// training-load-view.js, is the same "double gate" pattern already used
// elsewhere in this app (belt-and-suspenders, not redundant - one guard
// covers a stale DOM, the other covers any direct action dispatch).
function openRpeFormForSessionId(sessionId) {
  const found = findAthleteSessionById(sessionId);
  if (!found || found.session.rated) return;
  const { session, date } = found;
  state.trainingLoad.showSessionList = false;
  state.trainingLoad.rpeForm = emptyRpeForm({
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    amPm: session.amPm,
    bta: session.bta,
    sessionTime: session.sessionTime,
    date,
  });
}

function patchSrpePreview(form) {
  const el = document.querySelector("[data-training-load-srpe-preview]");
  if (!el) return;
  const duration = Number(form.durationMinutes);
  const live = form.durationMinutes !== "" && Number.isFinite(duration) && duration > 0 ? form.rpe * duration : null;
  el.innerHTML = live != null ? `sRPE preview: <strong>${live} AU</strong>` : "sRPE preview: enter a duration";
}

function patchSaveButtonDisabled(form) {
  const button = document.querySelector(".training-load-rpe-save");
  if (button) button.disabled = form.saving || !isRpeFormValid(form);
}

async function submitRpeForm(renderTrainingLoad) {
  const form = state.trainingLoad.rpeForm;
  if (!form || form.saving || !isRpeFormValid(form)) return;
  form.saving = true;
  form.error = "";
  renderTrainingLoad();
  try {
    const result = await submitRpe(form.sessionId, { rpe: form.rpe, durationMinutes: Number(form.durationMinutes), note: form.note });
    form.saving = false;
    form.savedFeedback = result.feedback;
  } catch (error) {
    form.saving = false;
    form.error = error.message || "Could not save this session's feedback.";
  }
  renderTrainingLoad();
}

// ------------------------------------------------------------
// Workspace switch (item 2/3 correction) - the old workspace's filter
// selection, org-picker roster, and cached weekly payload (coach tabs AND
// the athlete overlay - a workspace switch also changes which athlete
// profile "athlete" workspace means) must never leak into the new one.
// invalidateAllTrainingLoadWeeklyGenerations() bumps every request-
// generation counter FIRST, so an already-in-flight response for the OLD
// workspace can never land afterward and overwrite the reset state, even
// if Training load isn't the tab that's currently open (see that
// function's own comment in training-load-data.js).
// ------------------------------------------------------------
export function resetTrainingLoadForWorkspaceChange() {
  // Bumping the generation counter makes an in-flight response for the OLD
  // workspace bail out via its own early-return before it ever reaches the
  // line that clears `loading` - so `loading` must be reset HERE too, or a
  // request that was in flight at the moment of the switch leaves its
  // section stuck showing a permanent spinner.
  invalidateAllTrainingLoadWeeklyGenerations();
  for (const key of Object.keys(state.trainingLoad.weekly)) {
    state.trainingLoad.weekly[key].data = null;
    state.trainingLoad.weekly[key].error = "";
    state.trainingLoad.weekly[key].loading = false;
  }
  state.trainingLoad.athleteWeekly.data = null;
  state.trainingLoad.athleteWeekly.error = "";
  state.trainingLoad.athleteWeekly.loading = false;
  state.trainingLoad.filter = emptyTrainingLoadFilter();
  state.trainingLoad.filterPicker = emptyTrainingLoadFilterPicker();
  state.trainingLoad.filterSnapshotAtOpen = null;
  state.trainingLoad.orgPickerData = null;
}

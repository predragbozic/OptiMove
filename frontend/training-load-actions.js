import { emptyRpeForm, emptyTrainingLoadFilter, state } from "./state.js";
import { addDaysIso, localDateIsoInTimeZone, weekMondayIso } from "./utils.js";
import { loadTrainingLoadAthleteToday, loadTrainingLoadOrgPickerData, loadTrainingLoadWeekly, submitRpe } from "./training-load-data.js";
import { isRpeFormValid, renderRpeSliderInnerHtml } from "./training-load-view.js";

// Every data-action="training-load-*" click/input in the Athlete Home card/
// RPE form and the coach Training Load tab routes through here - mirrors
// the per-feature dispatch convention every other tab already uses
// (handleWeeklyAction, handleTestsAction - see frontend/app.js's
// handleContentClick), deliberately its own module so this feature never
// shares state or code with tests-actions.js.

function trainingLoadWeeklySection() {
  return state.trainingLoad.section;
}

export async function handleTrainingLoadAction(action, { renderTrainingLoad, openWeeklyPlanForAthleteOnDate }) {
  const type = action.dataset.action;
  if (!type?.startsWith("training-load-")) return false;

  // -------------------- Athlete: Home card / session list --------------------

  if (type === "training-load-home-card-open") {
    const count = Number(action.dataset.count || 0);
    if (count === 1 && action.dataset.sessionId) {
      openRpeFormForSession(action.dataset.sessionId);
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
    openRpeFormForSession(action.dataset.sessionId);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-close-rpe-form") {
    const hadSaved = Boolean(state.trainingLoad.rpeForm?.savedFeedback);
    state.trainingLoad.rpeForm = null;
    // Item: "Posle uspešnog unosa zahtev nestaje sa Home-a" - re-fetch once
    // the confirmation is dismissed, so the Home card/list reflect the new
    // rated status immediately, not on the next unrelated Home visit.
    if (hadSaved) await loadTrainingLoadAthleteToday();
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
    if (!state.trainingLoad.weekly[state.trainingLoad.section].data) {
      await loadTrainingLoadWeekly(state.trainingLoad.section);
    }
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
    renderTrainingLoad();
    await loadTrainingLoadWeekly(trainingLoadWeeklySection());
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

function openRpeFormForSession(sessionId) {
  const session = state.trainingLoad.athleteToday.sessions.find((s) => s.sessionId === sessionId);
  if (!session) return;
  state.trainingLoad.showSessionList = false;
  state.trainingLoad.rpeForm = emptyRpeForm({
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    amPm: session.amPm,
    bta: session.bta,
    sessionTime: session.sessionTime,
    date: state.trainingLoad.athleteToday.date,
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
// Filter/state reset (logout, workspace switch) - mirrors the pattern
// other tabs use so a stale filter/picker never leaks across accounts.
// ------------------------------------------------------------
export function resetTrainingLoadFilterState() {
  state.trainingLoad.filter = emptyTrainingLoadFilter();
  state.trainingLoad.filterPicker.open = false;
  state.trainingLoad.filterSnapshotAtOpen = null;
}

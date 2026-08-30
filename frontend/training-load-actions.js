import { emptyExternalScheduleDetail, emptyExternalScheduleForm, emptyRpeForm, emptyTrainingLoadFilter, emptyTrainingLoadFilterPicker, state } from "./state.js";
import { addDaysIso, localDateIsoInTimeZone, localMonthIsoInTimeZone, weekMondayIso } from "./utils.js";
import {
  createExternalSchedule,
  invalidateAllTrainingLoadWeeklyGenerations,
  loadExternalScheduleDetail,
  loadTrainingLoadAthleteToday,
  loadTrainingLoadAthleteWeekly,
  loadTrainingLoadOrgPickerData,
  loadTrainingLoadWeekly,
  scheduleExternalAgain,
  sendExternalScheduleReminder,
  setExternalScheduleStatus,
  submitRpe,
  submitExternalRpe,
  toggleSessionRpeEnabled,
  updateExternalSchedule,
} from "./training-load-data.js";
import { externalCalendarMode, externalScheduleSubmitDisabled, externalScheduleSubmitLabel, isRpeFormValid, renderRpeSliderInnerHtml, trainingLoadFilterVisibleAthletes } from "./training-load-view.js";

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
    // Correction: every open must re-fetch, never skip just because a
    // previous open already populated .data - the coach may have changed
    // the plan, or a result may have been entered from another device,
    // since this overlay was last opened. The existing "athlete" request-
    // generation counter (loadTrainingLoadWeeklyInto) already guards
    // against a stale response landing after a newer one, so this is safe.
    state.trainingLoad.athleteWeeklyOpen = true;
    await loadTrainingLoadAthleteWeekly();
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

  // Training Load Schedule tab's quick RPE ON/OFF toggle. Turning RPE ON
  // never needs confirmation. Turning it OFF needs a real, server-checked
  // confirmation ONLY when the session already has a recorded result -
  // the backend's own 409 { error: "hasExistingResults" } is what decides
  // this, never a client-side guess, since the frontend's own session
  // object doesn't carry a reliable "how many results already exist"
  // count.
  if (type === "training-load-toggle-session-rpe") {
    const sessionId = action.dataset.sessionId;
    if (!sessionId) return true;
    const currentlyEnabled = action.dataset.currentlyEnabled === "true";
    const nextEnabled = !currentlyEnabled;
    try {
      await toggleSessionRpeEnabled(sessionId, nextEnabled);
    } catch (error) {
      if (error.status === 409 && error.message === "hasExistingResults") {
        if (!window.confirm("This session already has a recorded RPE result. Turning RPE off will stop new submissions, but the existing result stays in Results. Continue?")) {
          return true;
        }
        await toggleSessionRpeEnabled(sessionId, nextEnabled, true);
      } else {
        throw error;
      }
    }
    await loadTrainingLoadWeekly(state.trainingLoad.section);
    renderTrainingLoad();
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

  // -------------------- Coach: "New RPE session" (external scheduling) --------------------

  if (type === "training-load-open-schedule-form") {
    const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    state.trainingLoad.scheduleForm = emptyExternalScheduleForm({
      timezone: defaultTimezone,
      startDate: localDateIsoInTimeZone(defaultTimezone),
      calendarMonth: localMonthIsoInTimeZone(defaultTimezone),
    });
    state.trainingLoad.scheduleDetail = null;
    renderTrainingLoad();
    void loadTrainingLoadOrgPickerData().then(renderTrainingLoad).catch(() => {});
    return true;
  }
  if (type === "training-load-close-schedule-form") {
    state.trainingLoad.scheduleForm = null;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-schedule-form-field") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    // For a real input/textarea, `action` IS the DOM element itself (see
    // app.js's own handleContentInput - it dispatches training-load-*
    // actions straight off the element, same convention as the RPE form's
    // own slider/duration/note inputs above), so its `name` HTML attribute
    // is read as a native property, never a dataset lookup.
    const name = action.name || action.dataset?.name;
    const value = action.value ?? action.target?.value ?? "";
    if (name && name in form) form[name] = value;
    // Never a full re-render on every keystroke - that would rebuild this
    // very input's own DOM node mid-typing and drop focus/subsequent
    // keystrokes (found live: typing "National team camp" landed as "").
    // Only the submit button's disabled/label state can depend on these
    // fields, so that's the only thing patched.
    patchScheduleSubmitButtonDom(form);
    return true;
  }
  if (type === "training-load-schedule-set-event-type") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    const value = action.dataset.eventType;
    form.eventType = form.eventType === value ? "" : value;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-schedule-set-recurrence") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    const isEdit = Boolean(form.editingScheduleId);
    const daily = action.dataset.daily === "true";
    form.scheduleKind = daily ? "daily" : isEdit ? "one_time" : "specific_dates";
    form.calendarOpen = true;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-toggle-advanced-settings") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    form.advancedSettingsOpen = !form.advancedSettingsOpen;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-toggle-notifications-section") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    form.notificationsSectionOpen = !form.notificationsSectionOpen;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-notification-rule-toggle") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    const kind = action.dataset.kind;
    let rule = form.notificationRules.find((r) => r.kind === kind);
    if (!rule) {
      rule = { kind, enabled: false, reminderOffsetMinutes: kind === "athlete_reminder" ? 60 : null };
      form.notificationRules.push(rule);
    }
    rule.enabled = !rule.enabled;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-notification-offset-input") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    const raw = Number(action.value ?? action.target?.value);
    const rule = form.notificationRules.find((r) => r.kind === "athlete_reminder");
    if (rule && Number.isFinite(raw) && raw > 0) rule.reminderOffsetMinutes = Math.trunc(raw);
    // No re-render - a live-typed number input, same "never fight the
    // user's own cursor/keystrokes" rule the note/name fields follow.
    return true;
  }

  // -------------------- New RPE session: calendar (click-only, no drag) --------------------

  if (type === "training-load-calendar-day-click") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    const date = action.dataset.date;
    const mode = externalCalendarMode(form);
    if (mode === "multi") {
      const index = form.selectedDates.indexOf(date);
      if (index >= 0) form.selectedDates.splice(index, 1);
      else form.selectedDates.push(date);
    } else if (mode === "single") {
      form.startDate = date;
      form.endDate = date;
    } else {
      // range (Daily): a two-click anchor - the first click starts a fresh
      // range, the second confirms start..end (sorted) and clears the
      // anchor, so the click right after that starts a brand-new range.
      if (!form.rangeAnchor) {
        form.rangeAnchor = date;
        form.startDate = date;
        form.endDate = date;
      } else {
        const [from, to] = form.rangeAnchor <= date ? [form.rangeAnchor, date] : [date, form.rangeAnchor];
        form.startDate = from;
        form.endDate = to;
        form.rangeAnchor = "";
      }
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-prev-month" || type === "training-load-calendar-next-month") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    const timezone = form.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const [year, month] = (form.calendarMonth || localMonthIsoInTimeZone(timezone)).split("-").map(Number);
    const delta = type === "training-load-calendar-prev-month" ? -1 : 1;
    const next = new Date(Date.UTC(year, month - 1 + delta, 1));
    form.calendarMonth = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-remove-date") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    form.selectedDates = form.selectedDates.filter((d) => d !== action.dataset.date);
    renderTrainingLoad();
    return true;
  }

  // -------------------- New RPE session: recipients picker --------------------

  if (type === "training-load-open-recipient-picker") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    if (!state.trainingLoad.orgPickerData) await loadTrainingLoadOrgPickerData().catch(() => {});
    form.recipientPickerOpen = true;
    form.recipientPickerSnapshot = { athleteIds: form.athleteIds.slice(), teamIds: form.teamIds.slice(), clubIds: form.clubIds.slice() };
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-recipient-picker-cancel") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    if (form.recipientPickerSnapshot) {
      form.athleteIds = form.recipientPickerSnapshot.athleteIds.slice();
      form.teamIds = form.recipientPickerSnapshot.teamIds.slice();
      form.clubIds = form.recipientPickerSnapshot.clubIds.slice();
    }
    form.recipientPickerSnapshot = null;
    form.recipientPickerOpen = false;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-recipient-picker-confirm") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    form.recipientPickerSnapshot = null;
    form.recipientPickerOpen = false;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-recipient-picker-set-tab") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    form.recipientPickerTab = action.dataset.recipientTab;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-recipient-athlete-search") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    form.athleteSearch = action.value ?? action.target?.value ?? "";
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-recipient-picker-toggle") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    const key = recipientListKey(action.dataset.kind);
    const list = form[key];
    const index = list.indexOf(action.dataset.id);
    if (index >= 0) list.splice(index, 1);
    else list.push(action.dataset.id);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-recipient-picker-select-all") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    const kind = action.dataset.kind;
    const key = recipientListKey(kind);
    const items = kind === "club" ? state.trainingLoad.orgPickerData?.clubs || []
      : kind === "team" ? state.trainingLoad.orgPickerData?.teams || []
      : externalRecipientVisibleAthletesForActions(form);
    const selected = new Set(form[key]);
    for (const item of items) selected.add(item.id);
    form[key] = Array.from(selected);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-recipient-picker-clear") {
    const form = state.trainingLoad.scheduleForm;
    if (!form) return true;
    form[recipientListKey(action.dataset.kind)] = [];
    renderTrainingLoad();
    return true;
  }

  // -------------------- New RPE session: submit (create/update) --------------------

  if (type === "training-load-schedule-submit") {
    await submitExternalScheduleForm(renderTrainingLoad);
    return true;
  }

  // -------------------- Schedule tab: external schedule detail/lifecycle --------------------

  if (type === "training-load-open-external-schedule") {
    await openExternalScheduleDetail(action.dataset.scheduleId, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-close-external-schedule") {
    state.trainingLoad.scheduleDetail = null;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-open-edit-external-schedule") {
    await openEditExternalSchedule(action.dataset.scheduleId, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-external-schedule-again") {
    await openExternalScheduleAgain(action.dataset.scheduleId, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-set-external-schedule-status") {
    const scheduleId = action.dataset.scheduleId;
    const statusAction = action.dataset.status; // "pause" | "resume" | "cancel"
    if (statusAction === "cancel" && !window.confirm("Cancel this RPE session? It can no longer be edited or reactivated - existing results stay available in Results.")) {
      return true;
    }
    await setExternalScheduleStatus(scheduleId, statusAction);
    await openExternalScheduleDetail(scheduleId, renderTrainingLoad);
    return true;
  }

  // -------------------- Today tab: OUTSIDE PLAN group detail + manual reminder --------------------

  if (type === "training-load-open-external-group") {
    const day = state.trainingLoad.weekly.today.data?.days.find((d) => d.date === action.dataset.date);
    const session = day?.sessions.find((s) => s.source === "scheduled_external" && s.scheduleId === action.dataset.scheduleId);
    state.trainingLoad.todayGroupDetail = { scheduleId: action.dataset.scheduleId, date: action.dataset.date, eventName: session?.sessionName || "" };
    state.trainingLoad.reminderResult = null;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-close-external-group") {
    state.trainingLoad.todayGroupDetail = null;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-external-reminder-toggle-athlete") {
    const open = state.trainingLoad.todayGroupDetail;
    if (!open) return true;
    const { ids, fingerprint } = currentExternalReminderSelection(open.scheduleId);
    const id = action.dataset.assignmentId;
    const index = ids.indexOf(id);
    if (index >= 0) ids.splice(index, 1);
    else ids.push(id);
    state.trainingLoad.reminderSelection[open.scheduleId] = { fingerprint, ids };
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-external-reminder-select-all") {
    const open = state.trainingLoad.todayGroupDetail;
    if (!open) return true;
    const { fingerprint } = currentExternalReminderSelection(open.scheduleId);
    state.trainingLoad.reminderSelection[open.scheduleId] = { fingerprint, ids: fingerprint ? fingerprint.split(",").filter(Boolean) : [] };
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-external-reminder-clear") {
    const open = state.trainingLoad.todayGroupDetail;
    if (!open) return true;
    const { fingerprint } = currentExternalReminderSelection(open.scheduleId);
    state.trainingLoad.reminderSelection[open.scheduleId] = { fingerprint, ids: [] };
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-send-external-reminder") {
    await sendExternalReminder(action.dataset.scheduleId, renderTrainingLoad);
    return true;
  }

  return false;
}

function recipientListKey(kind) {
  if (kind === "club") return "clubIds";
  if (kind === "team") return "teamIds";
  return "athleteIds";
}

// Mirrors training-load-view.js's own externalRecipientVisibleAthletes -
// duplicated (not imported) because that one is not exported; kept in sync
// deliberately since both read the exact same two state fields.
function externalRecipientVisibleAthletesForActions(form) {
  const roster = state.trainingLoad.orgPickerData?.athletes || [];
  const search = form.athleteSearch.trim().toLowerCase();
  return search ? roster.filter((a) => (a.name || "").toLowerCase().includes(search)) : roster;
}

// ------------------------------------------------------------
// External (outside-plan) RPE scheduling - form submit + schedule detail/
// lifecycle helpers.
// ------------------------------------------------------------

function patchScheduleSubmitButtonDom(form) {
  const button = document.querySelector("[data-training-load-schedule-submit]");
  if (!button) return;
  button.disabled = externalScheduleSubmitDisabled(form);
  button.textContent = externalScheduleSubmitLabel(form);
}

function buildExternalTargetsPayload(form) {
  const targets = [];
  for (const id of form.clubIds) targets.push({ kind: "club", id });
  for (const id of form.teamIds) targets.push({ kind: "team", id });
  for (const id of form.athleteIds) targets.push({ kind: "athlete", id });
  return targets;
}

function applyTargetsToForm(form, targets) {
  form.clubIds = targets.filter((t) => t.kind === "club").map((t) => t.clubId).filter(Boolean);
  form.teamIds = targets.filter((t) => t.kind === "team").map((t) => t.teamId).filter(Boolean);
  form.athleteIds = targets.filter((t) => t.kind === "athlete").map((t) => t.athleteId).filter(Boolean);
}

function buildExternalScheduleBody(form) {
  const base = {
    eventName: form.eventName.trim(),
    eventType: form.eventType || null,
    eventNote: form.eventNote.trim() || null,
    timezone: form.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    opensTime: form.opensTime,
    closesTime: form.closesTime,
    targets: buildExternalTargetsPayload(form),
    notificationRules: form.notificationRules.map((r) => ({ kind: r.kind, enabled: r.enabled, reminderOffsetMinutes: r.kind === "athlete_reminder" ? r.reminderOffsetMinutes : undefined })),
  };
  if (form.scheduleKind === "specific_dates") return { ...base, dates: form.selectedDates.slice() };
  if (form.scheduleKind === "daily") return { ...base, scheduleKind: "recurring", startDate: form.startDate, endDate: form.endDate };
  return { ...base, startDate: form.startDate };
}

async function submitExternalScheduleForm(renderTrainingLoad) {
  const form = state.trainingLoad.scheduleForm;
  if (!form || form.submitting) return;
  form.submitting = true;
  form.error = "";
  renderTrainingLoad();
  try {
    if (form.scheduleAgainFromId) {
      // Hardening correction (item 1): this form shows name/type/times/
      // note/timezone/targets/notifications as fully editable, exactly
      // like a real create - so it now SENDS the same full body a real
      // create would (buildExternalScheduleBody), never just the new
      // date(s). The backend runs the identical validator a real create
      // does, with the original schedule as the fallback for anything
      // this form happens to omit - every displayed field the coach
      // actually changes here now genuinely applies to the new schedule.
      await scheduleExternalAgain(form.scheduleAgainFromId, buildExternalScheduleBody(form));
    } else if (form.editingScheduleId) {
      const body = buildExternalScheduleBody(form);
      // PATCH never changes an existing schedule's own start date/kind -
      // only Schedule again (above) creates a schedule under a new date.
      delete body.dates;
      delete body.scheduleKind;
      delete body.startDate;
      await updateExternalSchedule(form.editingScheduleId, body);
    } else {
      await createExternalSchedule(buildExternalScheduleBody(form));
    }
    state.trainingLoad.scheduleForm = null;
    await loadTrainingLoadWeekly(state.trainingLoad.section);
  } catch (error) {
    form.submitting = false;
    form.error = error.message || "Could not save this RPE session.";
    renderTrainingLoad();
    return;
  }
  renderTrainingLoad();
}

async function openExternalScheduleDetail(scheduleId, renderTrainingLoad) {
  state.trainingLoad.scheduleDetail = emptyExternalScheduleDetail({ scheduleId, loading: true });
  renderTrainingLoad();
  try {
    const data = await loadExternalScheduleDetail(scheduleId);
    state.trainingLoad.scheduleDetail = { scheduleId, schedule: data.schedule, targets: data.targets, loading: false, error: "" };
  } catch (error) {
    state.trainingLoad.scheduleDetail = emptyExternalScheduleDetail({ scheduleId, loading: false, error: error.message || "Could not load this schedule." });
  }
  renderTrainingLoad();
}

// Falls back to the same 3-rule defaults a brand-new form starts with -
// only reachable for a schedule that predates the real create route ever
// inserting rows (a raw fixture/older schedule), matching the worker's
// own "absent row = enabled" reading exactly.
function notificationRulesFromApi(rules) {
  if (Array.isArray(rules) && rules.length) return rules.map((r) => ({ kind: r.kind, enabled: r.enabled, reminderOffsetMinutes: r.reminderOffsetMinutes }));
  return emptyExternalScheduleForm().notificationRules;
}

async function openEditExternalSchedule(scheduleId, renderTrainingLoad) {
  const data = await loadExternalScheduleDetail(scheduleId).catch(() => null);
  if (!data) return;
  const { schedule, targets } = data;
  const timezone = schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const form = emptyExternalScheduleForm({
    editingScheduleId: schedule.id,
    eventName: schedule.eventName,
    eventType: schedule.eventType || "",
    eventNote: schedule.eventNote || "",
    scheduleKind: schedule.scheduleKind === "recurring" ? "daily" : schedule.scheduleKind === "dates" ? "specific_dates" : "one_time",
    startDate: schedule.startDate,
    endDate: schedule.endDate || schedule.startDate,
    // Fixed, read-only in edit mode - see renderExternalScheduleReadOnlyDatesHtml.
    datesList: schedule.scheduleKind === "dates" ? (schedule.dates || []) : [],
    opensTime: (schedule.opensTime || "").slice(0, 5),
    closesTime: (schedule.closesTime || "").slice(0, 5),
    timezone,
    calendarOpen: false,
    calendarMonth: localMonthIsoInTimeZone(timezone),
    notificationRules: notificationRulesFromApi(data.notificationRules),
  });
  applyTargetsToForm(form, targets);
  state.trainingLoad.scheduleForm = form;
  state.trainingLoad.scheduleDetail = null;
  renderTrainingLoad();
  void loadTrainingLoadOrgPickerData().then(renderTrainingLoad).catch(() => {});
}

async function openExternalScheduleAgain(scheduleId, renderTrainingLoad) {
  const data = await loadExternalScheduleDetail(scheduleId).catch(() => null);
  if (!data) return;
  const { schedule, targets } = data;
  const timezone = schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const form = emptyExternalScheduleForm({
    scheduleAgainFromId: schedule.id,
    eventName: schedule.eventName,
    eventType: schedule.eventType || "",
    eventNote: schedule.eventNote || "",
    // A fresh pick, deliberately never pre-filled from schedule.dates -
    // "Schedule again... requires new dates" (never reuses the source's
    // own dates), matching how startDate is left blank below too.
    scheduleKind: schedule.scheduleKind === "recurring" ? "daily" : schedule.scheduleKind === "dates" ? "specific_dates" : "one_time",
    opensTime: (schedule.opensTime || "").slice(0, 5),
    closesTime: (schedule.closesTime || "").slice(0, 5),
    timezone,
    calendarOpen: true,
    calendarMonth: localMonthIsoInTimeZone(timezone),
    notificationRules: notificationRulesFromApi(data.notificationRules),
  });
  // Hardening correction (item 1): this used to be missing entirely - the
  // form opened with every recipient checkbox blank, so it never actually
  // showed what was about to be copied, and the coach had to re-pick
  // recipients from scratch even to keep the SAME ones. The source's own
  // targets still go through the same re-validation as any other change
  // once submitted (see the backend route) - this only pre-fills the form.
  applyTargetsToForm(form, targets);
  state.trainingLoad.scheduleForm = form;
  state.trainingLoad.scheduleDetail = null;
  renderTrainingLoad();
  void loadTrainingLoadOrgPickerData().then(renderTrainingLoad).catch(() => {});
}

// ------------------------------------------------------------
// Today tab: OUTSIDE PLAN group detail + manual reminder selection.
// ------------------------------------------------------------

function currentTodayGroupSessionsForActions(scheduleId) {
  const open = state.trainingLoad.todayGroupDetail;
  if (!open) return [];
  const day = state.trainingLoad.weekly.today.data?.days.find((d) => d.date === open.date);
  return (day?.sessions || []).filter((s) => s.source === "scheduled_external" && s.scheduleId === scheduleId);
}

// Same fingerprint-based self-correction as training-load-view.js's own
// externalReminderSelectedSet - a stale selection (someone rated since, or
// the group's own set moved on) resets to "everyone still pending" the
// next time this is read, rather than silently keeping a dead assignment
// id selected.
function currentExternalReminderSelection(scheduleId) {
  const sessions = currentTodayGroupSessionsForActions(scheduleId);
  const pending = sessions.filter((s) => !s.rated);
  const fingerprint = pending.map((s) => s.externalAssignmentId).sort().join(",");
  const saved = state.trainingLoad.reminderSelection[scheduleId];
  const ids = saved && saved.fingerprint === fingerprint ? saved.ids.slice() : pending.map((s) => s.externalAssignmentId);
  return { ids, fingerprint };
}

async function sendExternalReminder(scheduleId, renderTrainingLoad) {
  const { ids } = currentExternalReminderSelection(scheduleId);
  if (!ids.length || state.trainingLoad.remindingScheduleId) return;
  state.trainingLoad.remindingScheduleId = scheduleId;
  renderTrainingLoad();
  try {
    const result = await sendExternalScheduleReminder(scheduleId, ids);
    state.trainingLoad.reminderResult = {
      scheduleId,
      message: `${result.notifiedCount} notified${result.noUserCount ? `, ${result.noUserCount} skipped (no linked account)` : ""}.`,
    };
    delete state.trainingLoad.reminderSelection[scheduleId];
  } catch (error) {
    state.trainingLoad.reminderResult = { scheduleId, message: error.message || "Could not send the reminder." };
  }
  state.trainingLoad.remindingScheduleId = "";
  renderTrainingLoad();
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

// Correction: reuses training-load-view.js's own trainingLoadFilterVisibleAthletes
// (the workspace-scoped orgPickerData roster, search-filtered) instead of
// re-deriving a second, independent (and previously wrong) athlete list
// here - one source of truth for "which athletes does this picker
// currently show", so Select all can never select something the render
// path itself wouldn't have offered.
function selectAllFilter(kind) {
  const orgData = state.trainingLoad.orgPickerData;
  if (kind === "club") {
    state.trainingLoad.filter.clubIds = (orgData?.clubs || []).map((c) => c.id);
  } else if (kind === "team") {
    state.trainingLoad.filter.teamIds = (orgData?.teams || []).map((t) => t.id);
  } else {
    state.trainingLoad.filter.athleteIds = trainingLoadFilterVisibleAthletes().map((a) => a.id);
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
// Matches by EITHER sessionId (planned) or externalAssignmentId (outside
// plan) - the two are mutually exclusive per row (mirrors the XOR identity
// on training_load.session_feedback), so a single `id` param unambiguously
// identifies exactly one session/assignment either way.
function findAthleteSessionById(id) {
  const todayMatch = state.trainingLoad.athleteToday.sessions.find((s) => s.sessionId === id || s.externalAssignmentId === id);
  if (todayMatch) return { session: todayMatch, date: state.trainingLoad.athleteToday.date };
  const weeklyDays = state.trainingLoad.athleteWeekly.data?.days || [];
  for (const day of weeklyDays) {
    const match = day.sessions.find((s) => s.sessionId === id || s.externalAssignmentId === id);
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
function openRpeFormForSessionId(id) {
  const found = findAthleteSessionById(id);
  if (!found || found.session.rated) return;
  const { session, date } = found;
  state.trainingLoad.showSessionList = false;
  state.trainingLoad.rpeForm = emptyRpeForm({
    sessionId: session.sessionId || "",
    externalAssignmentId: session.externalAssignmentId || "",
    source: session.source || "planned",
    sessionName: session.sessionName,
    amPm: session.amPm,
    bta: session.bta,
    sessionTime: session.sessionTime,
    date,
  });
}

// External invitation/reminder/manual-reminder notification click (athlete
// side) - deep-links straight to the athlete's own RPE form for that exact
// assignment, same as tapping it from Home would (mirrors tests-actions.js's
// own openAssignment for the WELLNESS equivalent). Notification clicks can
// happen before Home's own data has ever been fetched this session (e.g.
// straight after login), so this always fetches fresh first - today, then
// (only if not found there) the athlete's own weekly overlay, for a
// slightly stale notification pointing at an earlier day.
export async function openExternalAssignmentFromNotification(assignmentId) {
  await loadTrainingLoadAthleteToday();
  if (!findAthleteSessionById(assignmentId)) {
    await loadTrainingLoadAthleteWeekly();
  }
  openRpeFormForSessionId(assignmentId);
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
    const result = form.source === "scheduled_external"
      ? await submitExternalRpe(form.externalAssignmentId, { rpe: form.rpe, durationMinutes: Number(form.durationMinutes), note: form.note })
      : await submitRpe(form.sessionId, { rpe: form.rpe, durationMinutes: Number(form.durationMinutes), note: form.note });
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

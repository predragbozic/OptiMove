import { emptyExternalScheduleDetail, emptyExternalScheduleForm, emptyRpeForm, emptyTrainingLoadAnalysisState, emptyTrainingLoadFilter, emptyTrainingLoadFilterPicker, state } from "./state.js";
import { addDaysIso, addMonthsIso, localDateIsoInTimeZone, localMonthIsoInTimeZone, monthStartIso, weekMondayIso } from "./utils.js";
import {
  captureTrainingLoadAthleteWeeklyMutationContext,
  captureTrainingLoadWeeklyMutationContext,
  createExternalSchedule,
  invalidateAllTrainingLoadWeeklyGenerations,
  invalidateTrainingLoadAthleteWeeklyContext,
  invalidateTrainingLoadWeeklyContext,
  loadExternalScheduleDetail,
  loadPlannedRpeSetting,
  loadTrainingLoadAthleteToday,
  loadTrainingLoadAthleteWeekly,
  loadTrainingLoadOrgPickerData,
  loadTrainingLoadWeekly,
  resolvePlanOwnership,
  savePlannedRpeSetting,
  scheduleExternalAgain,
  sendExternalScheduleReminder,
  setExternalScheduleStatus,
  submitRpe,
  submitExternalRpe,
  toggleSessionRpeEnabled,
  toggleSessionTrainingLoadEnabled,
  trainingLoadMutationContextIsCurrentWorkspace,
  updateExternalSchedule,
} from "./training-load-data.js";
import {
  addAnalysisSeries,
  archiveAnalysisDashboard,
  cancelAnalysisLayoutDraft,
  cloneAnalysisDashboard,
  createAnalysisDashboard,
  createAnalysisWidget,
  deleteAnalysisSeries,
  deleteAnalysisWidget,
  ensureAnalysisLayoutDraft,
  invalidateTrainingLoadAnalysis,
  loadAnalysisMetricDefinitions,
  loadDashboardDetail,
  loadTrainingLoadAnalysis,
  moveAnalysisWidgetMobile,
  nudgeAnalysisWidget,
  queryAnalysisDashboard,
  reorderAnalysisSeries,
  resizeAnalysisWidget,
  resolveAnalysisSeries,
  saveAnalysisLayout,
  setActiveAnalysisDashboard,
  updateAnalysisDashboardMetadata,
  updateAnalysisLayoutDraft,
  updateAnalysisSeries,
  updateAnalysisWidget,
} from "./training-load-analysis-data.js";
import {
  captureTrainingLoadCalendarMutationContext,
  invalidateAllTrainingLoadCalendarGenerations,
  invalidateTrainingLoadCalendarContext,
  loadActivityDetail,
  loadCalendarMetricDefinitions,
  loadTrainingLoadCalendarMonth,
  loadTrainingLoadCalendarWeek,
} from "./training-load-calendar-data.js";
import { externalCalendarMode, externalScheduleSubmitDisabled, externalScheduleSubmitLabel, isRpeFormValid, renderRpeSliderInnerHtml, trainingLoadFilterVisibleAthletes } from "./training-load-view.js";

let analysisLayoutPointer = null;

function analysisLayoutCanEdit() {
  const a = state.trainingLoad.analysis;
  return state.trainingLoad.section === "analysis" && a.editMode && a.dashboard && a.dashboard.status !== "archived" && !a.dashboard.is_template && !a.saving;
}

function analysisLayoutMetrics() {
  const grid = document.querySelector(".tl-analysis-grid");
  const rect = grid?.getBoundingClientRect?.();
  const width = Number(rect?.width) || 960;
  return { column: Math.max(1, (width - 110) / 12), row: 56 };
}

export function handleTrainingLoadAnalysisPointerDown(event, renderTrainingLoad) {
  if (!analysisLayoutCanEdit()) return false;
  const target = event.target.closest?.("[data-analysis-drag-handle], [data-analysis-resize-handle]");
  const widgetId = target?.closest?.("[data-analysis-widget-id]")?.dataset.widgetId;
  if (!target || !widgetId) return false;
  const entry = ensureAnalysisLayoutDraft().find((item) => item.widgetId === widgetId);
  if (!entry) return false;
  analysisLayoutPointer = {
    pointerId: event.pointerId,
    mode: target.matches("[data-analysis-resize-handle]") ? "resize" : "drag",
    widgetId,
    startX: event.clientX,
    startY: event.clientY,
    initial: { ...entry },
    captureTarget: target,
    renderTrainingLoad,
  };
  try {
    target.setPointerCapture?.(event.pointerId);
  } catch {
    // A detached target can reject capture during a fast rerender; document listeners still finish the gesture.
  }
  event.preventDefault();
  return true;
}

export function handleTrainingLoadAnalysisPointerMove(event) {
  const pointer = analysisLayoutPointer;
  if (!pointer || pointer.pointerId !== event.pointerId) return false;
  const metrics = analysisLayoutMetrics();
  const dx = Math.round((event.clientX - pointer.startX) / metrics.column);
  const dy = Math.round((event.clientY - pointer.startY) / metrics.row);
  if (pointer.mode === "resize") {
    updateAnalysisLayoutDraft(pointer.widgetId, {
      width: Math.max(1, Math.min(12, Number(pointer.initial.width || 1) + dx)),
      height: Math.max(1, Number(pointer.initial.height || 1) + dy),
    });
  } else {
    updateAnalysisLayoutDraft(pointer.widgetId, {
      x: Math.max(0, Math.min(11, Number(pointer.initial.x || 0) + dx)),
      y: Math.max(0, Number(pointer.initial.y || 0) + dy),
    });
  }
  pointer.renderTrainingLoad?.();
  event.preventDefault();
  return true;
}

export function handleTrainingLoadAnalysisPointerEnd(event) {
  if (!analysisLayoutPointer || (event?.pointerId != null && analysisLayoutPointer.pointerId !== event.pointerId)) return false;
  try {
    analysisLayoutPointer.captureTarget?.releasePointerCapture?.(analysisLayoutPointer.pointerId);
  } catch {
    // The pointer may already have been released by the browser.
  }
  analysisLayoutPointer = null;
  return true;
}

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
    // Correction round 2: the athlete weekly CACHE entry is already
    // dropped unconditionally at submit time (submitRpeForm below) -
    // regardless of whether the overlay happens to be open right now, so
    // a LATER open (this session, within the TTL) can never read a stale
    // pre-submit payload. This handler only needs to actually re-fetch and
    // repaint the overlay if it's visible right now - there's nothing to
    // show a reload for otherwise.
    if (hadSaved) {
      await loadTrainingLoadAthleteToday();
      if (state.trainingLoad.athleteWeeklyOpen) {
        await loadTrainingLoadAthleteWeekly();
      }
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
    // perf: opens and paints immediately (cached data if this exact week
    // was already viewed this session, or the shell + loading state
    // otherwise) via the onPainted callback - never waits on the network
    // just to show the overlay itself.
    state.trainingLoad.athleteWeeklyOpen = true;
    renderTrainingLoad();
    await loadTrainingLoadAthleteWeekly(renderTrainingLoad);
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
    renderTrainingLoad();
    await loadTrainingLoadAthleteWeekly(renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-athlete-weekly-today") {
    const nav = state.trainingLoad.athleteWeekly;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const today = localDateIsoInTimeZone(timezone);
    nav.weekStart = weekMondayIso(today);
    nav.selectedDate = today;
    renderTrainingLoad();
    await loadTrainingLoadAthleteWeekly(renderTrainingLoad);
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
    const section = state.trainingLoad.section;
    // Correction round 2 (gap 1): captured BEFORE the request - a week-nav
    // click, filter confirm, or section switch while this toggle (and its
    // possible confirm-and-retry round trip below) is in flight must never
    // change WHICH cached entry gets dropped once the response lands (see
    // captureTrainingLoadWeeklyMutationContext's own header).
    const mutationContext = captureTrainingLoadWeeklyMutationContext(section);
    // Calendar (item 10) — its own independent week nav, captured
    // separately: a toggle fired from Schedule must still invalidate
    // whatever week the Calendar tab currently shows, even though the two
    // tabs' own weekStart values are otherwise fully decoupled.
    const calendarMutationContext = captureTrainingLoadCalendarMutationContext();
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
    // A just-toggled session must reflect the new state immediately,
    // never a stale pre-toggle flash from cache. Scoped to just this one
    // session's own week (across every cached filter variant of it - see
    // invalidateTrainingLoadWeeklyContext's own header) - see
    // invalidateAllTrainingLoadWeeklyGenerations's own header for when a
    // WIDER invalidation is required instead. Correction round 3 (gap 3):
    // gated on the captured identity still being the CURRENT workspace -
    // a workspace switch mid-flight already fully reset everything for
    // the new workspace on its own (resetTrainingLoadForWorkspaceChange),
    // so invalidating/reloading here again, under a since-changed
    // context, would be redundant at best and a pointless extra fetch for
    // an unrelated workspace at worst.
    //
    // Correction round 4: the RELOAD below deliberately targets
    // state.trainingLoad.section read FRESH here (current, at reload
    // time), never the captured `section` this toggle actually started
    // from - if the coach has since switched to a different tab while the
    // PATCH was in flight, the view that needs refreshing is whichever
    // one is now VISIBLE, not the one the toggle happened to be clicked
    // from. invalidateTrainingLoadWeeklyContext above still correctly
    // uses the CAPTURED mutationContext (the mutation's own real, original
    // effect never moves just because the coach looked away) - only the
    // reload TARGET changes. Reproduced bug this fixes: Schedule's own
    // toggle invalidates the shared cache for its week across every
    // filter (gap 1's own fix) - if the coach switched to Today and
    // confirmed a new filter in the meantime, THAT filter-confirm's own
    // request could get invalidated too and discarded as stale; reloading
    // "schedule" here (the old, captured section, possibly not even
    // visible anymore) never touched Today's own now-empty nav at all -
    // see loadTrainingLoadWeeklyInto's own "invalidated-stale" self-heal
    // in training-load-data.js for the other half of this fix.
    const currentSection = state.trainingLoad.section;
    if (trainingLoadMutationContextIsCurrentWorkspace(mutationContext)) {
      invalidateTrainingLoadWeeklyContext(mutationContext);
      await loadTrainingLoadWeekly(currentSection, renderTrainingLoad);
    }
    if (trainingLoadMutationContextIsCurrentWorkspace(calendarMutationContext)) {
      invalidateTrainingLoadCalendarContext(calendarMutationContext);
    }
    renderTrainingLoad();
    return true;
  }

  // Training Activity Integration 2A: the OTHER half of the split
  // decision - "track this session in Training Load" at all. Same
  // confirm-before-disable contract, same cache-invalidation/reload
  // shape as training-load-toggle-session-rpe directly above (both
  // mutate the exact same plans.plan_sessions row, so both need the
  // exact same "which cached week entry to drop" care).
  if (type === "training-load-toggle-session-tracking") {
    const sessionId = action.dataset.sessionId;
    if (!sessionId) return true;
    const currentlyEnabled = action.dataset.currentlyEnabled === "true";
    const nextEnabled = !currentlyEnabled;
    const section = state.trainingLoad.section;
    const mutationContext = captureTrainingLoadWeeklyMutationContext(section);
    const calendarMutationContext = captureTrainingLoadCalendarMutationContext();
    try {
      await toggleSessionTrainingLoadEnabled(sessionId, nextEnabled);
    } catch (error) {
      if (error.status === 409 && error.message === "hasExistingResults") {
        if (!window.confirm("This session already has a recorded RPE result. Turning tracking off will also stop new RPE submissions, but the existing result stays in Results. Continue?")) {
          return true;
        }
        await toggleSessionTrainingLoadEnabled(sessionId, nextEnabled, true);
      } else {
        throw error;
      }
    }
    const currentSection = state.trainingLoad.section;
    if (trainingLoadMutationContextIsCurrentWorkspace(mutationContext)) {
      invalidateTrainingLoadWeeklyContext(mutationContext);
      await loadTrainingLoadWeekly(currentSection, renderTrainingLoad);
    }
    if (trainingLoadMutationContextIsCurrentWorkspace(calendarMutationContext)) {
      invalidateTrainingLoadCalendarContext(calendarMutationContext);
    }
    renderTrainingLoad();
    return true;
  }

  // -------------------- Coach: Today/Schedule/Results tabs --------------------

  if (type === "training-load-section") {
    state.trainingLoad.section = action.dataset.section;
    // perf: the tab strip itself (and whatever this section's own
    // nav.data already holds - real data from an earlier visit this
    // session, or nothing yet) paints INSTANTLY on the switch, never
    // waiting on a network round trip just to show which tab is now
    // selected. loadTrainingLoadWeekly repaints again on its own the
    // instant a cache hit/loading state/fresh response is available (see
    // its own onPainted parameter). Switching to a section that's asking
    // for the exact same (workspace, week, filter) another section already
    // has fresh in the shared cache (training-load-data.js) now genuinely
    // skips the network round trip too, not just the loading flash - see
    // that file's own header comment for the TTL-based rationale.
    renderTrainingLoad();
    // "today" is now the Calendar tab (item 3 - the internal section key
    // stays "today", only the visible label changed) - it reads its own
    // canonical-activity-shaped data (training-load-calendar-data.js), never
    // the RPE-session-shaped state.trainingLoad.weekly.today, which nothing
    // renders anymore for this tab. Schedule/Results are completely
    // unaffected - same loadTrainingLoadWeekly call as before.
    await Promise.all([
      state.trainingLoad.section === "today"
        ? loadTrainingLoadCalendarWeek(renderTrainingLoad)
        : state.trainingLoad.section === "analysis"
          ? loadTrainingLoadAnalysis(renderTrainingLoad)
          : loadTrainingLoadWeekly(state.trainingLoad.section, renderTrainingLoad),
      state.trainingLoad.section === "schedule" ? loadPlannedRpeSetting() : Promise.resolve(),
    ]);
    renderTrainingLoad();
    return true;
  }

  // -------------------- Training Load 3B3: Analysis dashboards --------------------

  if (type === "training-load-analysis-select-dashboard") {
    const dashboardId = action.value ?? action.dataset.dashboardId ?? "";
    const a = state.trainingLoad.analysis;
    a.selectedDashboardId = dashboardId;
    a.dashboard = null;
    a.widgets = [];
    a.queryResult = null;
    a.editMode = false;
    a.layoutDraft = null;
    renderTrainingLoad();
    if (dashboardId) {
      await loadDashboardDetail(dashboardId, renderTrainingLoad, { force: true });
      await queryAnalysisDashboard(renderTrainingLoad, { force: true });
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-focus-selector") {
    document.querySelector("[data-action='training-load-analysis-select-dashboard']")?.focus();
    return true;
  }
  if (type === "training-load-analysis-create") {
    const name = window.prompt("Dashboard name", "Training Load Analysis");
    if (!name || !name.trim()) return true;
    await createAnalysisDashboard({ name: name.trim() }, renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-clone-template") {
    const templateId = action.value || action.dataset.templateId;
    if (!templateId) return true;
    await cloneAnalysisDashboard(templateId, renderTrainingLoad);
    action.value = "";
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-toggle-edit") {
    const a = state.trainingLoad.analysis;
    a.editMode = !a.editMode;
    if (!a.editMode) {
      a.addWidgetOpen = false;
      a.editor = { open: false, widgetId: "", seriesId: "" };
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-set-active") {
    const dashboardId = state.trainingLoad.analysis.dashboard?.id || state.trainingLoad.analysis.selectedDashboardId;
    if (!dashboardId) return true;
    await setActiveAnalysisDashboard(dashboardId, renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-period-from" || type === "training-load-analysis-period-to") {
    const a = state.trainingLoad.analysis;
    if (type.endsWith("from")) a.period.dateFrom = action.value || a.period.dateFrom;
    else a.period.dateTo = action.value || a.period.dateTo;
    renderTrainingLoad();
    await queryAnalysisDashboard(renderTrainingLoad, { force: true });
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-runtime-activity" || type === "training-load-analysis-runtime-component") {
    const a = state.trainingLoad.analysis;
    const value = (action.value || "").trim();
    if (type.endsWith("activity")) a.runtimeFilter.activityId = value || null;
    else a.runtimeFilter.componentId = value || null;
    renderTrainingLoad();
    if (value && value.length < 36) return true;
    await queryAnalysisDashboard(renderTrainingLoad, { force: true });
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-add-widget") {
    state.trainingLoad.analysis.addWidgetOpen = true;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-close-add-widget") {
    state.trainingLoad.analysis.addWidgetOpen = false;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-create-widget") {
    state.trainingLoad.analysis.addWidgetOpen = false;
    await createAnalysisWidget(action.dataset.widgetType, renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-save-layout") {
    await saveAnalysisLayout(renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-cancel-layout") {
    cancelAnalysisLayoutDraft();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-widget-left" || type === "training-load-analysis-widget-right" || type === "training-load-analysis-widget-up" || type === "training-load-analysis-widget-down") {
    const dx = type.endsWith("left") ? -1 : type.endsWith("right") ? 1 : 0;
    const dy = type.endsWith("up") ? -1 : type.endsWith("down") ? 1 : 0;
    nudgeAnalysisWidget(action.dataset.widgetId, dx, dy);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-widget-wider" || type === "training-load-analysis-widget-narrower") {
    resizeAnalysisWidget(action.dataset.widgetId, type.endsWith("wider") ? 1 : -1, 0);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-widget-mobile-up" || type === "training-load-analysis-widget-mobile-down") {
    moveAnalysisWidgetMobile(action.dataset.widgetId, type.endsWith("up") ? -1 : 1);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-edit-dashboard") {
    const current = state.trainingLoad.analysis.dashboard;
    const name = window.prompt("Dashboard name", current?.name || "");
    if (!name || !name.trim() || name.trim() === current?.name) return true;
    await updateAnalysisDashboardMetadata({ name: name.trim() }, renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-archive") {
    if (!window.confirm("Archive this dashboard? It will become read-only.")) return true;
    await archiveAnalysisDashboard(renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-edit-widget") {
    const widget = state.trainingLoad.analysis.widgets.find((w) => w.id === action.dataset.widgetId);
    state.trainingLoad.analysis.editor = { open: true, widgetId: action.dataset.widgetId, seriesId: widget?.series?.[0]?.id || "" };
    renderTrainingLoad();
    void loadAnalysisMetricDefinitions().then(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-analysis-close-editor") {
    state.trainingLoad.analysis.editor = { open: false, widgetId: "", seriesId: "" };
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-widget-title") {
    const title = (action.value || "").trim();
    if (title) await updateAnalysisWidget(action.dataset.widgetId, { title }, renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-widget-type") {
    await updateAnalysisWidget(action.dataset.widgetId, { widgetType: action.value }, renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-widget-group") {
    await updateAnalysisWidget(action.dataset.widgetId, { groupBy: action.value }, renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-widget-activity-filter" || type === "training-load-analysis-widget-component-filter") {
    const widget = state.trainingLoad.analysis.widgets.find((w) => w.id === action.dataset.widgetId);
    const current = { ...(widget?.local_filter_override || {}) };
    if (type.endsWith("activity-filter")) current.activityId = action.value || null;
    else current.componentId = action.value || null;
    for (const key of Object.keys(current)) if (current[key] === "" || current[key] === null) delete current[key];
    await updateAnalysisWidget(action.dataset.widgetId, { localFilterOverride: Object.keys(current).length ? current : null }, renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-delete-widget") {
    if (!window.confirm("Delete this widget?")) return true;
    await deleteAnalysisWidget(action.dataset.widgetId, renderTrainingLoad);
    state.trainingLoad.analysis.editor = { open: false, widgetId: "", seriesId: "" };
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-add-series") {
    await addAnalysisSeries(action.dataset.widgetId, { builtInSeriesKey: "rpe", dataScopeLevel: "session", analyticalAggregation: "avg" }, renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-select-series") {
    state.trainingLoad.analysis.editor.seriesId = action.dataset.seriesId;
    state.trainingLoad.analysis.selectedSeriesId = action.dataset.seriesId;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-series-bind-builtin") {
    if (action.dataset.seriesId) {
      await deleteAnalysisSeries(action.dataset.widgetId, action.dataset.seriesId, renderTrainingLoad);
    }
    await addAnalysisSeries(action.dataset.widgetId, { builtInSeriesKey: action.dataset.builtInKey }, renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-series-bind-metric") {
    if (action.dataset.seriesId) {
      await resolveAnalysisSeries(action.dataset.widgetId, action.dataset.seriesId, action.dataset.metricId, renderTrainingLoad);
    } else {
      await addAnalysisSeries(action.dataset.widgetId, { metricDefinitionId: action.dataset.metricId }, renderTrainingLoad);
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-series-up" || type === "training-load-analysis-series-down") {
    state.trainingLoad.analysis.selectedSeriesId = action.dataset.seriesId;
    await reorderAnalysisSeries(action.dataset.widgetId, type.endsWith("up") ? -1 : 1, renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-delete-series") {
    await deleteAnalysisSeries(action.dataset.widgetId, action.dataset.seriesId, renderTrainingLoad);
    state.trainingLoad.analysis.editor.seriesId = "";
    renderTrainingLoad();
    return true;
  }
  if (type?.startsWith("training-load-analysis-series-")) {
    const map = {
      "training-load-analysis-series-label": { key: "displayLabel", value: action.value || null },
      "training-load-analysis-series-axis": { key: "axis", value: action.value },
      "training-load-analysis-series-color": { key: "color", value: action.value || null },
      "training-load-analysis-series-scope": { key: "dataScopeLevel", value: action.value },
      "training-load-analysis-series-aggregation": { key: "analyticalAggregation", value: action.value },
      "training-load-analysis-series-source": { key: "sourcePolicy", value: action.value },
      "training-load-analysis-series-role": { key: "aggregationRolePolicy", value: action.value },
      "training-load-analysis-series-coverage": { key: "coveragePolicy", value: action.value },
      "training-load-analysis-series-comparison": { key: "comparisonPeriod", value: action.value || null },
    }[type];
    if (map) {
      await updateAnalysisSeries(action.dataset.widgetId, action.dataset.seriesId, { [map.key]: map.value }, renderTrainingLoad);
      renderTrainingLoad();
      return true;
    }
  }
  if (type === "training-load-analysis-metric-search") {
    state.trainingLoad.analysis.metricPicker.search = action.value ?? "";
    renderTrainingLoad();
    return true;
  }

  // -------------------- Coach: Schedule tab's own master toggle (v9) --------------------

  if (type === "training-load-toggle-planned-rpe-master") {
    const setting = state.trainingLoad.plannedRpeSetting;
    // Guards one save in flight at a time, and never allows a click
    // before the real current value has even loaded (see this control's
    // own `disabled` attribute in training-load-view.js) - never toggles
    // off of a stale/unknown starting value.
    if (setting.saving || !setting.loaded) return true;
    const nextEnabled = !setting.enabled;
    // Turning OFF pauses every pending planned-RPE request at once - a
    // real, consequential action (not just a display preference), so it
    // gets the same explicit confirm dialog Schedule's own external-
    // schedule Cancel action already uses, never a silent one-click flip.
    if (!nextEnabled && !window.confirm("Turn off automatic planned RPE? Any pending RPE requests from the Weekly Plan will be paused, right where they are - existing results stay saved and visible.")) {
      return true;
    }
    setting.saving = true;
    setting.error = "";
    renderTrainingLoad();
    try {
      const result = await savePlannedRpeSetting(nextEnabled);
      setting.enabled = result.enabled;
      setting.enabledAt = result.enabledAt;
      setting.saving = false;
      // Correction round 2 (gap 1): the workspace master toggle governs
      // EVERY plan/session's own effective actionability across every
      // week, not just whatever week/filter happens to be on screen right
      // now - a narrow, single-key invalidation would leave every OTHER
      // already-cached week (a coach who browsed several weeks this
      // session) showing a stale pre-toggle state until its own TTL
      // happens to expire. Wide invalidation (bump every generation +
      // clear the whole weekly cache namespace) so any later visit to any
      // week/filter is guaranteed a real, fresh fetch - then refreshes the
      // currently-visible rows immediately for instant feedback.
      invalidateAllTrainingLoadWeeklyGenerations();
      invalidateAllTrainingLoadCalendarGenerations();
      await loadTrainingLoadWeekly(state.trainingLoad.section, renderTrainingLoad);
    } catch (error) {
      setting.saving = false;
      setting.error = error.message || "Could not save this setting.";
    }
    renderTrainingLoad();
    return true;
  }

  // -------------------- Coach: unresolved-plan RPE ownership resolution (correction round 2) --------------------
  //
  // A legacy plan the backfill couldn't deterministically attribute
  // (owner_scope='unresolved') never becomes actionable just because the
  // master switch is ON - a coach must explicitly assign it a real
  // workspace first. Both the single-row "Use current workspace for RPE"
  // button and the bulk banner action call the SAME resolvePlanOwnership,
  // sharing one `resolvingOwnership` in-flight guard (there's only ever
  // one resolve control visible/clickable at a time in this view) and
  // reloading the weekly payload immediately on success so every
  // affected row's own status pill/badge updates right away.
  if (type === "training-load-resolve-plan-ownership" || type === "training-load-resolve-all-unresolved") {
    if (state.trainingLoad.resolvingOwnership) return true;
    const planIds = type === "training-load-resolve-plan-ownership"
      ? [action.dataset.planId].filter(Boolean)
      : (action.dataset.planIds || "").split(",").map((id) => id.trim()).filter(Boolean);
    if (!planIds.length) return true;
    if (type === "training-load-resolve-all-unresolved") {
      const label = planIds.length === 1 ? "this 1 plan" : `all ${planIds.length} plans`;
      if (!window.confirm(`Assign your current workspace as the RPE owner of ${label}? This only affects plans with no workspace assigned yet - it never changes a plan that's already assigned.`)) {
        return true;
      }
    }
    state.trainingLoad.resolvingOwnership = true;
    state.trainingLoad.resolveOwnershipError = "";
    renderTrainingLoad();
    try {
      await resolvePlanOwnership(planIds);
      state.trainingLoad.resolvingOwnership = false;
      // Correction round 2 (gap 1): a resolved plan's own sessions can
      // appear in MULTIPLE weeks (a plan spans exactly one week, but the
      // bulk action can resolve several plans at once, each its own week) -
      // wide invalidation, same reasoning as the master toggle above.
      // Refreshes the currently-visible rows immediately so a just-
      // resolved plan's own session(s) drop the "workspace not assigned"
      // badge right away.
      invalidateAllTrainingLoadWeeklyGenerations();
      invalidateAllTrainingLoadCalendarGenerations();
      await loadTrainingLoadWeekly(state.trainingLoad.section, renderTrainingLoad);
    } catch (error) {
      state.trainingLoad.resolvingOwnership = false;
      state.trainingLoad.resolveOwnershipError = error.message || "Could not assign this workspace.";
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
    // perf: the week label/nav updates instantly; loadTrainingLoadWeekly
    // paints again the instant it has something to show (cached data for
    // this week if already visited, or a loading state) via onPainted.
    renderTrainingLoad();
    await loadTrainingLoadWeekly(section, renderTrainingLoad);
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
    renderTrainingLoad();
    await loadTrainingLoadWeekly(section, renderTrainingLoad);
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

  // -------------------- Training Load Frontend 3A: Calendar --------------------

  if (type === "training-load-calendar-prev" || type === "training-load-calendar-next") {
    const cal = state.trainingLoad.calendar;
    const delta = type === "training-load-calendar-prev" ? -1 : 1;
    if (cal.monthMode) {
      cal.monthCursor = addMonthsIso(cal.monthCursor || cal.weekStart, delta);
      renderTrainingLoad();
      await loadTrainingLoadCalendarMonth(renderTrainingLoad);
    } else {
      cal.weekStart = addDaysIso(cal.weekStart, delta * 7);
      if (cal.selectedDate) cal.selectedDate = addDaysIso(cal.selectedDate, delta * 7);
      renderTrainingLoad();
      await loadTrainingLoadCalendarWeek(renderTrainingLoad);
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-today") {
    const cal = state.trainingLoad.calendar;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const today = localDateIsoInTimeZone(timezone);
    cal.weekStart = weekMondayIso(today);
    cal.selectedDate = today;
    cal.selectedActivityId = null;
    cal.selectedComponentId = null;
    if (cal.monthMode) cal.monthCursor = monthStartIso(today);
    renderTrainingLoad();
    await Promise.all([
      loadTrainingLoadCalendarWeek(renderTrainingLoad),
      cal.monthMode ? loadTrainingLoadCalendarMonth(renderTrainingLoad) : Promise.resolve(),
    ]);
    renderTrainingLoad();
    return true;
  }
  // Item 4: expanding/collapsing the calendar NEVER changes the current
  // selection — only the presentation (7-day strip vs. full month grid)
  // toggles; selectedDate/selectedActivityId are left completely alone.
  if (type === "training-load-calendar-toggle-month") {
    const cal = state.trainingLoad.calendar;
    cal.monthMode = !cal.monthMode;
    if (cal.monthMode) {
      if (!cal.monthCursor) cal.monthCursor = monthStartIso(cal.selectedDate || cal.weekStart);
      renderTrainingLoad();
      await loadTrainingLoadCalendarMonth(renderTrainingLoad);
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-select-day") {
    const cal = state.trainingLoad.calendar;
    const date = action.dataset.date;
    cal.selectedDate = date;
    // A new day resets any activity/component selection from a DIFFERENT
    // day — never leaves a stale "selected activity" pointing at a day
    // that's no longer on screen.
    cal.selectedActivityId = null;
    cal.selectedComponentId = null;
    const newWeekStart = weekMondayIso(date);
    if (newWeekStart !== cal.weekStart) {
      cal.weekStart = newWeekStart;
      renderTrainingLoad();
      await loadTrainingLoadCalendarWeek(renderTrainingLoad);
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-select-activity") {
    const cal = state.trainingLoad.calendar;
    const activityId = action.dataset.activityId;
    if (!activityId) return true;
    cal.selectedActivityId = activityId;
    cal.selectedComponentId = null;
    cal.activityDetailTab = "overview";
    cal.metricPicker.selectedIds = null;
    cal.resultsSort = { column: "athlete", direction: "asc" };
    // Item 4 (mobile): after picking a specific activity, an EXPANDED
    // month grid collapses back to the 7-day strip to leave room for
    // results — never on desktop/tablet, and the user can always
    // re-expand via the same toggle.
    if (cal.monthMode && window.matchMedia && window.matchMedia("(max-width: 640px)").matches) {
      cal.monthMode = false;
    }
    renderTrainingLoad();
    // Fired alongside (not awaited before) the activity fetch — memoized
    // per workspace (loadCalendarMetricDefinitions's own header), so this
    // is a real network request only the FIRST time an activity is opened
    // this visit. Without this, the results table's default columns would
    // show generic "Metric" placeholders (no real label/unit/icon) until
    // the coach happened to open the metric picker at least once.
    void loadCalendarMetricDefinitions().then(renderTrainingLoad);
    await loadActivityDetail(activityId, renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-clear-activity") {
    const cal = state.trainingLoad.calendar;
    cal.selectedActivityId = null;
    cal.selectedComponentId = null;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-select-detail-tab") {
    state.trainingLoad.calendar.activityDetailTab = action.dataset.tlCalendarDetailTab;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-select-component") {
    const cal = state.trainingLoad.calendar;
    cal.selectedComponentId = action.dataset.componentId || null;
    cal.resultsSort = { column: "athlete", direction: "asc" };
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-select-athlete") {
    state.trainingLoad.calendar.selectedResultsAthleteId = action.dataset.athleteId;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-close-athlete") {
    state.trainingLoad.calendar.selectedResultsAthleteId = null;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-sort") {
    const sort = state.trainingLoad.calendar.resultsSort;
    const column = action.dataset.column;
    sort.direction = sort.column === column && sort.direction === "asc" ? "desc" : "asc";
    sort.column = column;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-view-conflict") {
    try {
      state.trainingLoad.calendar.conflictValues = JSON.parse(action.dataset.values || "[]");
    } catch {
      state.trainingLoad.calendar.conflictValues = [];
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-conflict-close") {
    state.trainingLoad.calendar.conflictValues = null;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-metric-picker-open") {
    const picker = state.trainingLoad.calendar.metricPicker;
    picker.open = true;
    renderTrainingLoad();
    await loadCalendarMetricDefinitions();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-metric-picker-close") {
    state.trainingLoad.calendar.metricPicker.open = false;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-calendar-metric-toggle") {
    const picker = state.trainingLoad.calendar.metricPicker;
    const metricId = action.dataset.metricId;
    if (!metricId) return true;
    // The FIRST toggle interaction materializes `selectedIds` out of
    // whatever the smart default currently implies (see
    // pickedMetricColumns in training-load-calendar-view.js), so unchecking
    // one metric never silently discards every other one that was showing
    // by default a moment ago.
    if (picker.selectedIds === null) {
      const cal = state.trainingLoad.calendar;
      const detail = cal.activityDetail.data;
      const currentIds = new Set();
      if (detail) {
        for (const f of detail.facts) if (f.factKind === "metric_value") currentIds.add(f.detail.metricDefinitionId);
      }
      picker.selectedIds = currentIds.size <= 4 ? [...currentIds] : [];
    }
    const idx = picker.selectedIds.indexOf(metricId);
    if (idx >= 0) picker.selectedIds.splice(idx, 1);
    else picker.selectedIds.push(metricId);
    renderTrainingLoad();
    return true;
  }

  // -------------------- Coach: Club/Team/Athletes filter picker --------------------

  if (type === "training-load-filter-open") {
    // perf: opens the panel IMMEDIATELY - it used to await the org-picker
    // fetch first, so the whole panel stayed closed for that entire round
    // trip on a coach's first-ever open this session (every later open is
    // already instant, since loadTrainingLoadOrgPickerData caches its own
    // result in state.trainingLoad.orgPickerData for the session). The
    // picker's own render (renderFilterTabPanelHtml) shows an explicit
    // loading message while orgPickerData is still null, never a
    // silently-empty "No clubs/teams/athletes available" that looks like
    // a real, final answer.
    state.trainingLoad.filterSnapshotAtOpen = { ...state.trainingLoad.filter, clubIds: [...state.trainingLoad.filter.clubIds], teamIds: [...state.trainingLoad.filter.teamIds], athleteIds: [...state.trainingLoad.filter.athleteIds] };
    state.trainingLoad.filterPicker.open = true;
    renderTrainingLoad();
    await loadTrainingLoadOrgPickerData().catch(() => {});
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
    if (state.trainingLoad.section === "analysis") {
      invalidateTrainingLoadAnalysis();
      state.trainingLoad.analysis.queryResult = null;
      await loadTrainingLoadAnalysis(renderTrainingLoad);
      renderTrainingLoad();
      return true;
    }
    await loadTrainingLoadWeekly(state.trainingLoad.section, renderTrainingLoad);
    // Calendar (item 2's own "workspace and athlete/team filters"
    // requirement): the Calendar tab shares this exact Filter control but
    // reads a wholly separate state slice/cache (state.trainingLoad.calendar,
    // never state.trainingLoad.weekly) - without this, confirming a filter
    // while on Calendar silently did nothing to it at all. Gated on
    // `cal.weekStart` (only set once the Calendar has actually been opened
    // this session) so this stays a true no-op whenever Calendar has never
    // been visited - both in production (nothing to refresh yet) and for
    // every OLDER test in this suite that only ever exercises the
    // weekly-cache-backed Schedule/Results sections and never touches
    // state.trainingLoad.calendar at all. A previously-selected activity/
    // component may no longer be visible under the new filter, so that
    // selection is cleared exactly like a workspace switch already does
    // (resetTrainingLoadForWorkspaceChange's own reasoning).
    const cal = state.trainingLoad.calendar;
    if (cal.weekStart) {
      cal.data = null;
      cal.monthData = null;
      cal.selectedActivityId = null;
      cal.selectedComponentId = null;
      cal.selectedResultsAthleteId = null;
      cal.activityDetail = { activityId: null, data: null, loading: false, error: "" };
      renderTrainingLoad();
      await Promise.all([
        loadTrainingLoadCalendarWeek(renderTrainingLoad),
        cal.monthMode ? loadTrainingLoadCalendarMonth(renderTrainingLoad) : Promise.resolve(),
      ]);
    }
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
    // Correction round 2 (gap 1): this used to refresh only the detail
    // overlay, never the weekly cache at all - a paused/resumed/cancelled
    // schedule changes future occurrence generation and actionability
    // across every week it could still appear in, not just whichever week
    // happens to be on screen. Wide invalidation, then refresh both the
    // detail overlay and the currently-visible weekly view so its own rows
    // (Schedule's own management view, and Today's grouped rows) reflect
    // the new status immediately.
    invalidateAllTrainingLoadWeeklyGenerations();
    invalidateAllTrainingLoadCalendarGenerations();
    await Promise.all([
      openExternalScheduleDetail(scheduleId, renderTrainingLoad),
      loadTrainingLoadWeekly(state.trainingLoad.section, renderTrainingLoad),
    ]);
    return true;
  }

  // -------------------- Results tab: per-athlete drilldown (item 3) --------------------
  // A pure UI selection over the already-loaded weekly.results payload -
  // never a fetch, never touches state.trainingLoad.filter (see training-
  // load-view.js's own comment on filterWeeklyDataToAthlete for why).

  if (type === "training-load-results-open-athlete") {
    state.trainingLoad.resultsAthleteId = action.dataset.athleteId;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-results-close-athlete") {
    state.trainingLoad.resultsAthleteId = null;
    renderTrainingLoad();
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
    // Correction round 2 (gap 1): a create/edit/schedule-again can be a
    // recurring or multi-date (specific_dates) schedule spanning several
    // weeks, not just the one currently on screen - a narrow, single-week
    // invalidation would leave every OTHER already-cached week showing
    // stale pre-save rows. Wide invalidation unconditionally (simpler and
    // safer than branching on scheduleKind), then refresh the current
    // section immediately for instant feedback.
    invalidateAllTrainingLoadWeeklyGenerations();
    invalidateAllTrainingLoadCalendarGenerations();
    await loadTrainingLoadWeekly(state.trainingLoad.section, renderTrainingLoad);
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
  // Correction round 3 (gap 2): captured BEFORE the request, from the
  // session/assignment's own actual date (form.date - set for BOTH
  // planned and outside-plan/external forms by openRpeFormForSessionId in
  // this same file), never from state.trainingLoad.athleteWeekly.weekStart.
  // The overlay's own last-viewed week and the week the RATED SESSION IS
  // IN are two different things - Home can open the form for a not-yet-
  // rated session from ANY earlier day, regardless of which week (if any)
  // the overlay was browsed to and closed on beforehand. Using the
  // overlay's own weekStart here invalidated the WRONG week's cache entry
  // whenever they diverged, leaving the actually-affected week's entry
  // stale.
  const athleteWeeklyContext = captureTrainingLoadAthleteWeeklyMutationContext(form.date);
  try {
    const result = form.source === "scheduled_external"
      ? await submitExternalRpe(form.externalAssignmentId, { rpe: form.rpe, durationMinutes: Number(form.durationMinutes), note: form.note })
      : await submitRpe(form.sessionId, { rpe: form.rpe, durationMinutes: Number(form.durationMinutes), note: form.note });
    form.saving = false;
    form.savedFeedback = result.feedback;
    // Correction round 2 (gap 3) + round 3 (gap 3): drop the athlete
    // weekly cache entry for the session's own actual week UNCONDITIONALLY
    // on a successful submit, never only when the overlay happens to be
    // open - a submit from Home (the overlay closed) must never leave an
    // earlier-loaded weekly cache entry stale for a LATER open this
    // session (within the cache's own TTL) to read back. Gated on the
    // captured identity still being the CURRENT workspace, same reasoning
    // as the session RPE toggle above.
    if (trainingLoadMutationContextIsCurrentWorkspace(athleteWeeklyContext)) {
      invalidateTrainingLoadAthleteWeeklyContext(athleteWeeklyContext);
    }
    // Calendar (item 10): the acting identity here is the ATHLETE, not any
    // particular coach — there is no single coach workspace context to
    // capture at this mutation site the way the coach-side toggles above
    // can. A real submit can materialize a brand-new training.activity
    // (see trainingActivityMaterialize.js), which any coach who manages
    // this athlete could be looking at right now — wide invalidation, same
    // "can't narrow the blast radius, so don't guess" reasoning as the
    // workspace master toggle above.
    invalidateAllTrainingLoadCalendarGenerations();
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
  invalidateAllTrainingLoadCalendarGenerations();
  for (const key of Object.keys(state.trainingLoad.weekly)) {
    state.trainingLoad.weekly[key].data = null;
    state.trainingLoad.weekly[key].error = "";
    state.trainingLoad.weekly[key].loading = false;
  }
  // Calendar (item 10): the OLD workspace's own week/month/activity-detail
  // data, and any activity/component/athlete selection made under it, must
  // never survive into the new workspace — a stale selection pointing at
  // an activityId the new workspace may not even be authorized to see is
  // worse than just resetting to "no selection".
  const cal = state.trainingLoad.calendar;
  cal.data = null; cal.error = ""; cal.loading = false;
  cal.monthMode = false; cal.monthData = null; cal.monthError = ""; cal.monthLoading = false; cal.monthCursor = "";
  cal.selectedActivityId = null; cal.selectedComponentId = null; cal.selectedResultsAthleteId = null;
  cal.activityDetail = { activityId: null, data: null, loading: false, error: "" };
  cal.metricPicker = { open: false, search: "", selectedIds: null, definitions: null, loading: false, error: "" };
  invalidateTrainingLoadAnalysis();
  state.trainingLoad.analysis = emptyTrainingLoadAnalysisState();
  state.trainingLoad.athleteWeekly.data = null;
  state.trainingLoad.athleteWeekly.error = "";
  state.trainingLoad.athleteWeekly.loading = false;
  state.trainingLoad.filter = emptyTrainingLoadFilter();
  state.trainingLoad.filterPicker = emptyTrainingLoadFilterPicker();
  state.trainingLoad.filterSnapshotAtOpen = null;
  state.trainingLoad.orgPickerData = null;
  // (v9) The OLD workspace's own enabled/enabledAt must never keep
  // showing (even briefly) once a switch has started - `loaded: false`
  // puts the toggle control back into its disabled "not yet known" state
  // until the new workspace's own fresh GET lands.
  state.trainingLoad.plannedRpeSetting = { enabled: false, enabledAt: null, loaded: false, loading: false, saving: false, error: "" };
}

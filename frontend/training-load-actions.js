import { emptyExternalScheduleDetail, emptyExternalScheduleForm, emptyGpexeImportState, emptyRpeForm, emptyTrainingLoadAnalysisState, emptyTrainingLoadFilter, emptyTrainingLoadFilterPicker, state } from "./state.js";
import { handleGpexeImportAction } from "./gpexe-import-actions.js";
import { loadGpexeImports } from "./gpexe-import-data.js";
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
  setExternalScheduleStatus,
  submitRpe,
  submitExternalRpe,
  toggleSessionRpeEnabled,
  toggleSessionTrainingLoadEnabled,
  trainingLoadMutationContextIsCurrentWorkspace,
  updateExternalSchedule,
} from "./training-load-data.js";
import {
  BUILT_IN_FIXED_SCOPE,
  BUILT_IN_SERIES,
  addEditorSeries,
  analysisEditorIsDirty,
  applyAnalysisPeriodPreset,
  archiveAnalysisDashboard,
  deleteAnalysisDashboard,
  cancelAnalysisLayoutDraft,
  cloneAnalysisDashboard,
  closedAnalysisWidgetEditor,
  createAnalysisDashboard,
  deleteAnalysisWidget,
  editorSeriesEntry,
  emptyAnalysisMetricPanel,
  ensureAnalysisLayoutDraft,
  invalidateTrainingLoadAnalysis,
  loadAnalysisMetricDefinitions,
  loadDashboardDetail,
  loadTrainingLoadAnalysis,
  moveAnalysisWidgetMobile,
  moveEditorSeries,
  nudgeAnalysisWidget,
  openAnalysisWidgetEditor,
  queryAnalysisDashboard,
  removeEditorSeries,
  resizeAnalysisWidget,
  saveAnalysisLayout,
  saveAnalysisMetricPanel,
  saveAnalysisWidgetEditor,
  setActiveAnalysisDashboard,
  setEditorSeriesMetric,
  setEditorWidgetType,
  setMetricPanelMetric,
  updateAnalysisDashboardMetadata,
  updateAnalysisLayoutDraft,
} from "./training-load-analysis-data.js";
import {
  captureTrainingLoadCalendarMutationContext,
  invalidateAllTrainingLoadCalendarGenerations,
  invalidateTrainingLoadCalendarContext,
  loadActivityDetail,
  loadCalendarMetricDefinitions,
  loadOverviewCoverage,
  loadResultsAthleteActivities,
  loadTrainingLoadCalendarMonth,
  loadTrainingLoadCalendarWeek,
} from "./training-load-calendar-data.js";
import { externalCalendarMode, externalScheduleSubmitDisabled, externalScheduleSubmitLabel, isRpeFormValid, renderRpeSliderInnerHtml, trainingLoadFilterVisibleAthletes } from "./training-load-view.js";

let analysisLayoutPointer = null;
let analysisLayoutWindowCleanup = null;

function analysisEventPointerId(event) {
  return event?.pointerId ?? event?.pointerIdFallback ?? "mouse";
}

function analysisPointerEventMatches(pointer, event) {
  const eventPointerId = analysisEventPointerId(event);
  if (pointer.pointerId === eventPointerId) return true;
  return eventPointerId === "mouse" && pointer.pointerId !== "touch";
}

// Mirrors the project's own isMobileScheduleFormViewport()/isMobileViewport()
// pattern (tests-actions.js, media-modal.js) at the same 720px cutoff the
// Analysis grid itself switches to a stacked mobile layout at (styles.css) -
// pointer drag/resize is a desktop-only interaction there; mobile uses the
// Move up/down toolbar buttons instead (handleTrainingLoadAnalysisPointerDown
// below stays the single gate, so no handler needs its own check).
function analysisIsMobileLayoutViewport() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches;
}

// IA shell (Phase A): the one place `state.trainingLoad.section` is ever
// written - keeps `lastDataAnalysisSection` (state.js) in sync so switching
// to the Schedule space and back to Data & Analysis restores whichever of
// Activities/Athletes/Dashboards was last active, instead of always
// resetting to Activities. Every call site that assigns
// `state.trainingLoad.section` goes through this now, including
// app.js's own notification-driven openTrainingLoadResults - exported
// specifically so that (and any other future non-training-load-actions.js
// entry point) never has to fall back to a direct assignment.
// The one place that knows which loader a section's own data comes from, used
// by the section switch below and by app.js on entering the tab or after a
// workspace switch. A section without a weekly slot must never reach
// loadTrainingLoadWeekly.
export function loadTrainingLoadSectionData(section, render) {
  if (section === "today") return loadTrainingLoadCalendarWeek(render);
  if (section === "analysis") return loadTrainingLoadAnalysis(render);
  if (section === "imports") return loadGpexeImports(render);
  return loadTrainingLoadWeekly(section, render);
}

export function setTrainingLoadSection(section) {
  state.trainingLoad.section = section;
  if (section === "today" || section === "results" || section === "analysis" || section === "overview" || section === "imports") {
    state.trainingLoad.lastDataAnalysisSection = section;
  }
}

// -------------------- Dashboards UX H1: overlays --------------------

function closeAnalysisPopovers() {
  const a = state.trainingLoad.analysis;
  const wasOpen = a.picker.open || Boolean(a.menu);
  a.picker.open = false;
  a.menu = "";
  return wasOpen;
}

function exitAnalysisLayoutMode() {
  const a = state.trainingLoad.analysis;
  cancelAnalysisLayoutDraft();
  a.editMode = false;
  // H3: the widget editor keeps its own staged changes - only a clean one
  // closes along with layout mode.
  if (!analysisEditorIsDirty()) a.editor = closedAnalysisWidgetEditor();
}

// H3: the advanced widget editor's staged changes get the same protection
// as an unsaved layout. True when there is nothing to lose or the coach
// agreed (the editor is then closed without saving).
function releaseAnalysisEditorDraft() {
  if (!analysisEditorMayBeDiscarded()) return false;
  discardAnalysisEditorDraft();
  return true;
}

// H4: the question and the discard, separately - a leave that still depends on
// a request (workspace switch, a notification's mark-read) asks first and
// discards only once that request went through.
function analysisEditorMayBeDiscarded() {
  const a = state.trainingLoad.analysis;
  if (!a.editor?.open) return true;
  if (a.editor.saving) return false;
  return !analysisEditorIsDirty() || window.confirm("Discard your unsaved widget changes?");
}

function discardAnalysisEditorDraft() {
  const a = state.trainingLoad.analysis;
  if (a.editor?.open) a.editor = closedAnalysisWidgetEditor();
}

// H2: moved-but-unsaved widgets are never dropped silently. Every Dashboards
// action that would reload the dashboard or leave it (Done, picking another
// dashboard, New/Rename/Archive/Delete/Use template, Choose activity,
// switching section) calls this first. Returns true when there is nothing
// to lose or the coach agreed - the draft is then discarded and layout mode
// ends - and false when the coach wants to keep editing.
function releaseAnalysisLayoutDraft() {
  if (!analysisLayoutMayBeDiscarded()) return false;
  discardAnalysisLayoutDraft();
  return true;
}

function analysisLayoutMayBeDiscarded() {
  const a = state.trainingLoad.analysis;
  return !a.editMode || !a.layoutDraft || window.confirm("Discard your unsaved layout changes?");
}

function discardAnalysisLayoutDraft() {
  const a = state.trainingLoad.analysis;
  if (a.editMode && a.layoutDraft) exitAnalysisLayoutMode();
}

// H2 (owner review of #93): leaving Training Load altogether - the main
// sidebar/rail or browser Back - asks the same question. app.js calls this
// BEFORE it changes state.activeTab or pushes history; false means the
// coach wants to keep arranging, so the navigation must not happen.
// Re-clicking the already-active Training load item counts too: it reloads
// the dashboard (loadActiveTab), which drops the draft just the same.
// H4: notification rows that open another screen and a workspace switch ask
// too, before they change anything (notifications.js, workspace-actions.js),
// with { discard: false }: a declined or failed request must not lose the
// draft. A notification then calls discardTrainingLoadLeaveDrafts right before
// it navigates; a successful workspace switch resets Training Load anyway
// (resetTrainingLoadForWorkspaceChange) or reloads the page.
export function confirmLeaveTrainingLoad(_nextTab, { discard = true } = {}) {
  if (state.activeTab !== "training-load") return true;
  // Imports (phase 4b): an import of several sessions that is still running
  // must not be lost unseen, and a selection made but not imported is asked
  // about. Both live in state and survive a move inside the app; a
  // workspace switch resets Training Load, so that is the case that loses
  // them.
  if (!importsBatchMayBeLeft(_nextTab)) return false;
  if (!discard) return analysisEditorMayBeDiscarded() && analysisLayoutMayBeDiscarded();
  return releaseAnalysisEditorDraft() && releaseAnalysisLayoutDraft();
}

function importsBatchMayBeLeft(nextTab) {
  const batch = state.trainingLoad.gpexe?.batch;
  if (!batch) return true;
  const ask = (question) => Boolean(globalThis.window?.confirm?.(question));
  // A workspace switch or a notification (nextTab null) resets Training
  // Load: that exit loses the result; a move inside the app keeps it.
  if (batch.sending) {
    return ask(nextTab === null
      ? "An import of several sessions is still running. If you switch workspace now, its result is lost. Leave anyway?"
      : "An import of several sessions is still running. Its result will be under Imports when it finishes. Leave anyway?");
  }
  // A click on the Training load item itself reloads the tab and keeps the
  // Imports state: nothing to ask.
  if (nextTab === "training-load") return true;
  const chosen = Object.keys(batch.selected || {}).length;
  if (chosen && !batch.results && !batch.unknown) return ask(`You selected ${chosen} ${chosen === 1 ? "session" : "sessions"} for import but did not import ${chosen === 1 ? "it" : "them"} yet. Leave anyway?`);
  return true;
}

export function discardTrainingLoadLeaveDrafts() {
  if (state.activeTab !== "training-load") return;
  discardAnalysisEditorDraft();
  discardAnalysisLayoutDraft();
}

// H2: widget Settings / Advanced settings / Delete reload the dashboard on
// success, which resets an unsaved layout draft - the widget menu disables
// them while a draft exists, and the handlers refuse them the same way.
function analysisWidgetActionsBlocked() {
  const a = state.trainingLoad.analysis;
  return Boolean(a.editMode && a.layoutDraft);
}

// Escape (app.js's global keydown): closes the topmost Dashboards overlay -
// a popover first, then the dashboard dialog, then the metric panel (never
// while its save is in flight). Returns whether anything closed so the
// caller knows to re-render.
export function closeTrainingLoadAnalysisOverlay() {
  const a = state.trainingLoad.analysis;
  if (closeAnalysisPopovers()) return true;
  if (a.dashboardForm && !a.dashboardForm.submitting) { a.dashboardForm = null; return true; }
  if (a.metricPanel && !a.metricPanel.saving) { a.metricPanel = null; return true; }
  // H3: the advanced editor closes too - asking first when it holds unsaved changes.
  if (a.editor?.open && !a.editor.saving) return releaseAnalysisEditorDraft();
  return false;
}

// H3: the editor's Title and Label text fields update the draft on every
// keystroke WITHOUT a re-render (app.js's input handler). Re-rendering on
// their change/blur instead would replace the "Save changes" button between
// its mousedown and click, and the click would be lost.
export function setTrainingLoadAnalysisEditorText(input) {
  const editor = state.trainingLoad.analysis.editor;
  if (!editor?.draft || editor.saving) return;
  if (input.dataset.tlEditorField === "title") editor.draft.title = input.value ?? "";
  if (input.dataset.tlEditorField === "label") {
    const entry = editorSeriesEntry(editor.draft, input.dataset.seriesKey);
    if (entry) entry.fields.displayLabel = (input.value ?? "").trim() || null;
  }
}

// Live search inside the picker / metric panel (app.js's input handler
// calls this per keystroke, then re-renders and restores focus).
export function setTrainingLoadAnalysisSearch(kind, value) {
  const a = state.trainingLoad.analysis;
  if (kind === "picker") a.picker.search = value ?? "";
  else if (kind === "metric" && a.metricPanel) a.metricPanel.search = value ?? "";
}

function openAnalysisMetricPanel(widget = null) {
  const a = state.trainingLoad.analysis;
  closeAnalysisPopovers();
  a.editor = closedAnalysisWidgetEditor();
  a.metricPanel = emptyAnalysisMetricPanel(widget);
}

// Phase B (shared weekly temporal context): given a consumer's own prior
// selectedDate/weekStart, returns the equivalent day in a NEW week -
// preserving THAT consumer's own weekday offset (never adopting whichever
// weekday the OTHER side happened to be on), clamped to 0-6 so a malformed
// or missing prior date never lands outside the new week. A consumer with
// no prior selectedDate at all (never yet visited) normalizes to the new
// week's Monday - always a valid member of the shared week, per the
// contract that a local selectedDate must never survive into a week it no
// longer belongs to.
function normalizeSelectedDateToNewWeek(oldSelectedDate, oldWeekStart, newWeekStart) {
  if (!oldSelectedDate || !oldWeekStart) return newWeekStart;
  const offsetDays = Math.round((new Date(`${oldSelectedDate}T00:00:00Z`) - new Date(`${oldWeekStart}T00:00:00Z`)) / 86400000);
  const clampedOffset = Math.min(6, Math.max(0, offsetDays));
  return addDaysIso(newWeekStart, clampedOffset);
}

// The one place `state.trainingLoad.dataAnalysisWeekStart` is ever written.
// Called from whichever side's own week-nav control (Prev/Next/Today, or a
// month-grid day click landing in a different week) just changed its own
// weekStart - propagates the new week to the OTHER Data & Analysis side
// (Activities' `calendar` nav or Athletes' `weekly.results` nav) so both
// always agree on one shared week, normalizing that other side's own
// selectedDate into it via normalizeSelectedDateToNewWeek above.
//
// Deliberately does NOT fetch the other side's data here - both
// loadTrainingLoadCalendarWeek and loadTrainingLoadWeekly already compute
// their own cache key from nav.weekStart, and the existing
// "training-load-section" action already unconditionally re-fetches
// whichever of Activities/Athletes' data the user actually switches to
// (see that handler below) - by the time that fires, this function has
// already left the right week/date queued in state for it to pick up. This
// also means an as-yet-unvisited side's own weekStart stops reading as
// empty, so its own "no weekStart yet -> bootstrap to today" branch
// correctly never overrides the week this function just set.
//
// `movedSide` is "calendar" or "results" - the side that just changed,
// which is left untouched here (it already updated itself).
export function syncDataAnalysisSharedWeek(newWeekStart, movedSide) {
  state.trainingLoad.dataAnalysisWeekStart = newWeekStart;
  if (movedSide !== "calendar") {
    const cal = state.trainingLoad.calendar;
    cal.selectedDate = normalizeSelectedDateToNewWeek(cal.selectedDate, cal.weekStart, newWeekStart);
    cal.weekStart = newWeekStart;
  }
  if (movedSide !== "results") {
    const res = state.trainingLoad.weekly.results;
    res.selectedDate = normalizeSelectedDateToNewWeek(res.selectedDate, res.weekStart, newWeekStart);
    res.weekStart = newWeekStart;
  }
  // Phase E: Overview is a third side of this same shared week, symmetric
  // with Athletes above - its weekly.overview nav slot just tracks this
  // new weekStart/selectedDate, same as Athletes; it does not eagerly
  // re-fetch here (same lazy-refetch-on-next-visit contract Activities/
  // Athletes already established) - the "switching section always
  // re-fetches" handler picks up the correct week once Overview is
  // actually opened. `overviewCoverage` (Overview's OWN second nav slot,
  // see state.js's own header comment) is deliberately NOT touched here -
  // unlike weekly.overview, its identity/staleness is owned entirely by
  // loadOverviewCoverage() itself (same isNewContext-clears-data guard
  // Phase D's loadResultsAthleteActivities uses), so an external write to
  // its weekStart here - without also clearing its data - would silently
  // reopen that exact same class of in-flight-staleness bug.
  if (movedSide !== "overview") {
    const ov = state.trainingLoad.weekly.overview;
    ov.selectedDate = normalizeSelectedDateToNewWeek(ov.selectedDate, ov.weekStart, newWeekStart);
    ov.weekStart = newWeekStart;
  }
}

function analysisLayoutCanEdit() {
  const a = state.trainingLoad.analysis;
  return state.trainingLoad.section === "analysis" && a.editMode && a.dashboard && a.dashboard.status !== "archived" && !a.dashboard.is_template && !a.saving && !analysisIsMobileLayoutViewport();
}

function analysisLayoutMetrics() {
  const grid = document.querySelector(".tl-analysis-grid");
  const rect = grid?.getBoundingClientRect?.();
  const width = Number(rect?.width) || 960;
  return { column: Math.max(1, (width - 110) / 12), row: 56 };
}

function analysisLayoutDraftEntry(widgetId) {
  return state.trainingLoad.analysis.layoutDraft?.find((entry) => entry.widgetId === widgetId) || null;
}

function patchAnalysisWidgetLayout(widgetId) {
  const entry = analysisLayoutDraftEntry(widgetId);
  if (!entry) return;
  const widget = [...document.querySelectorAll("[data-analysis-widget-id]")]
    .find((candidate) => candidate.dataset.analysisWidgetId === widgetId);
  if (!widget) return;
  widget.style.setProperty("--tl-x", String(entry.x));
  widget.style.setProperty("--tl-y", String(entry.y));
  widget.style.setProperty("--tl-w", String(entry.width));
  widget.style.setProperty("--tl-h", String(entry.height));
  widget.style.setProperty("--tl-mobile", String(entry.mobileOrder || 1));
}

function cleanupAnalysisLayoutWindowListeners() {
  analysisLayoutWindowCleanup?.();
  analysisLayoutWindowCleanup = null;
}

function analysisWindowPointerMove(event) {
  if (event.type?.startsWith("touch")) {
    const proxy = analysisTouchProxyEvent(event, analysisLayoutPointer?.captureTarget || event.target);
    if (proxy) handleTrainingLoadAnalysisPointerMove(proxy);
    return;
  }
  handleTrainingLoadAnalysisPointerMove(analysisMouseProxyEvent(event, analysisLayoutPointer?.captureTarget || event.target));
}

function analysisWindowPointerEnd(event) {
  if (event.type?.startsWith("touch")) {
    handleTrainingLoadAnalysisPointerEnd({ pointerIdFallback: "touch" });
    return;
  }
  handleTrainingLoadAnalysisPointerEnd(analysisMouseProxyEvent(event, analysisLayoutPointer?.captureTarget || event.target));
}

function installAnalysisLayoutWindowListeners() {
  cleanupAnalysisLayoutWindowListeners();
  const targetWindow = globalThis.window;
  const targetDocument = globalThis.document;
  const moveTargets = [targetWindow, targetDocument].filter((target) => target?.addEventListener);
  if (!moveTargets.length) return;
  moveTargets.forEach((target) => {
    target.addEventListener("pointermove", analysisWindowPointerMove, true);
    target.addEventListener("mousemove", analysisWindowPointerMove, true);
    target.addEventListener("touchmove", analysisWindowPointerMove, { passive: false, capture: true });
    target.addEventListener("pointerup", analysisWindowPointerEnd, true);
    target.addEventListener("pointercancel", analysisWindowPointerEnd, true);
    target.addEventListener("mouseup", analysisWindowPointerEnd, true);
    target.addEventListener("touchend", analysisWindowPointerEnd, { passive: true, capture: true });
    target.addEventListener("touchcancel", analysisWindowPointerEnd, { passive: true, capture: true });
  });
  analysisLayoutWindowCleanup = () => {
    moveTargets.forEach((target) => {
      target.removeEventListener("pointermove", analysisWindowPointerMove, true);
      target.removeEventListener("mousemove", analysisWindowPointerMove, true);
      target.removeEventListener("touchmove", analysisWindowPointerMove, true);
      target.removeEventListener("pointerup", analysisWindowPointerEnd, true);
      target.removeEventListener("pointercancel", analysisWindowPointerEnd, true);
      target.removeEventListener("mouseup", analysisWindowPointerEnd, true);
      target.removeEventListener("touchend", analysisWindowPointerEnd, true);
      target.removeEventListener("touchcancel", analysisWindowPointerEnd, true);
    });
  };
}

function analysisPointerTarget(event) {
  const explicitTarget = event.target.closest?.("[data-analysis-drag-handle], [data-analysis-resize-handle]");
  if (explicitTarget) return explicitTarget;
  const widget = event.target.closest?.("[data-analysis-widget-id]");
  if (!widget) return null;
  const interactiveTarget = event.target.closest?.("button, input, select, textarea, a, [role='button'], [data-action], .tl-popover");
  if (interactiveTarget) return null;
  return widget.querySelector?.("[data-analysis-drag-handle='true']") || null;
}

export function handleTrainingLoadAnalysisPointerDown(event, renderTrainingLoad) {
  if (analysisLayoutPointer) return true;
  if (!analysisLayoutCanEdit()) return false;
  const target = analysisPointerTarget(event);
  const widgetElement = target?.closest?.("[data-analysis-widget-id]");
  const widgetId = widgetElement?.dataset.analysisWidgetId;
  if (!target || !widgetId) return false;
  const entry = ensureAnalysisLayoutDraft().find((item) => item.widgetId === widgetId);
  if (!entry) return false;
  const pointerId = analysisEventPointerId(event);
  analysisLayoutPointer = {
    pointerId,
    mode: target.matches("[data-analysis-resize-handle]") ? "resize" : "drag",
    widgetId,
    startX: event.clientX,
    startY: event.clientY,
    initial: { ...entry },
    captureTarget: target,
    renderTrainingLoad,
  };
  try {
    if (event.pointerId != null) target.setPointerCapture?.(event.pointerId);
  } catch {
    // A detached target can reject capture during a fast rerender; document listeners still finish the gesture.
  }
  installAnalysisLayoutWindowListeners();
  event.preventDefault();
  event.stopPropagation?.();
  return true;
}

export function handleTrainingLoadAnalysisPointerMove(event) {
  const pointer = analysisLayoutPointer;
  if (!pointer || !analysisPointerEventMatches(pointer, event)) return false;
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
  patchAnalysisWidgetLayout(pointer.widgetId);
  event.preventDefault();
  event.stopPropagation?.();
  return true;
}

export function handleTrainingLoadAnalysisPointerEnd(event) {
  if (!analysisLayoutPointer || ((event?.pointerId != null || event?.pointerIdFallback != null) && !analysisPointerEventMatches(analysisLayoutPointer, event))) return false;
  const pointer = analysisLayoutPointer;
  try {
    if (event?.pointerId != null) pointer.captureTarget?.releasePointerCapture?.(event.pointerId);
  } catch {
    // The pointer may already have been released by the browser.
  }
  analysisLayoutPointer = null;
  cleanupAnalysisLayoutWindowListeners();
  pointer.renderTrainingLoad?.();
  return true;
}

function analysisTouchProxyEvent(event, target) {
  const touch = event.touches?.[0] || event.changedTouches?.[0];
  if (!touch) return null;
  return {
    pointerIdFallback: "touch",
    clientX: touch.clientX,
    clientY: touch.clientY,
    target,
    preventDefault: () => {
      if (event.cancelable) event.preventDefault();
    },
  };
}

function analysisMouseProxyEvent(event, target) {
  return {
    pointerId: event.pointerId,
    pointerIdFallback: event.pointerId == null ? "mouse" : undefined,
    clientX: event.clientX,
    clientY: event.clientY,
    target,
    preventDefault: () => event.preventDefault(),
  };
}

function analysisDirectStart(event, target, renderTrainingLoad) {
  if (event.type?.startsWith("touch")) {
    const proxy = analysisTouchProxyEvent(event, target);
    const started = proxy ? handleTrainingLoadAnalysisPointerDown(proxy, renderTrainingLoad) : false;
    if (started) event.stopImmediatePropagation?.();
    return started;
  }
  const started = handleTrainingLoadAnalysisPointerDown(analysisMouseProxyEvent(event, target), renderTrainingLoad);
  if (started) event.stopImmediatePropagation?.();
  return started;
}

function analysisIsInteractiveTarget(target) {
  // .tl-popover: H2's widget "⋯" menu opens inside the widget, and its
  // non-button content (the "save or cancel first" note) must not start a
  // drag in layout mode.
  return Boolean(target.closest?.("button, input, select, textarea, a, [role='button'], [data-action], .tl-popover"));
}

export function bindTrainingLoadAnalysisLayoutInteractions(root = document, renderTrainingLoad) {
  const widgets = root.querySelectorAll?.("[data-analysis-widget-id]") || [];
  widgets.forEach((widget) => {
    const dragHandle = widget.querySelector("[data-analysis-drag-handle='true']");
    const resizeHandle = widget.querySelector("[data-analysis-resize-handle]");
    if (dragHandle) {
      dragHandle.removeAttribute?.("draggable");
      ["pointerdown", "mousedown"].forEach((type) => {
        dragHandle.addEventListener(type, (event) => analysisDirectStart(event, dragHandle, renderTrainingLoad));
      });
      dragHandle.addEventListener("touchstart", (event) => analysisDirectStart(event, dragHandle, renderTrainingLoad), { passive: false });
    }
    if (resizeHandle) {
      ["pointerdown", "mousedown"].forEach((type) => {
        resizeHandle.addEventListener(type, (event) => analysisDirectStart(event, resizeHandle, renderTrainingLoad));
      });
      resizeHandle.addEventListener("touchstart", (event) => analysisDirectStart(event, resizeHandle, renderTrainingLoad), { passive: false });
    }
    ["pointerdown", "mousedown"].forEach((type) => widget.addEventListener(type, (event) => {
      if (!dragHandle || analysisIsInteractiveTarget(event.target)) return;
      analysisDirectStart(event, dragHandle, renderTrainingLoad);
    }));
    widget.addEventListener("touchstart", (event) => {
      if (!dragHandle || analysisIsInteractiveTarget(event.target)) return;
      analysisDirectStart(event, dragHandle, renderTrainingLoad);
    }, { passive: false });
  });
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
  if (type.startsWith("training-load-gpexe-")) return handleGpexeImportAction(action, { renderTrainingLoad });

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
        if (!window.confirm("This session already has a recorded RPE result. Turning RPE off will stop new submissions, but the existing result stays in Athletes. Continue?")) {
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
        if (!window.confirm("This session already has a recorded RPE result. Turning tracking off will also stop new RPE submissions, but the existing result stays in Athletes. Continue?")) {
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

  // -------------------- Coach: Schedule / Data & Analysis sections --------------------

  if (type === "training-load-section") {
    // Re-clicking the active Dashboards tab reloads it as well, so it asks too.
    if (state.trainingLoad.section === "analysis" && !(releaseAnalysisEditorDraft() && releaseAnalysisLayoutDraft())) {
      renderTrainingLoad();
      return true;
    }
    setTrainingLoadSection(action.dataset.section);
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
    // renders anymore for this tab. Schedule/Athletes are completely
    // unaffected - same loadTrainingLoadWeekly call as before.
    //
    // Phase E: "overview" loads its own two, deliberately independent
    // blocks in parallel - loadTrainingLoadWeekly("overview", ...) (the
    // RPE/training-load block, reusing the exact same weekly cache/
    // bootstrap-to-today contract as today/schedule/results) and
    // loadOverviewCoverage (the activity/data-coverage block, its own
    // separate nav slot/namespace - see state.js's own header comment on
    // why these two never share a cache entry). loadTrainingLoadWeekly's
    // own bootstrap-to-today runs synchronously before its first internal
    // await, so weekly.overview.weekStart is already correct here without
    // needing to await it first.
    if (state.trainingLoad.section === "overview") {
      const weeklyPromise = loadTrainingLoadWeekly("overview", renderTrainingLoad);
      await Promise.all([weeklyPromise, loadOverviewCoverage(state.trainingLoad.weekly.overview.weekStart, renderTrainingLoad)]);
    } else {
      await Promise.all([
        loadTrainingLoadSectionData(state.trainingLoad.section, renderTrainingLoad),
        state.trainingLoad.section === "schedule" ? loadPlannedRpeSetting() : Promise.resolve(),
      ]);
    }
    renderTrainingLoad();
    return true;
  }

  // -------------------- Training Load 3B3: Analysis dashboards --------------------

  if (type === "training-load-analysis-select-dashboard") {
    // A picker option carries data-dashboard-id; a <button>'s own .value is
    // "" (not nullish), so the dataset must win over action.value here.
    const dashboardId = action.dataset.dashboardId ?? action.value ?? "";
    const a = state.trainingLoad.analysis;
    closeAnalysisPopovers();
    // Re-picking the dashboard that is already open while arranging it just
    // closes the picker - reloading it would drop the unsaved layout.
    if (dashboardId === a.selectedDashboardId && a.dashboard && a.editMode && a.layoutDraft) {
      renderTrainingLoad();
      return true;
    }
    if (!releaseAnalysisLayoutDraft()) {
      renderTrainingLoad();
      return true;
    }
    a.picker.search = "";
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
  // -------------------- Dashboards UX H1: picker, menus, dialog --------------------
  if (type === "training-load-analysis-open-picker") {
    const a = state.trainingLoad.analysis;
    const open = !a.picker.open;
    closeAnalysisPopovers();
    a.picker.open = open;
    if (!open) a.picker.search = "";
    renderTrainingLoad();
    if (open) document.querySelector("[data-tl-analysis-search='picker']")?.focus();
    return true;
  }
  if (type === "training-load-analysis-open-menu") {
    const a = state.trainingLoad.analysis;
    const menu = action.dataset.menu || "";
    const open = a.menu !== menu;
    closeAnalysisPopovers();
    a.menu = open ? menu : "";
    renderTrainingLoad();
    // H2: keyboard users land on the first available item of the menu
    // they just opened (Escape closes it again - closeTrainingLoadAnalysisOverlay).
    // When every item is disabled (widget menu over an unsaved layout), the
    // menu itself takes focus so its note is where the keyboard is.
    if (open) (document.querySelector(".tl-menu [role^='menuitem']:not([disabled])") || document.querySelector(".tl-menu[tabindex='-1']"))?.focus?.();
    return true;
  }
  if (type === "training-load-analysis-close-popovers") {
    closeAnalysisPopovers();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-picker-search" || type === "training-load-analysis-panel-search") {
    // change/blur fallback - keystrokes already went through
    // setTrainingLoadAnalysisSearch (app.js) with a focus-preserving
    // re-render, so a change event carrying the same value must NOT
    // re-render again (that would replace the input and drop focus/caret
    // on Enter, or under automation that fires change per keystroke).
    const a = state.trainingLoad.analysis;
    const kind = type.endsWith("picker-search") ? "picker" : "metric";
    const current = kind === "picker" ? a.picker.search : (a.metricPanel?.search ?? "");
    if ((action.value ?? "") === current) return true;
    setTrainingLoadAnalysisSearch(kind, action.value ?? "");
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-period-preset") {
    const a = state.trainingLoad.analysis;
    closeAnalysisPopovers();
    if (!applyAnalysisPeriodPreset(action.dataset.preset)) { renderTrainingLoad(); return true; }
    renderTrainingLoad();
    await queryAnalysisDashboard(renderTrainingLoad, { force: true });
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-new-dashboard" || type === "training-load-analysis-rename-dashboard") {
    const a = state.trainingLoad.analysis;
    const rename = type.endsWith("rename-dashboard");
    if (rename && !a.dashboard) return true;
    closeAnalysisPopovers();
    if (!releaseAnalysisLayoutDraft()) { renderTrainingLoad(); return true; }
    a.dashboardForm = { mode: rename ? "rename" : "create", name: rename ? a.dashboard.name : "", description: "", error: "", submitting: false };
    renderTrainingLoad();
    document.querySelector("[data-action='training-load-analysis-dashboard-form-name']")?.focus();
    return true;
  }
  if (type === "training-load-analysis-dashboard-form-name" || type === "training-load-analysis-dashboard-form-description") {
    const form = state.trainingLoad.analysis.dashboardForm;
    if (!form) return true;
    form[type.endsWith("-name") ? "name" : "description"] = action.value ?? "";
    return true;
  }
  if (type === "training-load-analysis-dashboard-form-cancel") {
    const a = state.trainingLoad.analysis;
    if (a.dashboardForm?.submitting) return true;
    a.dashboardForm = null;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-dashboard-form-submit") {
    const a = state.trainingLoad.analysis;
    const form = a.dashboardForm;
    if (!form || form.submitting) return true;
    // The <form> submit lands here (app.js) - read the live inputs off it
    // so Enter works without waiting for a change event to fire first.
    const nameInput = action.querySelector?.("[data-action='training-load-analysis-dashboard-form-name']");
    if (nameInput) form.name = nameInput.value;
    const descriptionInput = action.querySelector?.("[data-action='training-load-analysis-dashboard-form-description']");
    if (descriptionInput) form.description = descriptionInput.value;
    const name = form.name.trim();
    if (!name) {
      form.error = "Give the dashboard a name.";
      renderTrainingLoad();
      return true;
    }
    if (form.mode === "rename" && name === a.dashboard?.name) {
      a.dashboardForm = null;
      renderTrainingLoad();
      return true;
    }
    form.submitting = true;
    form.error = "";
    renderTrainingLoad();
    const result = form.mode === "rename"
      ? await updateAnalysisDashboardMetadata({ name }, renderTrainingLoad)
      : await createAnalysisDashboard({ name, description: form.description.trim() }, renderTrainingLoad);
    if (result) {
      a.dashboardForm = null;
      a.notice = form.mode === "rename" ? "Dashboard renamed." : `Dashboard "${name}" created.`;
    } else {
      // api.js surfaces the route's error CODE as the message - translate
      // the ones this dialog can actually hit; the stale-revision case has
      // already reloaded the dashboard (mutateDashboard) and set `notice`.
      const code = a.mutationError || a.notice || "";
      form.submitting = false;
      form.error = {
        conflict: "That name is already in use in this workspace - choose another.",
        invalidRequest: "The name or description is not valid (name 1-200 characters).",
      }[code] || code || "Could not save the dashboard.";
      a.mutationError = "";
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-clone-template") {
    const templateId = action.dataset.templateId || action.value;
    if (!templateId) return true;
    closeAnalysisPopovers();
    if (!releaseAnalysisLayoutDraft()) { renderTrainingLoad(); return true; }
    await cloneAnalysisDashboard(templateId, renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-toggle-edit") {
    const a = state.trainingLoad.analysis;
    closeAnalysisPopovers();
    if (!a.editMode) {
      a.editMode = true;
    } else if (releaseAnalysisLayoutDraft()) {
      exitAnalysisLayoutMode();
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-set-active") {
    const dashboardId = state.trainingLoad.analysis.dashboard?.id || state.trainingLoad.analysis.selectedDashboardId;
    closeAnalysisPopovers();
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
  // 3B3 UX slice: "Choose activity" hands off to the existing Calendar ->
  // activity detail flow instead of asking for a raw activity/component
  // UUID here. Phase F: the context bar's "Analyze this activity" button
  // (training-load-calendar-view.js) is an intra-space hand-off shown for
  // ANY open activity whose detail has loaded - pickingActivity only adds
  // the banner/Cancel affordance, it is no longer the gate for the button.
  if (type === "training-load-analysis-choose-activity") {
    if (!releaseAnalysisLayoutDraft()) { renderTrainingLoad(); return true; }
    state.trainingLoad.analysis.pickingActivity = true;
    setTrainingLoadSection("today");
    renderTrainingLoad();
    await loadTrainingLoadCalendarWeek(renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-cancel-choose-activity") {
    state.trainingLoad.analysis.pickingActivity = false;
    setTrainingLoadSection("analysis");
    renderTrainingLoad();
    await loadTrainingLoadAnalysis(renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-open-in-analysis") {
    const nav = state.trainingLoad.calendar;
    const detail = nav.activityDetail?.data;
    if (!nav.selectedActivityId || !detail || nav.activityDetail.activityId !== nav.selectedActivityId) return true;
    const bucket = nav.data?.days.find((d) => d.date === nav.selectedDate);
    const item = bucket?.items.find((i) => i.kind === "activity" && i.activityId === nav.selectedActivityId);
    const a = state.trainingLoad.analysis;
    a.runtimeFilter.activityId = nav.selectedActivityId;
    a.runtimeFilter.componentId = "";
    a.selectedActivity = { id: nav.selectedActivityId, name: item?.name || "Activity", date: nav.selectedDate };
    a.componentOptions = (detail.components || []).map((c) => ({ id: c.id, name: c.name }));
    a.pickingActivity = false;
    setTrainingLoadSection("analysis");
    renderTrainingLoad();
    await loadTrainingLoadAnalysis(renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-runtime-component-select") {
    state.trainingLoad.analysis.runtimeFilter.componentId = action.value || "";
    renderTrainingLoad();
    await queryAnalysisDashboard(renderTrainingLoad, { force: true });
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-clear-activity") {
    const a = state.trainingLoad.analysis;
    a.runtimeFilter.activityId = "";
    a.runtimeFilter.componentId = "";
    a.selectedActivity = null;
    a.componentOptions = [];
    renderTrainingLoad();
    await queryAnalysisDashboard(renderTrainingLoad, { force: true });
    renderTrainingLoad();
    return true;
  }
  // -------------------- Dashboards UX H1: guided "Add metric" panel --------------------
  if (type === "training-load-analysis-add-widget") {
    if (!state.trainingLoad.analysis.dashboard) return true;
    openAnalysisMetricPanel(null);
    // The catalog load flips metricPicker.loading synchronously, so this
    // first render already shows "Loading metrics..." under the built-ins;
    // the panel itself never waits for the network.
    const loading = loadAnalysisMetricDefinitions();
    renderTrainingLoad();
    await loading;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-panel-close") {
    const a = state.trainingLoad.analysis;
    if (a.metricPanel?.saving) return true;
    // Cancel: staged edits are dropped. Nothing was sent - unless a partial
    // save already landed, in which case the footer read "Close" and the
    // server keeps what it has (panel.serverChanged, see
    // saveAnalysisMetricPanel).
    a.metricPanel = null;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-panel-pick-builtin" || type === "training-load-analysis-panel-pick-metric") {
    const panel = state.trainingLoad.analysis.metricPanel;
    if (!panel || panel.saving) return true;
    if (type.endsWith("builtin")) {
      const builtIn = BUILT_IN_SERIES.find((b) => b.key === action.dataset.builtInKey);
      if (builtIn) setMetricPanelMetric(panel, { kind: "builtin", key: builtIn.key, label: builtIn.label, unit: builtIn.unit || "" });
    } else {
      const def = (state.trainingLoad.analysis.metricPicker.definitions || []).find((d) => d.id === action.dataset.metricId);
      if (def) setMetricPanelMetric(panel, { kind: "metric", id: def.id, label: def.label, unit: def.unit || "" });
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-panel-type") {
    const panel = state.trainingLoad.analysis.metricPanel;
    if (!panel || panel.saving) return true;
    panel.widgetType = action.dataset.widgetType || panel.widgetType;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-panel-title") {
    const panel = state.trainingLoad.analysis.metricPanel;
    if (!panel || panel.saving) return true;
    panel.title = action.value ?? "";
    panel.titleTouched = Boolean(panel.title.trim());
    if (!panel.titleTouched) panel.title = panel.metric?.label || "";
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-panel-field") {
    const panel = state.trainingLoad.analysis.metricPanel;
    const field = action.dataset.field;
    if (!panel || panel.saving || !["groupBy", "aggregation", "scope"].includes(field)) return true;
    // H3: a built-in series' data level is fixed by the catalog.
    if (field === "scope" && panel.metric?.kind === "builtin" && BUILT_IN_FIXED_SCOPE[panel.metric.key]) return true;
    panel[field] = action.value || panel[field];
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-panel-save") {
    const panel = state.trainingLoad.analysis.metricPanel;
    if (!panel) return true;
    // The title input applies on change/blur; a click on Save may come
    // before that fires, so read the live value off the input first.
    const titleInput = document.querySelector("[data-action='training-load-analysis-panel-title']");
    if (titleInput && typeof titleInput.value === "string" && titleInput.value.trim()) panel.title = titleInput.value;
    await saveAnalysisMetricPanel(renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-open-advanced") {
    const a = state.trainingLoad.analysis;
    closeAnalysisPopovers();
    const widget = a.widgets.find((w) => w.id === action.dataset.widgetId);
    if (!widget || analysisWidgetActionsBlocked()) { renderTrainingLoad(); return true; }
    a.metricPanel = null;
    openAnalysisWidgetEditor(widget);
    renderTrainingLoad();
    void loadAnalysisMetricDefinitions().then(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-analysis-save-layout") {
    const a = state.trainingLoad.analysis;
    if (a.saving) return true;
    const saved = await saveAnalysisLayout(renderTrainingLoad);
    // H2: a saved layout ends layout mode. A refusal (stale revision - the
    // latest version was reloaded - or any other error) stays in it, so the
    // coach sees the message and can arrange again.
    if (saved) {
      exitAnalysisLayoutMode();
      a.notice = "Layout saved.";
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-cancel-layout") {
    // H2: Cancel is the explicit "throw the moves away" - no extra confirm.
    if (state.trainingLoad.analysis.saving) return true;
    exitAnalysisLayoutMode();
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
  if (type === "training-load-analysis-archive") {
    closeAnalysisPopovers();
    // The action's own question first: an unsaved layout is only discarded
    // for an archive the coach actually goes through with.
    if (!window.confirm("Archive this dashboard? It will become read-only.")) { renderTrainingLoad(); return true; }
    if (!releaseAnalysisLayoutDraft()) { renderTrainingLoad(); return true; }
    await archiveAnalysisDashboard(renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-delete-dashboard") {
    const a = state.trainingLoad.analysis;
    const target = a.dashboard;
    closeAnalysisPopovers();
    if (!target || a.saving) { renderTrainingLoad(); return true; }
    const widgetCount = (a.widgets || []).length;
    const whatElse = widgetCount === 0
      ? "It has no widgets yet; its settings (layout, filters) are deleted too."
      : `This also deletes ${widgetCount === 1 ? "its 1 widget" : `all ${widgetCount} of its widgets`} and every setting (metrics, layout, filters).`;
    const confirmed = window.confirm(
      `Permanently delete "${target.name}"?\n\n`
      + `${whatElse} It cannot be undone.\n\n`
      + "To keep it as a read-only record instead, choose Archive.",
    );
    // Same order as Archive: discard an unsaved layout only once the delete
    // itself is confirmed.
    if (!confirmed || !releaseAnalysisLayoutDraft()) { renderTrainingLoad(); return true; }
    await deleteAnalysisDashboard(renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-edit-widget") {
    // Widget "Settings" opens the guided panel in edit mode (staged; Save/
    // Cancel); the full per-series editor stays behind "Advanced settings".
    const widget = state.trainingLoad.analysis.widgets.find((w) => w.id === action.dataset.widgetId);
    if (!widget || analysisWidgetActionsBlocked()) { closeAnalysisPopovers(); renderTrainingLoad(); return true; }
    // The panel labels a catalog-backed series from the loaded definitions,
    // so make sure they're in before staging the widget.
    await loadAnalysisMetricDefinitions();
    openAnalysisMetricPanel(widget);
    renderTrainingLoad();
    return true;
  }
  // -------------------- Dashboards UX H3: staged advanced editor --------------------
  // Every editor control below only changes editor.draft; "Save changes"
  // (training-load-analysis-editor-save) is the one place that writes.
  if (type === "training-load-analysis-close-editor") {
    releaseAnalysisEditorDraft();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-editor-save") {
    await saveAnalysisWidgetEditor(renderTrainingLoad);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-widget-title" || type === "training-load-analysis-widget-type" || type === "training-load-analysis-widget-group") {
    const editor = state.trainingLoad.analysis.editor;
    if (!editor?.draft || editor.saving) return true;
    if (type.endsWith("title")) {
      // already applied per keystroke (setTrainingLoadAnalysisEditorText) - no re-render on blur
      if (editor.draft.title === (action.value ?? "")) return true;
      editor.draft.title = action.value ?? "";
    }
    else if (type.endsWith("type")) setEditorWidgetType(editor.draft, action.value || editor.draft.widgetType);
    else editor.draft.groupBy = action.value || editor.draft.groupBy;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-widget-activity-filter" || type === "training-load-analysis-widget-component-filter") {
    const editor = state.trainingLoad.analysis.editor;
    if (!editor?.draft || editor.saving) return true;
    const next = { ...(editor.draft.localFilterOverride || {}) };
    delete next[type.endsWith("activity-filter") ? "activityId" : "componentId"];
    editor.draft.localFilterOverride = Object.keys(next).length ? next : null;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-delete-widget") {
    const a = state.trainingLoad.analysis;
    closeAnalysisPopovers();
    const target = a.widgets.find((w) => w.id === action.dataset.widgetId);
    if (!target || a.saving || analysisWidgetActionsBlocked()) { renderTrainingLoad(); return true; }
    const confirmed = window.confirm(
      `Delete "${target.title}"?\n\n`
      + "Its metrics and settings are removed from this dashboard. It cannot be undone.",
    );
    if (!confirmed) { renderTrainingLoad(); return true; }
    await deleteAnalysisWidget(action.dataset.widgetId, renderTrainingLoad);
    state.trainingLoad.analysis.editor = closedAnalysisWidgetEditor();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-add-series") {
    const editor = state.trainingLoad.analysis.editor;
    if (!editor?.draft || editor.saving) return true;
    editor.seriesKey = addEditorSeries(editor.draft);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-select-series") {
    const editor = state.trainingLoad.analysis.editor;
    if (editor?.draft && editorSeriesEntry(editor.draft, action.dataset.seriesKey)) editor.seriesKey = action.dataset.seriesKey;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-series-bind-builtin" || type === "training-load-analysis-series-bind-metric") {
    const editor = state.trainingLoad.analysis.editor;
    const entry = editorSeriesEntry(editor?.draft, action.dataset.seriesKey || editor?.seriesKey);
    if (!entry || editor.saving) return true;
    if (type.endsWith("builtin")) {
      if (BUILT_IN_SERIES.some((b) => b.key === action.dataset.builtInKey)) setEditorSeriesMetric(entry, { kind: "builtin", key: action.dataset.builtInKey });
    } else if (action.dataset.metricId) {
      setEditorSeriesMetric(entry, { kind: "metric", id: action.dataset.metricId });
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-series-up" || type === "training-load-analysis-series-down") {
    const editor = state.trainingLoad.analysis.editor;
    if (!editor?.draft || editor.saving) return true;
    moveEditorSeries(editor.draft, action.dataset.seriesKey, type.endsWith("up") ? -1 : 1);
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-analysis-delete-series") {
    const editor = state.trainingLoad.analysis.editor;
    if (!editor?.draft || editor.saving) return true;
    editor.seriesKey = removeEditorSeries(editor.draft, action.dataset.seriesKey);
    renderTrainingLoad();
    return true;
  }
  if (type?.startsWith("training-load-analysis-series-")) {
    const map = {
      "training-load-analysis-series-label": "displayLabel",
      "training-load-analysis-series-axis": "axis",
      "training-load-analysis-series-color": "color",
      "training-load-analysis-series-scope": "dataScopeLevel",
      "training-load-analysis-series-aggregation": "analyticalAggregation",
      "training-load-analysis-series-source": "sourcePolicy",
      "training-load-analysis-series-role": "aggregationRolePolicy",
      "training-load-analysis-series-coverage": "coveragePolicy",
      "training-load-analysis-series-comparison": "comparisonPeriod",
    };
    const key = map[type];
    const editor = state.trainingLoad.analysis.editor;
    const entry = editorSeriesEntry(editor?.draft, action.dataset.seriesKey);
    if (key && entry && !editor.saving) {
      const raw = typeof action.value === "string" ? action.value : "";
      // the label is applied per keystroke already - no re-render on blur
      if (key === "displayLabel" && entry.fields.displayLabel === (raw.trim() || null)) return true;
      const nullable = key === "displayLabel" || key === "color" || key === "comparisonPeriod";
      const value = key === "displayLabel" ? raw.trim() : raw;
      if (value || nullable) entry.fields[key] = value || null;
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
    // Phase B: Athletes (section "results") is part of the shared Data &
    // Analysis week - "schedule" (and the unreachable legacy "today"
    // weekly nav slot) stay fully independent, untouched by this. Phase E:
    // Overview ("overview") is now a third side of that same shared week.
    if (section === "results" || section === "overview") syncDataAnalysisSharedWeek(nav.weekStart, section);
    // perf: the week label/nav updates instantly; loadTrainingLoadWeekly
    // paints again the instant it has something to show (cached data for
    // this week if already visited, or a loading state) via onPainted.
    renderTrainingLoad();
    // code-reviewer finding (Phase D): if an athlete's own detail is open,
    // its "canonical activities this week" section reads a SEPARATE,
    // athlete+week-keyed fetch (loadResultsAthleteActivities) that this
    // week-nav action must also re-trigger - otherwise the summary tiles
    // above it (which read the live weekly payload directly) update to the
    // new week while the activities list silently keeps showing the OLD
    // week's data under the same heading. Phase E: Overview's own coverage
    // block (a wholly separate nav slot/fetch) needs exactly the same
    // treatment whenever Overview's own nav moves.
    await Promise.all([
      loadTrainingLoadWeekly(section, renderTrainingLoad),
      section === "results" && state.trainingLoad.resultsAthleteId
        ? loadResultsAthleteActivities(state.trainingLoad.resultsAthleteId, nav.weekStart, renderTrainingLoad)
        : Promise.resolve(),
      section === "overview" ? loadOverviewCoverage(nav.weekStart, renderTrainingLoad) : Promise.resolve(),
    ]);
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
    if (section === "results" || section === "overview") syncDataAnalysisSharedWeek(nav.weekStart, section);
    renderTrainingLoad();
    await Promise.all([
      loadTrainingLoadWeekly(section, renderTrainingLoad),
      section === "results" && state.trainingLoad.resultsAthleteId
        ? loadResultsAthleteActivities(state.trainingLoad.resultsAthleteId, nav.weekStart, renderTrainingLoad)
        : Promise.resolve(),
      section === "overview" ? loadOverviewCoverage(nav.weekStart, renderTrainingLoad) : Promise.resolve(),
    ]);
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
      // Phase B: week-mode Prev/Next is a real week change, shared with
      // Athletes - month-mode's own branch above only ever touches
      // monthCursor, deliberately never reaching this line or the shared
      // week (month browsing stays a local navigator, per the contract).
      syncDataAnalysisSharedWeek(cal.weekStart, "calendar");
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
    syncDataAnalysisSharedWeek(cal.weekStart, "calendar");
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
      // Phase B: this is the ONLY place a month-grid day click (a genuinely
      // different week, possibly a different month) changes the shared
      // week - a week-mode day-strip click never reaches here at all,
      // since every day in that strip already belongs to cal.weekStart's
      // own week, so newWeekStart === cal.weekStart there and this whole
      // block (shared-week sync included) is skipped, exactly matching
      // "a same-week day click must never touch weekStart."
      syncDataAnalysisSharedWeek(newWeekStart, "calendar");
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
    // Unreachable from the UI while the shell Filter is disabled on
    // Dashboards (Phase F decision (b), see docs/ai/CURRENT_STATE.md) -
    // kept for the follow-up that feeds state.trainingLoad.filter into the
    // /query payload; not dead code to delete.
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
    // weekly-cache-backed Schedule/Athletes sections and never touches
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
    // Phase E: Overview's coverage block shares this exact Filter control
    // too (reads the SAME calendarContextKey/trainingLoadFilterQuery
    // scope as Activities above) but lives in its own nav slot
    // (overviewCoverage), never state.trainingLoad.calendar - same
    // gate/eager-refresh shape as the Calendar block just above.
    //
    // code-reviewer finding (Phase E): `overviewCoverage.weekStart` is
    // NOT kept in sync by syncDataAnalysisSharedWeek (by design - see
    // that function's own comment on why an external write to it would
    // reopen the Phase D staleness-bug class), so it can lag behind the
    // real shared week if the week moved via Activities/Athletes while
    // Overview wasn't the open section. `overviewCoverage.weekStart`
    // still gates "has Overview ever been visited this session" (a
    // one-off historical fact, never wrong), but the week to actually
    // reload must be the canonical, always-synced
    // weekly.overview.weekStart - never overviewCoverage's own,
    // possibly-stale copy.
    const overviewCoverage = state.trainingLoad.overviewCoverage;
    if (overviewCoverage.weekStart) {
      overviewCoverage.data = null;
      renderTrainingLoad();
      await loadOverviewCoverage(state.trainingLoad.weekly.overview.weekStart, renderTrainingLoad);
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
    if (statusAction === "cancel" && !window.confirm("Cancel this RPE session? It can no longer be edited or reactivated - existing results stay available in Athletes.")) {
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

  // -------------------- Athletes (section key "results"): per-athlete drilldown (item 3) --------------------
  // A pure UI selection over the already-loaded weekly.results payload -
  // never a fetch, never touches state.trainingLoad.filter (see training-
  // load-view.js's own comment on filterWeeklyDataToAthlete for why).

  if (type === "training-load-results-open-athlete") {
    const athleteId = action.dataset.athleteId;
    state.trainingLoad.resultsAthleteId = athleteId;
    renderTrainingLoad();
    // Phase D: one batched fetch of this athlete's own canonical activities
    // for the shared week - never per-activity, never blocking the rest of
    // this view's own already-loaded session_feedback data from painting.
    await loadResultsAthleteActivities(athleteId, state.trainingLoad.weekly.results.weekStart, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-results-close-athlete") {
    state.trainingLoad.resultsAthleteId = null;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-results-view-activity-in-calendar") {
    // Deep-link hand-off (Phase D): "activity-specific athlete review stays
    // reachable as context" - jumps to Activities already on the right
    // day/activity, where the existing per-activity raw-values UI already
    // lives, rather than duplicating it inside Athletes.
    const cal = state.trainingLoad.calendar;
    // Derived directly from the target date, never trusted from cal's own
    // possibly-stale weekStart - Activities may never have been opened
    // yet this session, even though the shared week already has a real
    // value from Athletes' own side (Phase B only syncs on an actual
    // nav-button click, not on initial bootstrap).
    cal.weekStart = weekMondayIso(action.dataset.date);
    cal.selectedDate = action.dataset.date;
    cal.selectedActivityId = action.dataset.activityId;
    cal.selectedComponentId = null;
    syncDataAnalysisSharedWeek(cal.weekStart, "calendar");
    setTrainingLoadSection("today");
    renderTrainingLoad();
    await Promise.all([
      loadTrainingLoadCalendarWeek(renderTrainingLoad),
      loadActivityDetail(action.dataset.activityId, renderTrainingLoad),
    ]);
    renderTrainingLoad();
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
  state.trainingLoad.resultsAthleteActivities = { athleteId: "", weekStart: "", data: null, loading: false, error: "" };
  state.trainingLoad.overviewCoverage = { weekStart: "", data: null, loading: false, error: "" };
  state.trainingLoad.filter = emptyTrainingLoadFilter();
  state.trainingLoad.filterPicker = emptyTrainingLoadFilterPicker();
  state.trainingLoad.filterSnapshotAtOpen = null;
  state.trainingLoad.orgPickerData = null;
  // GPEXE imports: the old object's generation is bumped first, so a check
  // still being polled for the OLD workspace's team stops by itself.
  state.trainingLoad.gpexe.generation += 1;
  state.trainingLoad.gpexe = emptyGpexeImportState();
  // (v9) The OLD workspace's own enabled/enabledAt must never keep
  // showing (even briefly) once a switch has started - `loaded: false`
  // puts the toggle control back into its disabled "not yet known" state
  // until the new workspace's own fresh GET lands.
  state.trainingLoad.plannedRpeSetting = { enabled: false, enabledAt: null, loaded: false, loading: false, saving: false, error: "" };
}

import { api } from "./api.js";
import { isAthleteMode } from "./access.js";
import { emptyScheduleForm, emptyWellnessForm, state } from "./state.js";
import { localDateIsoInTimeZone, localMonthIsoInTimeZone } from "./utils.js";
import { checkInUrl, patchTestsAthletePickerDom, patchTestsCalendarDom, renderTestsBadge, testsAthleteMultiSelectVisibleAthletes } from "./tests-view.js";
import { loadOrgPickerData, loadPendingCount, loadScheduleDetail, loadTestsSection, loadWellnessForm } from "./tests-data.js";

// Every data-action="tests-*" click/change and data-tests-form submit in the
// Tests tab routes through here, mirroring the per-feature dispatch
// convention every other tab uses (handleOrganizationAction,
// handleWeeklyAction, ...) - see frontend/app.js's handleContentClick.

// The WELLNESS form/slider/answer handlers below are shared between the
// normal in-app Tests tab (state.tests.form) and the public check-in page
// (state.checkIn.form) - both render the exact same markup
// (renderWellnessFormHtml) into the same #content element, so the same
// delegated click/input/submit listeners in app.js fire for either. Only one
// of the two is ever set at a time (the check-in page is a completely
// separate app.js pathname branch - see check-in-actions.js), so resolving
// "whichever one is active" is unambiguous.
function activeWellnessForm() {
  return state.checkIn.form || state.tests.form;
}

export async function handleTestsAction(action, { renderTests }) {
  const type = action.dataset.action;
  if (!type?.startsWith("tests-")) return false;

  if (type === "tests-section") {
    state.tests.section = action.dataset.section;
    state.tests.scheduleDetail = null;
    state.tests.form = null;
    await reloadSection(renderTests);
    return true;
  }

  if (type === "tests-open-assignment") {
    await openAssignment(action.dataset.assignmentId, renderTests);
    return true;
  }
  if (type === "tests-close-assignment") {
    state.tests.form = null;
    await reloadSection(renderTests);
    return true;
  }
  if (type === "tests-correct-answer") {
    const form = activeWellnessForm();
    if (form) {
      form.result = null;
      // A correction is a genuinely NEW submission (values may differ) - it
      // must never reuse the original submit's idempotency key, or the
      // backend's double-submit protection (a real completed assessment
      // already exists under that key) would just replay the OLD result
      // instead of processing the correction at all.
      form.idempotencyKey = "";
    }
    renderTests();
    return true;
  }
  if (type === "tests-answer-boolean") {
    const form = activeWellnessForm();
    if (form) {
      const key = action.dataset.key;
      form.values[key] = action.dataset.value === "true";
      form.answered[key] = true;
    }
    renderTests();
    return true;
  }

  if (type === "tests-open-schedule-form") {
    // Default start date/month use the browser's own local timezone (no
    // schedule timezone has been chosen yet at this point - emptyScheduleForm
    // defaults `timezone` to this exact same value) - never a bare UTC
    // slice, which shows yesterday's/tomorrow's date for part of every day
    // depending on the user's offset from UTC.
    const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    state.tests.scheduleForm = emptyScheduleForm({
      open: true,
      timezone: defaultTimezone,
      startDate: localDateIsoInTimeZone(defaultTimezone),
      calendarMonth: localMonthIsoInTimeZone(defaultTimezone),
    });
    state.tests.bulkResult = null;
    renderTests();
    void loadOrgPickerData().then(renderTests).catch(() => {});
    return true;
  }
  if (type === "tests-dismiss-bulk-result") {
    state.tests.bulkResult = null;
    renderTests();
    return true;
  }
  if (type === "tests-calendar-prev-month" || type === "tests-calendar-next-month") {
    const form = state.tests.scheduleForm;
    const timezone = form.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const [year, month] = (form.calendarMonth || localMonthIsoInTimeZone(timezone)).split("-").map(Number);
    const delta = type === "tests-calendar-prev-month" ? -1 : 1;
    const next = new Date(Date.UTC(year, month - 1 + delta, 1));
    form.calendarMonth = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    renderTests(); // full re-render: the grid's own dimensions/labels change, no drag is in progress at this point
    return true;
  }
  if (type === "tests-calendar-remove-date") {
    const form = state.tests.scheduleForm;
    form.selectedDates = form.selectedDates.filter((d) => d !== action.dataset.date);
    patchTestsCalendarDom();
    return true;
  }
  if (type === "tests-close-schedule-form") {
    state.tests.scheduleForm = emptyScheduleForm();
    renderTests();
    return true;
  }
  if (type === "tests-open-schedule") {
    await loadScheduleDetail(action.dataset.scheduleId);
    renderTests();
    return true;
  }
  if (type === "tests-close-schedule") {
    state.tests.scheduleDetail = null;
    renderTests();
    return true;
  }
  if (type === "tests-open-edit-schedule") {
    await openEditSchedule(action.dataset.scheduleId, renderTests);
    return true;
  }
  if (type === "tests-toggle-show-cancelled") {
    state.tests.showCancelledSchedules = action.checked;
    if (action.checked && state.tests.section === "schedule") await reloadSection(renderTests);
    else renderTests();
    return true;
  }
  if (type === "tests-schedule-toggle-athlete") {
    const id = action.dataset.athleteUuid;
    const form = state.tests.scheduleForm;
    const index = form.athleteIds.indexOf(id);
    if (index >= 0) form.athleteIds.splice(index, 1);
    else form.athleteIds.push(id);
    patchTestsAthletePickerDom();
    return true;
  }
  if (type === "tests-schedule-select-all-athletes") {
    const form = state.tests.scheduleForm;
    const visible = testsAthleteMultiSelectVisibleAthletes(form);
    const selected = new Set(form.athleteIds);
    for (const athlete of visible) selected.add(athlete.athlete_uuid);
    form.athleteIds = Array.from(selected);
    patchTestsAthletePickerDom();
    return true;
  }
  if (type === "tests-schedule-clear-all-athletes") {
    state.tests.scheduleForm.athleteIds = [];
    patchTestsAthletePickerDom();
    return true;
  }
  if (type === "tests-delete-schedule") {
    await deleteSchedule(action, renderTests);
    return true;
  }
  if (type === "tests-set-schedule-status") {
    try {
      await api(`/api/tests/schedules/${encodeURIComponent(action.dataset.scheduleId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: action.dataset.status }),
      });
      // No extra GET - the schedule the coach is looking at is either the
      // open detail view (re-fetched, small/cheap and already the pattern
      // used everywhere else here) or a list row (patched in place below).
      if (state.tests.scheduleDetail?.schedule.id === action.dataset.scheduleId) {
        await loadScheduleDetail(action.dataset.scheduleId);
      }
      const row = state.tests.schedules.find((s) => s.id === action.dataset.scheduleId);
      if (row) row.status = action.dataset.status;
    } catch (error) {
      state.tests.error = error.message || "Could not update the schedule.";
    }
    renderTests();
    return true;
  }
  if (type === "tests-create-link") {
    try {
      await api(`/api/tests/schedules/${encodeURIComponent(action.dataset.scheduleId)}/link`, { method: "POST" });
      await loadScheduleDetail(action.dataset.scheduleId);
    } catch (error) {
      state.tests.error = error.message || "Could not create the group link.";
    }
    renderTests();
    return true;
  }
  if (type === "tests-revoke-link") {
    try {
      await api(`/api/tests/links/${encodeURIComponent(action.dataset.linkId)}/revoke`, { method: "POST" });
      await loadScheduleDetail(action.dataset.scheduleId);
    } catch (error) {
      state.tests.error = error.message || "Could not revoke the link.";
    }
    renderTests();
    return true;
  }
  if (type === "tests-copy-link") {
    await copyGroupLinkForSchedule(action.dataset.scheduleId);
    return true;
  }
  if (type === "tests-copy-link-url") {
    await copyToClipboard(action.dataset.url);
    return true;
  }
  if (type === "tests-open-result") {
    await openResult(action.dataset.assessmentId, renderTests);
    return true;
  }

  return false;
}

async function reloadSection(renderTests) {
  try {
    await loadTestsSection();
  } catch (error) {
    state.tests.error = error.message || "Could not load Tests.";
  }
  renderTests();
}

async function openAssignment(assignmentId, renderTests) {
  try {
    state.tests.form = await loadWellnessForm(assignmentId);
  } catch (error) {
    state.tests.error = error.message || "Could not open this check-in.";
  }
  renderTests();
}

async function openResult(assessmentId, renderTests) {
  try {
    const data = await api(`/api/tests/results/${encodeURIComponent(assessmentId)}`);
    state.tests.form = emptyWellnessForm({
      testName: "WELLNESS",
      athleteName: data.athleteName,
      canSubmit: false,
      result: { wellnessScore: data.wellnessScore },
      injuryReported: data.values?.injury === true,
    });
  } catch (error) {
    state.tests.error = error.message || "Could not load this result.";
  }
  renderTests();
}

async function copyGroupLinkForSchedule(scheduleId) {
  try {
    const detail = await api(`/api/tests/schedules/${encodeURIComponent(scheduleId)}`);
    const link = detail.link || (await api(`/api/tests/schedules/${encodeURIComponent(scheduleId)}/link`, { method: "POST" })).link;
    await copyToClipboard(checkInUrl(link.publicToken));
  } catch {
    // best-effort - nothing to surface for a toolbar shortcut copy action
  }
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard API unavailable/denied - the link is still shown as plain text.
  }
}

// ------------------------------------------------------------
// Slider drag - a lightweight, targeted DOM patch (not a full re-render) so
// dragging a slider stays smooth, matching how other continuous-input
// fields in this app avoid re-rendering on every tick.
// ------------------------------------------------------------

export function handleTestsSliderInput(input) {
  const key = input.dataset.key;
  const value = Number(input.value);
  const form = activeWellnessForm();
  if (!form) return;
  form.values[key] = value;
  form.answered[key] = true;
  const row = input.closest(".wellness-param");
  row?.classList.remove("is-unanswered");
  row?.classList.add("is-answered");
  const valueEl = row?.querySelector(".wellness-param-value");
  if (valueEl) valueEl.textContent = String(value);
  input.setAttribute("aria-valuetext", String(value));
  updateWellnessProgress(form);
}

function updateWellnessProgress(form) {
  const answeredCount = form.parameters.filter((p) => form.answered[p.key]).length;
  const progressEl = document.querySelector(".wellness-progress");
  if (progressEl) progressEl.textContent = `${answeredCount} of ${form.parameters.length} completed`;
  const allAnswered = answeredCount === form.parameters.length;
  const button = document.querySelector(".wellness-submit-button");
  if (button) button.disabled = !(allAnswered && form.canSubmit !== false && !form.submitting);
}

// ------------------------------------------------------------
// Schedule creation form field changes (select/date/time/text inputs)
// ------------------------------------------------------------

export function handleTestsScheduleFormField(fieldEl) {
  const name = fieldEl.name;
  if (!name) return;
  state.tests.scheduleForm[name] = fieldEl.value;
}

// Wired into app.js's handleContentInput (fires on every keystroke), not the
// data-action click dispatch above - a full renderTests() on every keystroke
// would replace #content's innerHTML and knock focus out of this exact input
// mid-type, so only the picker's own sub-DOM is patched.
export function handleTestsScheduleAthleteSearchInput(inputEl) {
  state.tests.scheduleForm.athleteSearch = inputEl.value;
  patchTestsAthletePickerDom();
}

// ------------------------------------------------------------
// Specific-dates calendar: click-and-drag range selection, Booking-style.
// Wired from app.js's own Pointer Events (pointerdown delegated on #content,
// document-level pointermove/pointerup/pointercancel) - see
// handleContentPointerDown/-PointerMove/handleGlobalPointerEnd there. Pointer
// Events (not separate mouse/touch listeners) is what lets one code path
// drive both a mouse drag and a touch drag identically - a tap is just a
// pointerdown+pointerup with no pointermove between, a touch drag is a
// pointermove sequence exactly like a mouse drag, just routed through
// document.elementFromPoint() in app.js instead of relying on mouseover
// (which never fires on other elements during a touch drag - only the
// original touch-start target keeps receiving events). Module-level drag
// state (not part of `state`, the app's own reactive store) deliberately:
// it's pure, ephemeral pointer interaction, never meaningful to persist/
// re-render from, and every mutation it causes to
// state.tests.scheduleForm.selectedDates is applied and painted (via
// patchTestsCalendarDom, a targeted DOM patch - see tests-view.js)
// immediately, on every single pointermove, not just at drag end.
// ------------------------------------------------------------

let calendarDragState = null; // { anchorDate, mode: "add" | "remove", baseSelected: Set }

function calendarTodayIso() {
  const form = state.tests.scheduleForm;
  const timezone = form.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return localDateIsoInTimeZone(timezone);
}

// Recomputes selectedDates as baseSelected (the selection BEFORE this drag
// started) plus/minus every date from anchorDate to currentDate inclusive -
// recomputed fresh from baseSelected on every call (not accumulated), so
// dragging back over already-covered days correctly un-does them, exactly
// like a booking site's date-range picker.
function applyCalendarDragRange(currentDate) {
  const form = state.tests.scheduleForm;
  const { anchorDate, mode, baseSelected } = calendarDragState;
  const [start, end] = anchorDate <= currentDate ? [anchorDate, currentDate] : [currentDate, anchorDate];
  const todayIso = calendarTodayIso();
  const result = new Set(baseSelected);
  const cursor = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  while (cursor <= endDate) {
    const iso = cursor.toISOString().slice(0, 10);
    if (iso >= todayIso) {
      if (mode === "remove") result.delete(iso);
      else result.add(iso);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  form.selectedDates = Array.from(result);
  patchTestsCalendarDom();
}

// mousedown on a day cell: starts a drag AND immediately applies it to just
// that one day - a plain click (mousedown+mouseup with no mouseover between)
// ends up calling only this, which is exactly "a single click adds or
// removes one date". Whether this drag ADDS or REMOVES is decided once,
// right here, from the anchor day's own current state - not re-decided per
// cell, so the whole drag moves in one consistent direction.
export function startTestsCalendarDrag(dayEl) {
  const date = dayEl?.dataset?.date;
  if (!date || dayEl.disabled) return false;
  const form = state.tests.scheduleForm;
  const alreadySelected = form.selectedDates.includes(date);
  calendarDragState = { anchorDate: date, mode: alreadySelected ? "remove" : "add", baseSelected: new Set(form.selectedDates) };
  applyCalendarDragRange(date);
  return true;
}

// Returns whether it actually extended an in-progress drag - app.js uses
// this to decide whether to preventDefault() the pointermove (stopping the
// page/panel from scrolling under a touch drag) ONLY while a calendar drag
// is genuinely in progress, never globally.
export function extendTestsCalendarDrag(dayEl) {
  if (!calendarDragState) return false;
  const date = dayEl?.dataset?.date;
  if (!date || dayEl.disabled) return false;
  applyCalendarDragRange(date);
  return true;
}

export function endTestsCalendarDrag() {
  calendarDragState = null;
}

// Cheap synchronous check app.js uses to skip its (otherwise-unconditional)
// document.elementFromPoint() lookup on every single pointermove across the
// WHOLE app - that lookup is only worth paying for while an actual calendar
// drag is in progress.
export function isTestsCalendarDragging() {
  return calendarDragState !== null;
}

// ------------------------------------------------------------
// Edit / Delete schedule
// ------------------------------------------------------------

async function openEditSchedule(scheduleId, renderTests) {
  state.tests.error = "";
  const known = state.tests.schedules.find((s) => s.id === scheduleId)
    || (state.tests.scheduleDetail?.schedule.id === scheduleId ? state.tests.scheduleDetail.schedule : null);
  // cancelled is terminal (backend/src/routes/tests.js's PATCH rejects it
  // outright regardless of body) - the Edit button is already hidden for a
  // cancelled row, this only guards a stale/known row object reached some
  // other way (e.g. this exact schedule got cancelled in another tab).
  if (known?.status === "cancelled") {
    state.tests.error = "This schedule is cancelled and can no longer be edited or reactivated. Create a new schedule instead.";
    renderTests();
    return;
  }
  // Note: hasOccurrences ALONE no longer blocks opening the edit form
  // (Phase 2.5) - a one_time schedule with an occurrence but no real
  // activity yet is still editable. The real answer (hasActivity) only
  // comes from the detail fetch below; the form itself renders the
  // blocked-vs-allowed explanation once it has that.
  try {
    const detail = await api(`/api/tests/schedules/${encodeURIComponent(scheduleId)}`);
    const targets = detail.targets || [];
    state.tests.scheduleForm = emptyScheduleForm({
      open: true,
      editingScheduleId: scheduleId,
      hasOccurrences: Boolean(detail.schedule.hasOccurrences),
      hasActivity: Boolean(detail.schedule.hasActivity),
      scheduleKind: detail.schedule.scheduleKind === "recurring" ? "daily" : "one_time",
      timezone: detail.schedule.timezone,
      startDate: detail.schedule.startDate,
      opensTime: detail.schedule.opensTime,
      dueTime: detail.schedule.dueTime || "",
      closesTime: detail.schedule.closesTime,
      athleteIds: targets.filter((t) => t.kind === "athlete").map((t) => t.id),
      teamId: targets.find((t) => t.kind === "team")?.id || "",
      clubId: targets.find((t) => t.kind === "club")?.id || "",
    });
  } catch (error) {
    state.tests.error = error.message || "Could not open this schedule for editing.";
  }
  renderTests();
  void loadOrgPickerData().then(renderTests).catch(() => {});
}

async function deleteSchedule(action, renderTests) {
  const scheduleId = action.dataset.scheduleId;
  if (state.tests.deletingScheduleId) return; // one delete in flight at a time - guards a double-click/double-submit
  const hasOccurrences = action.dataset.hasOccurrences === "true";
  const message = hasOccurrences
    ? "This schedule has existing assignments or results. It will be cancelled and hidden, while historical results will be preserved"
    : "This schedule will be permanently deleted";
  if (!window.confirm(message)) return;
  state.tests.deletingScheduleId = scheduleId;
  state.tests.error = "";
  renderTests();
  try {
    const result = await api(`/api/tests/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
    if (result.action === "deleted") {
      state.tests.schedules = state.tests.schedules.filter((s) => s.id !== scheduleId);
    } else {
      const row = state.tests.schedules.find((s) => s.id === scheduleId);
      if (row) row.status = "cancelled";
    }
    if (state.tests.scheduleDetail?.schedule.id === scheduleId) state.tests.scheduleDetail = null;
  } catch (error) {
    state.tests.error = error.message || "Could not delete this schedule.";
  } finally {
    state.tests.deletingScheduleId = "";
    renderTests();
  }
}

function buildTargetsFromForm(form) {
  const targets = form.athleteIds.map((id) => ({ kind: "athlete", id }));
  if (form.teamId) targets.push({ kind: "team", id: form.teamId });
  if (form.clubId) targets.push({ kind: "club", id: form.clubId });
  return targets;
}

// Computed locally from what was just submitted (+ the already-loaded org
// picker data for team/club display names) so create/edit never needs an
// extra GET just to refresh the list row's target-summary text - neither
// POST /schedules nor PATCH /schedules/:id's response carries these
// (they're list-only aggregate subqueries, see formatScheduleRow call sites
// in backend/src/routes/tests.js).
function targetSummaryFieldsFor(targets, orgData) {
  const athleteTargetCount = targets.filter((t) => t.kind === "athlete").length;
  const teamNames = targets.filter((t) => t.kind === "team").map((t) => orgData?.teams?.find((team) => team.id === t.id)?.name).filter(Boolean);
  const clubNames = targets.filter((t) => t.kind === "club").map((t) => orgData?.clubs?.find((club) => club.id === t.id)?.name).filter(Boolean);
  return {
    athleteTargetCount,
    teamTargetNames: teamNames.join(", ") || undefined,
    clubTargetNames: clubNames.join(", ") || undefined,
  };
}

// ------------------------------------------------------------
// Form submits
// ------------------------------------------------------------

export async function submitTestsForm(form, { renderTests }) {
  const kind = form.dataset.testsForm;
  if (kind === "wellness-submit") return submitWellnessForm(renderTests);
  if (kind === "create-schedule" || kind === "edit-schedule") return submitScheduleForm(renderTests);
  if (kind === "create-schedule-bulk") return submitBulkScheduleForm(renderTests);
}

async function submitWellnessForm(renderTests) {
  const wellnessForm = activeWellnessForm();
  if (!wellnessForm || wellnessForm.submitting) return;
  wellnessForm.submitting = true;
  wellnessForm.error = "";
  renderTests();
  try {
    if (!wellnessForm.idempotencyKey) {
      wellnessForm.idempotencyKey = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
    }
    const result = await api(`/api/tests/assignments/${encodeURIComponent(wellnessForm.assignmentId)}/submit`, {
      method: "POST",
      body: JSON.stringify({ values: wellnessForm.values, idempotencyKey: wellnessForm.idempotencyKey }),
    });
    wellnessForm.result = { wellnessScore: result.wellnessScore };
    wellnessForm.injuryReported = result.values?.injury === true;
    wellnessForm.canSubmit = true;
    void loadPendingCount().then(renderTestsBadge);
  } catch (error) {
    wellnessForm.error = error.message || "Could not save this check-in.";
  } finally {
    wellnessForm.submitting = false;
    renderTests();
  }
}

async function submitScheduleForm(renderTests) {
  const scheduleForm = state.tests.scheduleForm;
  if (scheduleForm.submitting) return;
  const isEdit = Boolean(scheduleForm.editingScheduleId);
  const targets = buildTargetsFromForm(scheduleForm);
  scheduleForm.submitting = true;
  scheduleForm.error = "";
  renderTests();
  try {
    const body = {
      scheduleKind: scheduleForm.scheduleKind,
      timezone: scheduleForm.timezone,
      startDate: scheduleForm.startDate,
      opensTime: scheduleForm.opensTime,
      dueTime: scheduleForm.dueTime || null,
      closesTime: scheduleForm.closesTime,
      targets,
    };
    let result;
    if (isEdit) {
      result = await api(`/api/tests/schedules/${encodeURIComponent(scheduleForm.editingScheduleId)}`, { method: "PATCH", body: JSON.stringify(body) });
    } else {
      const library = await api("/api/tests/library");
      const wellness = library.tests.find((t) => t.schedulable);
      result = await api("/api/tests/schedules", { method: "POST", body: JSON.stringify({ ...body, testVersionId: wellness?.testVersionId }) });
    }
    const merged = { ...result.schedule, ...targetSummaryFieldsFor(targets, state.tests.orgPickerData) };
    const existingIndex = state.tests.schedules.findIndex((s) => s.id === merged.id);
    if (existingIndex >= 0) state.tests.schedules[existingIndex] = merged;
    else state.tests.schedules.unshift(merged);
    // The detail view (if this exact schedule is open there) needs the real
    // per-target rows (id/name) for its own display, which the mutation
    // response never carries - kept as one cheap, deliberate GET, not a
    // redundant re-fetch of the whole list.
    if (state.tests.scheduleDetail?.schedule.id === merged.id) await loadScheduleDetail(merged.id);
    state.tests.scheduleForm = emptyScheduleForm();
  } catch (error) {
    scheduleForm.error = error.message || (isEdit ? "Could not save this schedule." : "Could not create this schedule.");
    scheduleForm.submitting = false;
    renderTests();
    return;
  }
  renderTests();
}

// "Specific dates" (Phase 2.5): one POST /schedules/bulk call creates N
// independent one_time schedules sharing the same test/time/targets. Same
// double-submit guard (scheduleForm.submitting) as submitScheduleForm above.
async function submitBulkScheduleForm(renderTests) {
  const scheduleForm = state.tests.scheduleForm;
  if (scheduleForm.submitting) return;
  if (!scheduleForm.selectedDates.length) return;
  const targets = buildTargetsFromForm(scheduleForm);
  scheduleForm.submitting = true;
  scheduleForm.error = "";
  renderTests();
  try {
    const library = await api("/api/tests/library");
    const wellness = library.tests.find((t) => t.schedulable);
    const result = await api("/api/tests/schedules/bulk", {
      method: "POST",
      body: JSON.stringify({
        testVersionId: wellness?.testVersionId,
        timezone: scheduleForm.timezone,
        opensTime: scheduleForm.opensTime,
        dueTime: scheduleForm.dueTime || null,
        closesTime: scheduleForm.closesTime,
        dates: scheduleForm.selectedDates,
        targets,
      }),
    });
    const summaryFields = targetSummaryFieldsFor(targets, state.tests.orgPickerData);
    for (const row of result.schedules) {
      state.tests.schedules.unshift({ ...row, ...summaryFields });
    }
    // The one place the coach sees exactly what was scheduled - how many
    // dates, and which ones - not just a form that silently closed.
    state.tests.bulkResult = { count: result.count, dates: result.dates };
    state.tests.scheduleForm = emptyScheduleForm();
  } catch (error) {
    scheduleForm.error = error.message || "Could not create these schedules.";
    scheduleForm.submitting = false;
    renderTests();
    return;
  }
  renderTests();
}

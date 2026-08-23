import { api } from "./api.js";
import { isAthleteMode } from "./access.js";
import { emptyScheduleForm, emptyWellnessForm, state } from "./state.js";
import { checkInUrl, renderTestsBadge } from "./tests-view.js";
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
    state.tests.scheduleForm = emptyScheduleForm({ open: true, startDate: new Date().toISOString().slice(0, 10) });
    renderTests();
    void loadOrgPickerData().then(renderTests).catch(() => {});
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
  if (type === "tests-set-schedule-status") {
    try {
      await api(`/api/tests/schedules/${encodeURIComponent(action.dataset.scheduleId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: action.dataset.status }),
      });
      await loadScheduleDetail(action.dataset.scheduleId);
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
  if (name === "targetKind") state.tests.scheduleForm.targetId = "";
}

// ------------------------------------------------------------
// Form submits
// ------------------------------------------------------------

export async function submitTestsForm(form, { renderTests }) {
  const kind = form.dataset.testsForm;
  if (kind === "wellness-submit") return submitWellnessForm(renderTests);
  if (kind === "create-schedule") return submitCreateSchedule(renderTests);
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

async function submitCreateSchedule(renderTests) {
  const scheduleForm = state.tests.scheduleForm;
  if (scheduleForm.submitting) return;
  scheduleForm.submitting = true;
  scheduleForm.error = "";
  renderTests();
  try {
    const library = await api("/api/tests/library");
    const wellness = library.tests.find((t) => t.schedulable);
    await api("/api/tests/schedules", {
      method: "POST",
      body: JSON.stringify({
        testVersionId: wellness?.testVersionId,
        scheduleKind: scheduleForm.scheduleKind,
        timezone: scheduleForm.timezone,
        startDate: scheduleForm.startDate,
        opensTime: scheduleForm.opensTime,
        dueTime: scheduleForm.dueTime || null,
        closesTime: scheduleForm.closesTime,
        targets: scheduleForm.targetId ? [{ kind: scheduleForm.targetKind, id: scheduleForm.targetId }] : [],
      }),
    });
    state.tests.scheduleForm = emptyScheduleForm();
    await loadTestsSection();
  } catch (error) {
    scheduleForm.error = error.message || "Could not create this schedule.";
    scheduleForm.submitting = false;
    renderTests();
    return;
  }
  renderTests();
}

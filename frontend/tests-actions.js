import { api } from "./api.js";
import { isAthleteMode } from "./access.js";
import { invalidateAthleteHomeCache } from "./athlete-home-data.js";
import { emptyScheduleForm, emptyWellnessForm, state } from "./state.js";
import { localDateIsoInTimeZone, localMonthIsoInTimeZone } from "./utils.js";
import { assignmentSetFingerprint, checkInUrl, patchRecipientPickerPanelDom, patchTestsAthletePickerDom, patchTestsCalendarDom, reminderSelectedSet, renderTestsBadge, testsAthleteMultiSelectVisibleAthletes, testsCalendarMode } from "./tests-view.js";
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

// Mobile scheduling redesign: Athletes/Notifications default collapsed only
// on a narrow viewport (matches the app's existing mobile breakpoint - see
// styles.css's @media (max-width: 760px) rules, e.g.
// .builder-mobile-sticky-bar) - read once, when the form is first opened,
// not on every render, so an in-flight window resize never surprises a
// coach mid-edit by silently collapsing/expanding a section they already
// interacted with.
function isMobileScheduleFormViewport() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;
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
    resetTestsCalendarInteractionState();
    // Default start date/month use the browser's own local timezone (no
    // schedule timezone has been chosen yet at this point - emptyScheduleForm
    // defaults `timezone` to this exact same value) - never a bare UTC
    // slice, which shows yesterday's/tomorrow's date for part of every day
    // depending on the user's offset from UTC.
    const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const mobile = isMobileScheduleFormViewport();
    state.tests.scheduleForm = emptyScheduleForm({
      open: true,
      // The calendar (specific_dates) is the default create flow - there's
      // no separate "one-time" choice to start on; the coach only ever
      // opts INTO "daily" via the pill below.
      scheduleKind: "specific_dates",
      timezone: defaultTimezone,
      startDate: localDateIsoInTimeZone(defaultTimezone),
      calendarMonth: localMonthIsoInTimeZone(defaultTimezone),
      calendarOpen: true, // "Klik na bilo koju opciju mora odmah otvoriti isti calendar component" - true from the very first render too, not just after a pill click
      calendarCancelSnapshot: { selectedDates: [] }, // matches multi mode's own snapshot shape - a brand-new form starts with nothing picked
      // Mobile compaction: Notifications starts collapsed on a narrow
      // viewport, expanded (unchanged) on desktop. Athletes is now a tab
      // inside the Recipients picker, not a standalone collapsible section.
      notificationsSectionOpen: !mobile,
      // Visible MVP defaults for a NEW schedule (spec: invitation on,
      // reminder on at 60 minutes, both coach digests on) - the coach sees
      // these checked in the form and can change any of them before saving;
      // nothing here is a hidden backend default the coach never sees.
      notificationRules: [
        { kind: "athlete_invitation", enabled: true },
        { kind: "athlete_reminder", enabled: true, reminderOffsetMinutes: 60 },
        { kind: "coach_digest", enabled: true },
        { kind: "final_digest", enabled: true },
      ],
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
  // Recurrence pill pair ("Specific dates" / "Repeat daily") - the only
  // recurrence choice a coach makes directly (create mode: "Specific dates"
  // = the calendar/specific_dates flow, "Repeat daily" = daily; edit mode:
  // "Specific dates" = the existing schedule's own one_time date, "Repeat
  // daily" = daily). A two-button toggle rather than a checkbox - much
  // harder to miss than a small "Repeat daily" label was.
  if (type === "tests-schedule-set-recurrence") {
    const form = state.tests.scheduleForm;
    const isEdit = Boolean(form.editingScheduleId);
    const daily = action.dataset.daily === "true";
    form.scheduleKind = daily ? "daily" : isEdit ? "one_time" : "specific_dates";
    // "Klik na bilo koju opciju mora odmah otvoriti isti calendar
    // component" - no separate "open the calendar" step needed anymore.
    form.calendarOpen = true;
    resetTestsCalendarInteractionState();
    // Item 2: snapshot whatever this mode's own fields already held, taken
    // the instant the calendar opens - the calendar header's own X restores
    // exactly this if the coach backs out of everything picked in this one
    // open/close session.
    form.calendarCancelSnapshot = snapshotCalendarFields(form);
    renderTests();
    return true;
  }
  if (type === "tests-calendar-cancel") {
    const form = state.tests.scheduleForm;
    restoreCalendarFields(form, form.calendarCancelSnapshot);
    form.calendarCancelSnapshot = null;
    form.calendarOpen = false;
    resetTestsCalendarInteractionState();
    renderTests();
    return true;
  }
  if (type === "tests-calendar-confirm") {
    const form = state.tests.scheduleForm;
    form.calendarCancelSnapshot = null;
    form.calendarOpen = false;
    resetTestsCalendarInteractionState();
    renderTests();
    return true;
  }
  if (type === "tests-toggle-notifications-section") {
    state.tests.scheduleForm.notificationsSectionOpen = !state.tests.scheduleForm.notificationsSectionOpen;
    renderTests();
    return true;
  }
  if (type === "tests-toggle-advanced-settings") {
    state.tests.scheduleForm.advancedSettingsOpen = !state.tests.scheduleForm.advancedSettingsOpen;
    renderTests();
    return true;
  }
  // One of the 4 compact Notifications switch rows (invitation/reminder/
  // coach live digest/final digest) - item 3's redesign made this a plain
  // button (role="switch"), not a native checkbox, so it flips its own
  // `enabled` in state directly rather than reading a DOM `.checked`. Same
  // backend contract/rule shape as before this redesign. A kind not yet
  // present in notificationRules (an unconfigured existing schedule, or a
  // kind the coach hasn't touched yet) is created on first interaction
  // rather than requiring every kind to already have a row.
  if (type === "tests-notification-rule-toggle") {
    const kind = action.dataset.kind;
    const form = state.tests.scheduleForm;
    let rule = form.notificationRules.find((r) => r.kind === kind);
    if (!rule) {
      rule = kind === "athlete_reminder" ? { kind, enabled: false, reminderOffsetMinutes: 60 } : { kind, enabled: false };
      form.notificationRules.push(rule);
    }
    rule.enabled = !rule.enabled;
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
    resetTestsCalendarInteractionState();
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
  if (type === "tests-schedule-again") {
    await openScheduleAgain(action.dataset.scheduleId, renderTests);
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
  // Item 1: the unified Recipients picker (Clubs/Teams/Athletes tabs). Open
  // snapshots the current selection so its own X (cancel) can revert
  // everything picked in this one open/close session, mirroring the
  // calendar's own cancel snapshot above - Confirm (check) just closes.
  if (type === "tests-open-recipient-picker") {
    const form = state.tests.scheduleForm;
    if (!state.tests.orgPickerData) await loadOrgPickerData();
    form.recipientPickerOpen = true;
    form.recipientPickerSnapshot = { athleteIds: form.athleteIds.slice(), teamIds: form.teamIds.slice(), clubIds: form.clubIds.slice() };
    renderTests();
    return true;
  }
  if (type === "tests-recipient-picker-cancel") {
    const form = state.tests.scheduleForm;
    if (form.recipientPickerSnapshot) {
      form.athleteIds = form.recipientPickerSnapshot.athleteIds.slice();
      form.teamIds = form.recipientPickerSnapshot.teamIds.slice();
      form.clubIds = form.recipientPickerSnapshot.clubIds.slice();
    }
    form.recipientPickerSnapshot = null;
    form.recipientPickerOpen = false;
    renderTests();
    return true;
  }
  if (type === "tests-recipient-picker-confirm") {
    const form = state.tests.scheduleForm;
    form.recipientPickerSnapshot = null;
    form.recipientPickerOpen = false;
    renderTests();
    return true;
  }
  if (type === "tests-recipient-picker-set-tab") {
    // "data-tab" is a reserved attribute name elsewhere in this app -
    // app.js's handleGlobalClick treats ANY element with data-tab, anywhere
    // in the document, as a top-level sidebar tab switch (event.target.
    // closest("[data-tab]")), which fires BEFORE this handler and would
    // hijack a click on the picker's own Clubs/Teams/Athletes tab into
    // switching state.activeTab to a garbage value instead - found live.
    // data-recipient-tab avoids that collision entirely.
    state.tests.scheduleForm.recipientPickerTab = action.dataset.recipientTab;
    patchRecipientPickerPanelDom();
    return true;
  }
  if (type === "tests-recipient-picker-toggle") {
    const kind = action.dataset.kind;
    const id = action.dataset.id;
    const form = state.tests.scheduleForm;
    const key = kind === "club" ? "clubIds" : "teamIds";
    const list = form[key];
    const index = list.indexOf(id);
    if (index >= 0) list.splice(index, 1);
    else list.push(id);
    patchRecipientPickerPanelDom();
    return true;
  }
  if (type === "tests-recipient-picker-select-all") {
    const kind = action.dataset.kind;
    const form = state.tests.scheduleForm;
    const orgData = state.tests.orgPickerData;
    const items = kind === "club" ? orgData?.clubs || [] : orgData?.teams || [];
    const key = kind === "club" ? "clubIds" : "teamIds";
    const selected = new Set(form[key]);
    for (const item of items) selected.add(item.id);
    form[key] = Array.from(selected);
    patchRecipientPickerPanelDom();
    return true;
  }
  if (type === "tests-recipient-picker-clear") {
    const kind = action.dataset.kind;
    const form = state.tests.scheduleForm;
    form[kind === "club" ? "clubIds" : "teamIds"] = [];
    patchRecipientPickerPanelDom();
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
  if (type === "tests-reminder-toggle-athlete") {
    toggleReminderAthlete(action.dataset.scheduleId, action.dataset.assignmentId);
    renderTests();
    return true;
  }
  if (type === "tests-reminder-select-all") {
    setReminderSelectionToAllIncomplete(action.dataset.scheduleId);
    renderTests();
    return true;
  }
  if (type === "tests-reminder-clear") {
    clearReminderSelection(action.dataset.scheduleId);
    renderTests();
    return true;
  }
  if (type === "tests-send-reminder") {
    await sendManualReminder(action.dataset.scheduleId, renderTests);
    return true;
  }
  if (type === "tests-copy-viber") {
    await copyViberMessageForSchedule(action.dataset.scheduleId);
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

export async function openAssignment(assignmentId, renderTests) {
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
      scheduleId: data.scheduleId || "",
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

// ------------------------------------------------------------
// Manual reminder (Coach Today) - hotfix
// ------------------------------------------------------------

function coachTodayGroupById(scheduleId) {
  return state.tests.coachToday.find((group) => group.schedule.id === scheduleId);
}

// Item 4 correction: reminderSelection[scheduleId] is now { fingerprint,
// ids }, not a bare array - see assignmentSetFingerprint/reminderSelectedSet
// (tests-view.js) for why. Every write here stamps the CURRENT fingerprint
// alongside the ids, so a later render against a DIFFERENT set (a new
// day's daily occurrence, a membership change) correctly recognizes this
// stored value as stale and falls back to the default instead of showing a
// wrong or empty list.
function toggleReminderAthlete(scheduleId, assignmentId) {
  const group = coachTodayGroupById(scheduleId);
  if (!group) return;
  // reminderSelectedSet already resolves the correct CURRENT set (default
  // or a still-valid override, fingerprint-checked) - toggling always
  // starts from that, never a possibly-stale raw stored array.
  const current = new Set(reminderSelectedSet(group));
  if (current.has(assignmentId)) current.delete(assignmentId);
  else current.add(assignmentId);
  state.tests.reminderSelection[scheduleId] = { fingerprint: assignmentSetFingerprint(group), ids: [...current] };
}

function setReminderSelectionToAllIncomplete(scheduleId) {
  const group = coachTodayGroupById(scheduleId);
  if (!group) return;
  const ids = group.athletes.filter((row) => row.status !== "completed").map((row) => row.assignmentId);
  state.tests.reminderSelection[scheduleId] = { fingerprint: assignmentSetFingerprint(group), ids };
}

function clearReminderSelection(scheduleId) {
  const group = coachTodayGroupById(scheduleId);
  if (!group) return;
  // An explicit, genuinely empty choice - stamped with the current
  // fingerprint so it is NOT mistaken for a stale/default state and
  // silently reset back to "select all" on the next render.
  state.tests.reminderSelection[scheduleId] = { fingerprint: assignmentSetFingerprint(group), ids: [] };
}

// Item 5/6 correction: when nothing (or fewer than selected) got notified,
// say why instead of a bare "Reminder sent to 0 athletes." - a coach
// clicking Send right after a previous send, or right as a window closes,
// needs to know it wasn't silently ignored.
function reminderConfirmationMessage({ results = [], notifiedCount, noUserCount }) {
  let message = `Reminder sent to ${notifiedCount} athlete${notifiedCount === 1 ? "" : "s"}.`;
  if (noUserCount) message += ` ${noUserCount} athlete${noUserCount === 1 ? "" : "s"} ${noUserCount === 1 ? "has" : "have"} no app account.`;
  const cooldownCount = results.filter((r) => r.outcome === "skippedCooldown").length;
  if (cooldownCount) message += ` ${cooldownCount} already reminded in the last few minutes.`;
  const closedCount = results.filter((r) => r.outcome === "skippedClosed" || r.outcome === "skippedNotOpen").length;
  if (closedCount) message += ` ${closedCount} outside their own open check-in window.`;
  return message;
}

async function sendManualReminder(scheduleId, renderTests) {
  const group = coachTodayGroupById(scheduleId);
  if (!group || state.tests.remindingScheduleId) return;
  const assignmentIds = [...reminderSelectedSet(group)];
  if (!assignmentIds.length) return;
  state.tests.remindingScheduleId = scheduleId;
  state.tests.reminderResult = null;
  renderTests();
  try {
    const result = await api(`/api/tests/schedules/${encodeURIComponent(scheduleId)}/remind`, {
      method: "POST",
      body: JSON.stringify({ assignmentIds }),
    });
    state.tests.reminderResult = { scheduleId, message: reminderConfirmationMessage(result) };
  } catch (error) {
    state.tests.reminderResult = { scheduleId, message: error.message || "Could not send the reminder." };
  } finally {
    state.tests.remindingScheduleId = "";
    renderTests();
  }
}

// "Ako link ne postoji, ponudi da se kreira postojećim bezbednim mehanizmom
// ili kopiraj poruku bez linka" - reuses the exact same fetch-or-create flow
// copyGroupLinkForSchedule already established; a failure of that (network,
// or the coach simply has no manageable access to create one) falls back to
// a linkless message rather than ever fabricating a public URL.
async function copyViberMessageForSchedule(scheduleId) {
  const group = coachTodayGroupById(scheduleId);
  if (!group) return;
  const selected = reminderSelectedSet(group);
  const names = group.athletes.filter((row) => selected.has(row.assignmentId)).map((row) => row.athleteName);
  if (!names.length) return;
  let linkUrl = "";
  try {
    const detail = await api(`/api/tests/schedules/${encodeURIComponent(scheduleId)}`);
    const link = detail.link || (await api(`/api/tests/schedules/${encodeURIComponent(scheduleId)}/link`, { method: "POST" })).link;
    linkUrl = checkInUrl(link.publicToken);
  } catch {
    // Existing secure mechanism unavailable right now - fall back to a
    // linkless message below rather than inventing public access.
  }
  const namesText = names.join(", ");
  const message = linkUrl
    ? `WELLNESS još nisu popunili: ${namesText}. Molimo popunite anketu: ${linkUrl}`
    : `WELLNESS još nisu popunili: ${namesText}.`;
  await copyToClipboard(message);
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
  // The reminder-offset number input writes into the nested
  // notificationRules array (one entry per kind), not a flat
  // scheduleForm[name] field like every other input here - special-cased
  // rather than generalizing this whole function, since it's the only field
  // that isn't a direct 1:1 scheduleForm property.
  if (name === "reminderOffsetMinutes") {
    const form = state.tests.scheduleForm;
    const minutes = Math.max(1, Math.round(Number(fieldEl.value)) || 60);
    let rule = form.notificationRules.find((r) => r.kind === "athlete_reminder");
    if (!rule) {
      rule = { kind: "athlete_reminder", enabled: false };
      form.notificationRules.push(rule);
    }
    rule.reminderOffsetMinutes = minutes;
    return;
  }
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

let calendarDragState = null; // multi: {kind:"multi", anchorDate, mode:"add"|"remove", baseSelected} | range/single: {kind:"range"|"single", anchorDate, extended}
// Range mode's two-CLICK flow ("Prvi datum predstavlja početak. Drugi datum
// predstavlja kraj.") - the day of a plain click (no drag) that started a
// fresh single-day range, remembered until the NEXT plain click completes
// it (or a real drag/mode-switch/form-close supersedes it). Deliberately
// module-level, like calendarDragState, not part of reactive state - it's
// pure interaction bookkeeping between two separate pointer sessions.
let pendingRangeStart = null;

export function resetTestsCalendarInteractionState() {
  calendarDragState = null;
  pendingRangeStart = null;
}

// Item 2: what the calendar's own header X restores. Keyed on the mode's
// own fields (multi -> selectedDates, range/single -> startDate/endDate) so
// switching mode never tries to "restore" a field the new mode doesn't use.
function snapshotCalendarFields(form) {
  const mode = testsCalendarMode(form);
  if (mode === "multi") return { selectedDates: form.selectedDates.slice() };
  return { startDate: form.startDate, endDate: form.endDate };
}

function restoreCalendarFields(form, snapshot) {
  if (!snapshot) return;
  if (Object.prototype.hasOwnProperty.call(snapshot, "selectedDates")) {
    form.selectedDates = snapshot.selectedDates.slice();
    return;
  }
  form.startDate = snapshot.startDate;
  form.endDate = snapshot.endDate;
}

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

function applyRangeSpan(form, a, b) {
  form.startDate = a <= b ? a : b;
  form.endDate = a <= b ? b : a;
  patchTestsCalendarDom();
}

// mousedown on a day cell. Multi mode (specific_dates): starts a drag AND
// immediately applies it to just that one day - a plain click ends up
// calling only this, which is exactly "a single click adds or removes one
// date"; whether the drag ADDS or REMOVES is decided once, from the anchor
// day's own current state. Range/single mode (daily / one_time edit):
// provisionally shows a one-day span at the anchor - extendTestsCalendarDrag
// grows it into a real range if a drag follows; endTestsCalendarDrag below
// resolves the two-CLICK ("first date = start, second date = end") flow if
// it doesn't.
export function startTestsCalendarDrag(dayEl) {
  const date = dayEl?.dataset?.date;
  if (!date || dayEl.disabled) return false;
  const form = state.tests.scheduleForm;
  const mode = testsCalendarMode(form);
  if (mode === "multi") {
    const alreadySelected = form.selectedDates.includes(date);
    calendarDragState = { kind: "multi", anchorDate: date, mode: alreadySelected ? "remove" : "add", baseSelected: new Set(form.selectedDates) };
    applyCalendarDragRange(date);
    return true;
  }
  calendarDragState = { kind: mode, anchorDate: date, extended: false };
  applyRangeSpan(form, date, date);
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
  const form = state.tests.scheduleForm;
  if (calendarDragState.kind === "multi") {
    applyCalendarDragRange(date);
    return true;
  }
  calendarDragState.extended = true;
  if (calendarDragState.kind === "single") applyRangeSpan(form, date, date);
  else applyRangeSpan(form, calendarDragState.anchorDate, date);
  return true;
}

// Item 2: "Daily" must auto-close the calendar once its range is genuinely
// COMPLETED (a finished drag, or the second click of the two-click flow) -
// but never after just the first click/date, which would otherwise create a
// one-day daily schedule by accident. Returns true exactly when it closed
// the calendar, so app.js's pointerup/pointercancel listeners know to run a
// full renderTests() (a structural show/hide, not something the lightweight
// patchTestsCalendarDom() can express). "single" mode (one_time edit) never
// auto-closes, preserving its existing edit-mode behavior.
export function endTestsCalendarDrag() {
  const drag = calendarDragState;
  calendarDragState = null;
  if (!drag || drag.kind === "multi" || drag.kind === "single") return false;
  const form = state.tests.scheduleForm;
  if (drag.extended) {
    // A real drag already fully resolved the range live, in
    // extendTestsCalendarDrag - any earlier pending two-click state is now
    // stale, and the range is genuinely complete.
    pendingRangeStart = null;
    form.calendarOpen = false;
    form.calendarCancelSnapshot = null;
    return true;
  }
  // Range mode, no drag occurred - this was a plain click. Two-click flow:
  // the first plain click of a fresh selection just remembers its day
  // (already shown as a provisional one-day span by startTestsCalendarDrag
  // above) and must NOT close the calendar yet; a second plain click on a
  // DIFFERENT day completes the range between them and closes it.
  if (pendingRangeStart && pendingRangeStart !== drag.anchorDate) {
    applyRangeSpan(form, pendingRangeStart, drag.anchorDate);
    pendingRangeStart = null;
    form.calendarOpen = false;
    form.calendarCancelSnapshot = null;
    return true;
  }
  applyRangeSpan(form, drag.anchorDate, drag.anchorDate);
  pendingRangeStart = drag.anchorDate;
  return false;
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
    resetTestsCalendarInteractionState();
    const mobile = isMobileScheduleFormViewport();
    const timezone = detail.schedule.timezone;
    state.tests.scheduleForm = emptyScheduleForm({
      open: true,
      editingScheduleId: scheduleId,
      hasOccurrences: Boolean(detail.schedule.hasOccurrences),
      hasActivity: Boolean(detail.schedule.hasActivity),
      scheduleKind: detail.schedule.scheduleKind === "recurring" ? "daily" : "one_time",
      timezone,
      startDate: detail.schedule.startDate,
      // A legacy daily schedule created before this field existed may have
      // no end_date at all (open-ended) - default the range calendar's end
      // to match start (a valid, submittable one-day span the coach can
      // then drag/click to extend), rather than leaving it blank and
      // blocking Save on a schedule that already existed just fine before.
      endDate: detail.schedule.endDate || detail.schedule.startDate,
      calendarMonth: localMonthIsoInTimeZone(timezone),
      calendarOpen: true,
      // Range/single mode's own snapshot shape (see snapshotCalendarFields) -
      // an edit form opens with the calendar already showing the existing
      // schedule's dates, so "before this calendar-opening" is exactly that.
      calendarCancelSnapshot: { startDate: detail.schedule.startDate, endDate: detail.schedule.endDate || detail.schedule.startDate },
      opensTime: detail.schedule.opensTime,
      dueTime: detail.schedule.dueTime || "",
      closesTime: detail.schedule.closesTime,
      athleteIds: targets.filter((t) => t.kind === "athlete").map((t) => t.id),
      teamIds: targets.filter((t) => t.kind === "team").map((t) => t.id),
      clubIds: targets.filter((t) => t.kind === "club").map((t) => t.id),
      notificationsSectionOpen: !mobile,
      // [] here means "never configured" (see state.js's own comment) - the
      // form renders that as a visible unconfigured state, never silently
      // treating it as either all-enabled or all-disabled.
      notificationRules: detail.notificationRules || [],
    });
  } catch (error) {
    state.tests.error = error.message || "Could not open this schedule for editing.";
  }
  renderTests();
  void loadOrgPickerData().then(renderTests).catch(() => {});
}

// Item 4: "Schedule again" - loads the ORIGINAL schedule read-only (the
// same GET already used for edit/detail) and opens a brand-new schedule
// form pre-filled from it, but this is deliberately never editingScheduleId
// - only scheduleAgainFromId (display/labeling only). That keeps the form's
// own isEdit check false, so submitting it always goes through the normal
// CREATE path (POST /schedules or /schedules/bulk - see submitTestsForm's
// dispatch on scheduleForm.scheduleKind), never a PATCH of the original.
// The original schedule, its occurrences/assignments/results and its
// access link are never touched by any of this. Per spec: copies test
// version (looked up fresh at submit time anyway, nothing to copy here),
// Dates/Daily mode, targets, times, notification rules, and the fallback
// timezone; never copies dates/start/end/status/history/results/link/
// metadata - those simply aren't read from `detail` at all below.
async function openScheduleAgain(scheduleId, renderTests) {
  state.tests.error = "";
  try {
    const detail = await api(`/api/tests/schedules/${encodeURIComponent(scheduleId)}`);
    const targets = detail.targets || [];
    resetTestsCalendarInteractionState();
    const mobile = isMobileScheduleFormViewport();
    const timezone = detail.schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    // recurring -> "daily" (same mode, fresh start/end still required);
    // one_time -> "specific_dates" (a fresh, create-mode multi-date pick -
    // there's no meaningful "one_time schedule-again" distinct from just
    // picking new dates).
    const scheduleKind = detail.schedule.scheduleKind === "recurring" ? "daily" : "specific_dates";
    state.tests.scheduleForm = emptyScheduleForm({
      open: true,
      scheduleAgainFromId: scheduleId,
      scheduleKind,
      timezone,
      calendarMonth: localMonthIsoInTimeZone(timezone),
      // Deliberately no startDate/endDate/selectedDates here - "Schedule
      // again" requires picking NEW dates, never inherits the original's.
      // emptyScheduleForm's own defaults ("", "", []) already leave them
      // unset, which is exactly what's needed.
      calendarOpen: true,
      calendarCancelSnapshot: scheduleKind === "daily" ? { startDate: "", endDate: "" } : { selectedDates: [] },
      opensTime: detail.schedule.opensTime,
      dueTime: detail.schedule.dueTime || "",
      closesTime: detail.schedule.closesTime,
      athleteIds: targets.filter((t) => t.kind === "athlete").map((t) => t.id),
      teamIds: targets.filter((t) => t.kind === "team").map((t) => t.id),
      clubIds: targets.filter((t) => t.kind === "club").map((t) => t.id),
      notificationsSectionOpen: !mobile,
      notificationRules: (detail.notificationRules || []).map((rule) => ({ ...rule })),
    });
  } catch (error) {
    state.tests.error = error.message || "Could not load this schedule to reuse.";
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
  for (const id of form.teamIds) targets.push({ kind: "team", id });
  for (const id of form.clubIds) targets.push({ kind: "club", id });
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
    // Item 5: a completed WELLNESS submit must never leave the Home card
    // showing a stale "still pending" state - invalidate its cache so the
    // next Home visit re-fetches instead of serving the cached snapshot
    // from before this submit (same pattern Builder mutations already use).
    invalidateAthleteHomeCache();
  } catch (error) {
    wellnessForm.error = error.message || "Could not save this check-in.";
  } finally {
    wellnessForm.submitting = false;
    renderTests();
  }
}

// Strips the array down to exactly what the API accepts (kind/enabled/
// reminderOffsetMinutes - nothing else the form might carry internally).
function notificationRulesForSubmit(scheduleForm) {
  return scheduleForm.notificationRules.map((rule) => ({
    kind: rule.kind,
    enabled: rule.enabled,
    reminderOffsetMinutes: rule.reminderOffsetMinutes,
  }));
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
      // Only "daily" carries a real end_date - a one_time schedule's own
      // endDate is always just its startDate again (the backend already
      // defaults it that way too, see insertScheduleRow/PATCH in
      // backend/src/routes/tests.js), so there's nothing meaningful to send
      // for it here.
      endDate: scheduleForm.scheduleKind === "daily" ? (scheduleForm.endDate || null) : null,
      opensTime: scheduleForm.opensTime,
      dueTime: scheduleForm.dueTime || null,
      closesTime: scheduleForm.closesTime,
      targets,
      notificationRules: notificationRulesForSubmit(scheduleForm),
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
        notificationRules: notificationRulesForSubmit(scheduleForm),
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

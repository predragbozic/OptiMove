import { api } from "./api.js";
import { isAthleteMode } from "./access.js";
import { emptyWellnessForm, state } from "./state.js";

// Tests module (Phase 2 - WELLNESS). Deliberately plain fetch-on-entry, not
// the shared view-cache (view-cache.js) other tabs use - Today's counts and
// an assignment's own submit state change on nearly every visit (a coach
// checking in mid-day, an athlete who just answered), so a 30s-fresh cache
// would routinely show stale completion counts. The nav badge follows the
// same on-demand convention notifications.js already uses (fetched when
// needed, never polled).

export async function loadTests({ setLoading, renderTests } = {}) {
  state.tests.error = "";
  if (isAthleteMode()) {
    if (!["today", "upcoming", "history"].includes(state.tests.section)) state.tests.section = "today";
  } else if (!["today", "schedule", "results", "library"].includes(state.tests.section)) {
    state.tests.section = "today";
  }
  setLoading?.("Loading Tests...");
  try {
    await loadTestsSection();
    renderTests();
  } catch (error) {
    state.tests.error = error.message || "Could not load Tests.";
    renderTests();
  }
}

export async function loadTestsSection() {
  const section = state.tests.section;
  if (isAthleteMode()) {
    if (section === "today") {
      const data = await api("/api/tests/athlete/today");
      state.tests.athleteToday = data.assignments || [];
    } else if (section === "upcoming") {
      const data = await api("/api/tests/athlete/upcoming");
      state.tests.athleteUpcoming = data.upcoming || [];
    } else if (section === "history") {
      const data = await api("/api/tests/athlete/history");
      state.tests.athleteHistory = data.history || [];
    }
    return;
  }
  if (section === "today") {
    const data = await api("/api/tests/today");
    state.tests.coachToday = data.groups || [];
  } else if (section === "schedule") {
    const data = await api("/api/tests/schedules");
    state.tests.schedules = data.schedules || [];
  } else if (section === "results") {
    const query = state.tests.resultsScheduleId ? `?scheduleId=${encodeURIComponent(state.tests.resultsScheduleId)}` : "";
    const data = await api(`/api/tests/results${query}`);
    state.tests.results = data.results || [];
  } else if (section === "library") {
    const data = await api("/api/tests/library");
    state.tests.library = { tests: data.tests || [], batteries: data.batteries || [] };
  }
}

export async function loadPendingCount() {
  if (!isAthleteMode()) return;
  try {
    const data = await api("/api/tests/athlete/today");
    state.tests.pendingCount = (data.assignments || []).filter((a) => a.status !== "completed").length;
  } catch {
    // Badge is best-effort - a failed background count must never surface an error banner.
  }
}

export async function loadWellnessForm(assignmentId) {
  const data = await api(`/api/tests/assignments/${encodeURIComponent(assignmentId)}`);
  return formFromAssignmentDetail(data);
}

export function formFromAssignmentDetail(data) {
  const values = {};
  const answered = {};
  if (data.latestAssessment?.status === "completed") {
    for (const param of data.parameters) {
      if (Object.prototype.hasOwnProperty.call(data.latestAssessment.values, param.key)) {
        values[param.key] = data.latestAssessment.values[param.key];
        answered[param.key] = true;
      }
    }
  }
  return emptyWellnessForm({
    assignmentId: data.assignment.id,
    testName: data.testVersion.name,
    athleteName: data.assignment.athlete.name,
    opensAt: data.assignment.occurrence.opensAt,
    closesAt: data.assignment.occurrence.closesAt,
    canSubmit: data.canSubmit,
    parameters: data.parameters,
    values,
    answered,
    latestAssessment: data.latestAssessment,
    result: data.latestAssessment?.status === "completed" ? { wellnessScore: data.latestAssessment.wellnessScore } : null,
  });
}

export async function loadScheduleDetail(scheduleId) {
  const data = await api(`/api/tests/schedules/${encodeURIComponent(scheduleId)}`);
  state.tests.scheduleDetail = data;
}

export async function loadOrgPickerData() {
  if (state.tests.orgPickerData) return state.tests.orgPickerData;
  const data = await api("/api/organization");
  state.tests.orgPickerData = data;
  return data;
}

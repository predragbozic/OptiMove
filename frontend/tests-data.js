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

// Phase 4: the athlete's own device reports its IANA timezone via Intl -
// never a manual picker (see backend/src/routes/tests.js's POST /athlete/
// timezone, which strictly validates it server-side). Correction: this must
// be AWAITED, not fire-and-forget, by every caller BEFORE the first GET
// that could trigger materialization (athlete Today/upcoming, coach Today,
// check-in's my-assignment - all of them call ensureCurrentOccurrence()
// server-side) - otherwise that GET can materialize an assignment using the
// stale/fallback timezone, permanently snapshotting the wrong one for that
// occurrence (see the DB-enforced immutability trigger in migrations_v2/
// 202608300900_..._phase4_assignment_timezone_window.sql - once wrong, it
// can never be corrected after the fact). A FAILED report must still never
// block the app: this function swallows its own errors and always
// resolves, so `await`ing it is always safe - the schedule-level fallback
// timezone still covers this athlete either way. Callers: app.js's init()
// (authenticated athlete app bootstrap - covers the nav badge's own
// GET /athlete/today too, not just the Tests tab), loadTests() below (a
// defensive fallback for any path that reaches the Tests tab without going
// through init(), e.g. a manual tab switch), and check-in-actions.js (the
// authenticated group-link entry, both the already-logged-in-on-open and
// the fresh-login-on-this-page paths).
//
// Round 3 hardening (item 3): this used to cache "have I already POSTed
// this exact timezone value in this page session" (a bare timezone string,
// module-level) and skip repeat calls for the same value. That cache was
// keyed ONLY by the timezone string, never by which account was logged in
// when it was recorded - athlete A logging out and athlete B logging back
// in on the same device, in the same timezone, would then silently skip
// B's own POST entirely (the string still matched from A's earlier call),
// leaving B's row never actually updated for B. There is no reliable
// per-request account identity available at every one of this function's
// call sites (check-in-actions.js in particular never populates
// state.currentUser at all - see that file's own header), so rather than
// invent one, this now always sends the request - correctness over shaving
// a network call. The backend endpoint is the one that now avoids
// unnecessary writes (an `is distinct from` no-op when the value hasn't
// actually changed), which is where that guard actually belongs, since
// it's the only place that reliably knows both "whose row this is" and
// "what it already says".
// Deliberately NOT gated on isAthleteMode() here: that's a DOM-class check
// (document.body.classList.contains("athlete-mode")) that the check-in
// page (check-in-actions.js) never sets - it stays in "login-mode" even
// for a genuinely logged-in athlete, so that guard would silently skip
// reporting on exactly the flow item 2 (round 1) explicitly calls out. The
// backend endpoint (POST /api/tests/athlete/timezone) already requires a
// real athlete profile server-side (requireAthlete) and returns a plain 403
// otherwise - swallowed by the catch below exactly like any other
// best-effort failure - so calling this from a coach session (e.g. the
// main app's own init() bootstrap, which runs for every account) costs one
// harmless extra request, never a wrong report.
export async function reportDeviceTimezone() {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone) return;
    await api("/api/tests/athlete/timezone", { method: "POST", body: JSON.stringify({ timezone }) });
  } catch {
    // Best-effort - see comment above.
  }
}

export async function loadTests({ setLoading, renderTests } = {}) {
  state.tests.error = "";
  if (isAthleteMode()) {
    if (!["today", "upcoming", "history"].includes(state.tests.section)) state.tests.section = "today";
    await reportDeviceTimezone();
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
    // Item 4/6 correction: a fresh Today load always clears the previous
    // confirmation banner - a stale "Reminder sent to..." message from an
    // earlier visit must never linger over a genuinely new view of the
    // data. The SELECTION itself is intentionally NOT wiped here - see
    // reminderSelectedSet's own fingerprint-based staleness check
    // (tests-view.js), which self-corrects a stale selection without
    // discarding one that's still genuinely valid.
    state.tests.reminderResult = null;
  } else if (section === "schedule") {
    const query = state.tests.showCancelledSchedules ? "?includeCancelled=true" : "";
    const data = await api(`/api/tests/schedules${query}`);
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
    athleteImageUrl: data.assignment.athlete.imageUrl || "",
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

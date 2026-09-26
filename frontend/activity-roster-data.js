// Phase 5a3a: the team roster of the open session, read-only.
// GET /api/training-activity/:activityId/roster (Phase 5a1, PR #122).
// Contract: docs/ai/phase5a3-roster-ux-draft.md (sections 1, 2, 3, 9).
//
// Not cached across sessions on purpose: the roster changes whenever a
// coach decides or a source imports, and the answer is small. A request
// generation guards against a slower, older answer overwriting a newer one
// (the same pattern as training-load-calendar-data.js).
import { api } from "./api.js";
import { state } from "./state.js";

let rosterGeneration = 0;

function rosterState() {
  return state.trainingLoad.calendar.roster;
}

// Starts a fresh roster for another session (never shows the previous
// session's roster while loading).
export function resetActivityRoster(activityId) {
  const r = rosterState();
  r.activityId = activityId;
  r.data = null;
  r.loading = false;
  r.error = null;
  r.applicable = null;
  r.filter = null;
  r.openDisclosures = [];
  r.closedDisclosures = [];
  r.autoTabFor = null;
  r.userPickedTab = false;
}

// How the roster answer failed, in terms the view can show. A session
// that is not team-owned (409 roster_not_applicable) and one this viewer
// may not see (the identical 404) both mean "no roster here".
function classifyError(error) {
  if (error?.status === 409 && error?.data?.error === "roster_not_applicable") return { kind: "not_applicable" };
  if (error?.status === 404) return { kind: "not_found" };
  return { kind: "failed" };
}

export async function loadActivityRoster(activityId, onPainted) {
  const r = rosterState();
  if (r.activityId !== activityId) resetActivityRoster(activityId);
  const generation = ++rosterGeneration;
  r.loading = true;
  r.error = null;
  onPainted?.();
  try {
    const data = await api(`/api/training-activity/${encodeURIComponent(activityId)}/roster`);
    if (generation !== rosterGeneration || rosterState().activityId !== activityId) return;
    if (String(data?.activity?.id || "") !== String(activityId)) {
      r.data = null;
      r.applicable = false;
      r.loading = false;
      r.error = { kind: "failed" };
    } else if (data.canonicalActivityId && String(data.canonicalActivityId) !== String(activityId)) {
      // The read resolves aliases and answers 200. Do not show the canonical
      // roster under the superseded id; offer the canonical session instead.
      r.data = null;
      r.applicable = true;
      r.loading = false;
      r.error = { kind: "superseded", canonicalActivityId: String(data.canonicalActivityId) };
    } else {
      r.data = data;
      r.applicable = true;
      r.loading = false;
    }
  } catch (error) {
    if (generation !== rosterGeneration || rosterState().activityId !== activityId) return;
    r.loading = false;
    const failure = classifyError(error);
    if (r.applicable !== true && (failure.kind === "not_applicable" || failure.kind === "not_found")) {
      // No roster for this session (or not for this viewer): no tab at all.
      r.applicable = false;
      r.error = null;
      if (state.trainingLoad.calendar.activityDetailTab === "roster") state.trainingLoad.calendar.activityDetailTab = "overview";
    } else {
      r.error = failure;
    }
  }
  onPainted?.();
}

// Test seam: the current generation, so a test can prove a stale answer is
// ignored.
export function activityRosterGenerationForTests() {
  return rosterGeneration;
}

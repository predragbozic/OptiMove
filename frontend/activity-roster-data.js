// Phase 5a3a/5a3b: the team roster of the open session and its decisions.
// GET  /api/training-activity/:activityId/roster (Phase 5a1, PR #122).
// PUT  /api/training-activity/:activityId/roster/:athleteId/decision,
// DELETE the same, POST /api/training-activity/:activityId/roster/decisions
// (Phase 5a2, PR #123).
// Contract: docs/ai/phase5a3-roster-ux-draft.md (sections 1–7, 9).
//
// Not cached across sessions on purpose: the roster changes whenever a
// coach decides or a source imports, and the answer is small. A request
// generation guards against a slower, older answer overwriting a newer one
// (the same pattern as training-load-calendar-data.js).
import { api } from "./api.js";
import { state } from "./state.js";

let rosterGeneration = 0;
// Bumped only when the roster is reset for another (or the same, re-opened)
// session: a write's answer that arrives after that belongs to a view that
// is gone, whatever the activity id says now.
let rosterResetGeneration = 0;

export function currentRosterResetGeneration() {
  return rosterResetGeneration;
}

// A write waits this long for an answer before its outcome counts as not
// confirmed (the server itself bounds a lock wait to 15 s, the COMMIT
// answer to 15 s and the check after an uncertain COMMIT to 5 s).
export const ROSTER_WRITE_TIMEOUT_MS = 45_000;

function rosterState() {
  return state.trainingLoad.calendar.roster;
}

// Starts a fresh roster for another session (never shows the previous
// session's roster while loading). Every write-side state goes with it: a
// selection, an open reason list or a notice belongs to one session only.
export function resetActivityRoster(activityId) {
  const r = rosterState();
  rosterResetGeneration += 1;
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
  r.selected = [];
  r.picker = null;
  r.confirm = null;
  r.changing = null;
  r.busy = {};
  r.unconfirmed = null;
  r.notices = { top: null, rows: {}, selection: [] };
  r.writeLock = null;
  r.refreshFailed = false;
  r.previousStates = {};
  r.changedRows = [];
  r.retryBulk = null;
  r.retry = null;
}

// How the roster answer failed, in terms the view can show. A session
// that is not team-owned (409 roster_not_applicable) and one this viewer
// may not see (the identical 404) both mean "no roster here".
function classifyError(error) {
  if (error?.status === 409 && error?.data?.error === "roster_not_applicable") return { kind: "not_applicable" };
  if (error?.status === 404) return { kind: "not_found" };
  return { kind: "failed" };
}

// What each athlete's row rests on, to tell later whether it changed under
// the coach (section 7: rows are marked only when their state or decision
// differs from the previous successful read on this device).
export function rosterStateSignature(athlete) {
  const decisionIds = athlete.decision
    ? [athlete.decision.id]
    : (athlete.conflictingDecisions ?? []).map((d) => d.id);
  return `${athlete.state}|${(athlete.flags ?? []).includes("decisions_disagree") ? "two" : ""}|${decisionIds.sort().join(",")}`;
}

function signaturesOf(data) {
  const out = {};
  for (const athlete of Array.isArray(data?.athletes) ? data.athletes : []) out[athlete.athleteId] = rosterStateSignature(athlete);
  return out;
}

// Stores a successful read: the roster, and which rows differ from the
// previous successful read (empty on the first one). `exclude` names the
// athletes of the command that just saved: their change is the coach's
// own, not one that happened under the coach.
function acceptRosterData(r, data, { exclude = [] } = {}) {
  const previous = r.previousStates ?? {};
  const next = signaturesOf(data);
  r.changedRows = Object.keys(previous).length
    ? Object.keys(next).filter((id) => Object.hasOwn(previous, id) && previous[id] !== next[id] && !exclude.includes(id))
    : [];
  r.previousStates = next;
  r.data = data;
  r.applicable = true;
  r.loading = false;
  r.error = null;
  r.refreshFailed = false;
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
      acceptRosterData(r, data);
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

// The reread after a write (section 7). A failed reread never replaces
// what is on screen: the roster stays, `refreshFailed` is set and the
// caller keeps its outcome text ("Saved, but the roster could not be
// refreshed"). A 404 and a merged answer are real states and replace it.
// Returns whether the reread succeeded.
export async function refreshActivityRoster(activityId, onPainted, { exclude = [] } = {}) {
  const r = rosterState();
  if (r.activityId !== activityId) return false;
  const generation = ++rosterGeneration;
  r.loading = true;
  onPainted?.();
  try {
    const data = await api(`/api/training-activity/${encodeURIComponent(activityId)}/roster`);
    if (generation !== rosterGeneration || rosterState().activityId !== activityId) return false;
    if (String(data?.activity?.id || "") !== String(activityId)) {
      r.loading = false;
      r.refreshFailed = true;
      return false;
    }
    if (data.canonicalActivityId && String(data.canonicalActivityId) !== String(activityId)) {
      r.data = null;
      r.loading = false;
      r.error = { kind: "superseded", canonicalActivityId: String(data.canonicalActivityId) };
      return true;
    }
    acceptRosterData(r, data, { exclude });
    return true;
  } catch (error) {
    if (generation !== rosterGeneration || rosterState().activityId !== activityId) return false;
    r.loading = false;
    const failure = classifyError(error);
    if (failure.kind === "not_found" || failure.kind === "not_applicable") {
      r.data = null;
      r.error = { kind: "not_found" };
      return true;
    }
    r.refreshFailed = true;
    return false;
  } finally {
    onPainted?.();
  }
}

// Section 7, "Outcome of every write": exactly one of saved / refused /
// unconfirmed. A refusal is a coded answer the server itself gave before
// anything was written: a coded 4xx, 500 internal_error (a certain
// rollback) or 503 roster_busy (a lock wait, nothing written). Everything
// else — 503 outcome_unknown, a 5xx without a code, no answer, a transport
// failure, the timeout — is not confirmed and is never shown as a failure.
export function classifyWriteError(error) {
  const code = typeof error?.data?.error === "string" ? error.data.error : null;
  const status = Number(error?.status) || 0;
  if (code && status >= 400 && status < 500) return { outcome: "refused", status, code, data: error.data };
  if (code === "internal_error" && status === 500) return { outcome: "refused", status, code, data: error.data };
  if (code === "roster_busy" && status === 503) return { outcome: "refused", status, code, data: error.data };
  return { outcome: "unconfirmed", status, code, data: error?.data ?? null, message: error?.message ?? "" };
}

// A UUID for a command's requestKey: minted once per command and kept for
// Check result, so a replay can never write twice.
export function newRosterRequestKey() {
  return globalThis.crypto.randomUUID();
}

// Sends one roster command. `command` = { method, path, body }; the body
// already carries its requestKey. Never throws: the caller gets one of the
// three outcomes.
export async function sendRosterCommand(command) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ROSTER_WRITE_TIMEOUT_MS) : null;
  try {
    const body = await api(command.path, {
      method: command.method,
      body: JSON.stringify(command.body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    return { outcome: "saved", body };
  } catch (error) {
    return classifyWriteError(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The commands of 5a2 as the UI sends them (section 11 of the 5a contract).
export function decideCommand(activityId, athleteId, { kind, reasonKey, note, expectedDecisionId, requestKey }) {
  const body = { kind, expectedDecisionId: expectedDecisionId ?? null, requestKey };
  if (kind === "did_not_participate") body.reasonKey = reasonKey;
  if (note) body.note = note;
  return {
    method: "PUT",
    path: `/api/training-activity/${encodeURIComponent(activityId)}/roster/${encodeURIComponent(athleteId)}/decision`,
    body,
  };
}

export function clearCommand(activityId, athleteId, { expectedDecisionId, requestKey }) {
  return {
    method: "DELETE",
    path: `/api/training-activity/${encodeURIComponent(activityId)}/roster/${encodeURIComponent(athleteId)}/decision`,
    body: { expectedDecisionId, requestKey },
  };
}

export function bulkCommand(activityId, { kind, reasonKey, note, athleteIds, requestKey }) {
  const body = { kind, athletes: athleteIds.map((athleteId) => ({ athleteId, expectedDecisionId: null })), requestKey };
  if (kind === "did_not_participate") body.reasonKey = reasonKey;
  if (note) body.note = note;
  return {
    method: "POST",
    path: `/api/training-activity/${encodeURIComponent(activityId)}/roster/decisions`,
    body,
  };
}

// Test seam: the current generation, so a test can prove a stale answer is
// ignored.
export function activityRosterGenerationForTests() {
  return rosterGeneration;
}

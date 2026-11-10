// Imports: undoing one imported session (J19-U5b, over the U5-1 routes of PR #390).
// Platform admin only: the server answers the identical 404 to everyone else, and the
// button is offered only when the status says the viewer is one. Two steps - a
// read-only scope (GET undo-preview), then the explicit undo with a mandatory reason
// (POST undo-import). Nothing here decides what may be undone; the database function
// does, and the screen only shows its answer.
//
// The outcome of the undo is one of three, like an approval: undone (an answer), not
// undone (a coded refusal - the function rolled back), or not confirmed (no answer,
// a gateway error, 503 outcome_unknown: the COMMIT may or may not have happened). A
// not-confirmed outcome keeps its requestKey, and Check result sends the SAME request
// again, so it can never undo twice; a refused key is never reused.
//
// v60 (O1 of J20): the preview names two kinds of roster work apart - the attendance states the import itself wrote
// (always removed with the import) and LATER changes from the Roster tab. The later ones are removed only when the person
// ticks their own confirmation, which sends the fingerprint of exactly the list shown; if the list changed meanwhile the
// server refuses (roster_work_changed) and the screen shows the new list to confirm again.
import { api } from "./api.js";
import { isImportUndone, isDefiniteRefusal, reloadGpexeCandidates } from "./gpexe-import-data.js";
import { state } from "./state.js";

const BASE = "/api/training-load/gpexe/teams";
// The server's COMMIT wait (15 s) and its statement bounds stay below this: a request still open after it is a lost answer.
export const UNDO_REQUEST_BOUND_MS = 60_000;
export const UNDO_REASON_MAX = 500;

function g() {
  return state.trainingLoad.gpexe;
}

function candidatePath(teamId, candidateId, rest) {
  return `${BASE}/${encodeURIComponent(teamId)}/candidates/${encodeURIComponent(candidateId)}${rest}`;
}

function errorInfo(error) {
  return { status: error?.status ?? 0, code: error?.data?.error || error?.message || "error", message: error?.data?.message || "", data: error?.data || null };
}

function bounded(options) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(UNDO_REQUEST_BOUND_MS) : undefined;
  return { ...options, cache: "no-store", ...(signal ? { signal } : {}) };
}

// Only the platform admin the server recognises may even ask. The server decides again.
export function undoViewer(gx = g()) {
  return gx.status?.viewer?.isPlatformAdmin === true && gx.status?.viewer?.identityAdmin === true;
}

// The review of an imported session that is not undone, for that viewer.
export function undoOffered(c, gx = g()) {
  return Boolean(c) && c.status === "imported" && !isImportUndone(c) && undoViewer(gx);
}

// A write in flight or a result not confirmed: the review cannot be closed over the former, and leaving the page asks over both.
export function undoBusy(gx = g()) {
  const u = gx.undo;
  return Boolean(u && (u.step === "sending" || u.step === "unknown"));
}

export function undoUnloadShouldWarn(gx = g()) {
  return undoBusy(gx);
}

// The review of this candidate, with the undo state only if it belongs to it.
export function undoFor(candidateId, gx = g()) {
  return gx.undo && gx.undo.id === candidateId ? gx.undo : null;
}

// A phone shows a long dialog: bring the part that changed into view (a convenience only).
export function scrollUndoIntoView() {
  try {
    globalThis.document?.querySelector?.(".gpexe-undo")?.scrollIntoView?.({ block: "nearest" });
  } catch {
    // Scrolling is a convenience only.
  }
}

export async function openUndo(candidateId, render) {
  const gx = g();
  if (undoBusy(gx) || !candidateId) return;
  const generation = gx.generation;
  const undo = { id: candidateId, step: "previewing", preview: null, error: null, reason: "", requestKey: null, result: null, checks: 0, laterConfirmed: false, body: null };
  gx.undo = undo;
  render();
  try {
    const { undoPreview } = await api(candidatePath(gx.teamId, candidateId, "/undo-preview"), bounded({}));
    if (generation !== gx.generation || gx.undo !== undo) return;
    undo.preview = undoPreview;
    undo.step = "ready";
  } catch (error) {
    if (generation !== gx.generation || gx.undo !== undo) return;
    undo.error = errorInfo(error);
    undo.step = "refused";
  }
  render();
  scrollUndoIntoView();
}

// Back out of the question or the answer; never while a write is in flight or unconfirmed.
export function cancelUndo() {
  const gx = g();
  if (undoBusy(gx)) return false;
  gx.undo = null;
  return true;
}

// A line break or tab in the reason is a space (a textarea gives a person Enter); every other control character is refused.
export function normalizeUndoReason(reason) {
  return String(reason ?? "").replace(/[\r\n\t]+/g, " ").trim();
}

// What the person types is kept as they type it, so a repaint of the dialog never empties the field.
export function handleUndoReasonInput(target, gx = g()) {
  if (target?.matches?.("[data-gpexe-undo-later-confirm]")) {
    if (gx.undo?.step === "ready") gx.undo.laterConfirmed = target.checked === true;
    return true;
  }
  if (!target?.matches?.("[data-gpexe-undo-reason]")) return false;
  if (gx.undo?.step === "ready") gx.undo.reason = String(target.value ?? "");
  return true;
}

// Later roster changes in the preview: they need their own confirmation.
export function laterRosterWork(undo) {
  const later = undo?.preview?.rosterWork?.laterWork;
  return later && Number(later.total) > 0 ? later : null;
}

// What a person counts as a change: each state set or changed, and each Complete / Reopen (the list names them; the counts
// cover every one even past the list's 60).
export function laterChangeCount(later) {
  if (!later) return 0;
  // The server's own count (every later decision and Complete / Reopen, past the list's 60 too).
  if (Number.isInteger(later.changes) && later.changes >= 0) return later.changes;
  const sessionActs = (Array.isArray(later.list) ? later.list : []).filter((i) => !i?.athleteId).length;
  return (Number(later.decisions) || 0) + sessionActs;
}

// Checked before the question: later changes are never removed without their own tick.
export function undoLaterProblem(undo, confirmed) {
  if (!laterRosterWork(undo)) return "";
  if (confirmed !== true) return "Tick \"Remove these later changes too\" to continue. Nothing was removed.";
  return "";
}

// The reason is the one thing the person types; checked here before anything is asked or sent.
export function undoReasonProblem(reason) {
  const text = normalizeUndoReason(reason);
  if (!text) return "Write why the import is undone.";
  if (text.length > UNDO_REASON_MAX) return `The reason is too long (${text.length} of ${UNDO_REASON_MAX} characters).`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return "The reason cannot contain control characters.";
  return "";
}

async function settle(undo, generation, body, render) {
  const gx = g();
  try {
    const { undo: result } = await api(candidatePath(gx.teamId, undo.id, "/undo-import"), bounded({ method: "POST", body: JSON.stringify(body) }));
    if (generation !== gx.generation || gx.undo !== undo) return;
    undo.result = result;
    undo.error = null;
    undo.step = "done";
  } catch (error) {
    if (generation !== gx.generation || gx.undo !== undo) return;
    const info = errorInfo(error);
    undo.error = info;
    // A resend of an unconfirmed request is answered "busy" or "not found" while the first one may still be running or
    // committing: that says nothing about the first one, so it stays not confirmed (only a saved answer settles it).
    const resend = undo.checks > 0;
    if (resend && isDefiniteRefusal(info) && (info.code === "try_again" || info.status === 404)) {
      undo.step = "unknown";
      undo.stillUnknown = true;
    } else if (isDefiniteRefusal(info) && (info.code === "roster_work_changed" || info.code === "roster_work_needs_confirmation") && info.data?.rosterWork) {
      // Nothing was removed: the attendance changed since the preview. Show the list as it is now and ask again.
      undo.requestKey = null;
      undo.preview = { ...undo.preview, rosterWork: info.data.rosterWork, needsRosterConfirmation: Number(info.data.rosterWork.laterWork?.total) > 0 };
      undo.laterConfirmed = false;
      undo.laterNote = info.code === "roster_work_changed"
        ? "Attendance changed since you opened this. Nothing was removed. The list below now shows the current changes; tick the box again to remove them too."
        : "Nothing was removed. Tick the box to remove the later changes too.";
      undo.refusalNote = Number(info.data.rosterWork.laterWork?.total) > 0 ? "" : (info.message || "The session's attendance changed since you reviewed it. Nothing was removed. Review the undo again.");
      undo.rereadPreview = true;
      undo.step = "ready";
    } else if (isDefiniteRefusal(info) && info.code === "try_again") {
      // Nothing was removed and nothing is lost: back to the question with the reason kept.
      undo.requestKey = null;
      undo.refusalNote = info.message || "Another change was running; nothing was removed. Try again in a moment.";
      undo.step = "ready";
    } else if (isDefiniteRefusal(info) && info.code !== "outcome_unknown") {
      // Settled for certain: nothing was removed (or, for these two, it had been already). A new attempt gets a new key.
      undo.requestKey = null;
      undo.step = info.code === "already_undone" || info.code === "candidate_not_imported" ? "settled" : "refused";
    } else {
      // No answer, a gateway error, 503: the COMMIT may or may not have happened. Never "nothing was removed".
      undo.step = "unknown";
    }
  }
  if (generation === gx.generation) {
    render();
    scrollUndoIntoView();
    if (undo.rereadPreview) {
      // The attendance changed under the question: read the whole scope again (the totals moved with it).
      undo.rereadPreview = false;
      await rereadPreview(undo, generation);
      render();
    }
    // The session moved on either way: read the list again, and the open review when it is settled.
    if (undo.step === "done" || undo.step === "settled") {
      await refreshReviewedCandidate(undo, generation);
      render();
      void reloadGpexeCandidates(render);
    }
  }
}

async function rereadPreview(undo, generation) {
  const gx = g();
  try {
    const { undoPreview } = await api(candidatePath(gx.teamId, undo.id, "/undo-preview"), bounded({}));
    if (generation === gx.generation && gx.undo === undo && undo.step === "ready" && undoPreview) {
      const before = undo.preview?.rosterWork?.laterWork?.fingerprint ?? null;
      undo.preview = undoPreview;
      // A list that moved again is a new list: the tick never carries over.
      if ((undoPreview.rosterWork?.laterWork?.fingerprint ?? null) !== before) undo.laterConfirmed = false;
    }
  } catch {
    // The refusal's own scope stays shown; the server compares the list again on the next attempt.
  }
}

async function refreshReviewedCandidate(undo, generation) {
  const gx = g();
  const detail = gx.detail;
  if (!detail || detail.id !== undo.id) return;
  try {
    const { candidate } = await api(candidatePath(gx.teamId, undo.id, ""), bounded({}));
    if (generation === gx.generation && gx.detail === detail) detail.candidate = candidate;
  } catch {
    // The result stands on its own; the review shows the undo state it holds.
  }
}

// The explicit undo. The key is chosen once for this attempt and reused by Check result.
export async function sendUndo(reason, render, { laterConfirmed = undefined } = {}) {
  const gx = g();
  const undo = gx.undo;
  if (!undo || undo.step !== "ready" || !undo.preview?.eventId) return false;
  if (laterConfirmed !== undefined) undo.laterConfirmed = laterConfirmed === true;
  const reasonProblem = undoReasonProblem(reason);
  const laterProblem = undoLaterProblem(undo, undo.laterConfirmed);
  const problem = reasonProblem || laterProblem;
  if (problem) {
    // Each problem in its own place: the reason's under the field, the tick's under the checkbox.
    undo.reasonProblem = reasonProblem;
    undo.laterProblem = reasonProblem ? "" : laterProblem;
    render();
    return false;
  }
  undo.reasonProblem = "";
  undo.laterProblem = "";
  undo.refusalNote = "";
  undo.laterNote = "";
  undo.reason = normalizeUndoReason(reason);
  undo.requestKey = undo.requestKey || globalThis.crypto.randomUUID();
  undo.step = "sending";
  undo.error = null;
  const later = laterRosterWork(undo);
  // The body is kept as sent: Check result repeats exactly this request.
  undo.body = {
    requestKey: undo.requestKey, reason: undo.reason, expected: { eventId: undo.preview.eventId },
    // Sending the fingerprint is the confirmation of exactly the listed later changes.
    ...(later ? { laterRosterFingerprint: later.fingerprint } : {}),
  };
  render();
  await settle(undo, gx.generation, undo.body, render);
  return true;
}

// Check result: the same request, the same key; the server answers with what it saved.
export async function checkUndo(render) {
  const gx = g();
  const undo = gx.undo;
  if (!undo || undo.step !== "unknown" || !undo.requestKey) return false;
  undo.checks += 1;
  undo.stillUnknown = false;
  undo.step = "sending";
  render();
  await settle(undo, gx.generation, undo.body || { requestKey: undo.requestKey, reason: undo.reason, expected: { eventId: undo.preview.eventId } }, render);
  return true;
}

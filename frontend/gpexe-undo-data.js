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
  const undo = { id: candidateId, step: "previewing", preview: null, error: null, reason: "", requestKey: null, result: null, checks: 0 };
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
  if (target?.matches?.("[data-gpexe-undo-confirm-later]")) {
    if (gx.undo?.step === "ready") gx.undo.confirmLater = Boolean(target.checked);
    return true;
  }
  if (!target?.matches?.("[data-gpexe-undo-reason]")) return false;
  if (gx.undo?.step === "ready") gx.undo.reason = String(target.value ?? "");
  return true;
}

// v60 (O1): the coach's later roster work the preview found. Nonzero => the undo needs the explicit confirmation of the list.
export function laterRosterCount(preview) {
  const l = preview?.rosterWork?.later;
  if (!l || typeof l !== "object") return 0;
  return ["decisions", "requests", "completions", "completionLog"].reduce((n, k) => n + (Number.isInteger(l[k]) ? l[k] : 0), 0);
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
    // The session moved on either way: read the list again, and the open review when it is settled.
    if (undo.step === "done" || undo.step === "settled") {
      await refreshReviewedCandidate(undo, generation);
      render();
      void reloadGpexeCandidates(render);
    }
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
export async function sendUndo(reason, render) {
  const gx = g();
  const undo = gx.undo;
  if (!undo || undo.step !== "ready" || !undo.preview?.eventId) return false;
  const problem = undoReasonProblem(reason);
  if (problem) {
    undo.reasonProblem = problem;
    render();
    return false;
  }
  undo.reasonProblem = "";
  undo.refusalNote = "";
  undo.reason = normalizeUndoReason(reason);
  // The later work needs the confirmation of exactly the list the preview showed (its fingerprint); the server compares it again.
  const needsConfirm = laterRosterCount(undo.preview) > 0;
  if (needsConfirm && !undo.confirmLater) {
    undo.reasonProblem = "Tick the box to confirm that the coach's later work is removed too.";
    render();
    return false;
  }
  undo.requestKey = undo.requestKey || globalThis.crypto.randomUUID();
  undo.step = "sending";
  undo.error = null;
  render();
  const body = { requestKey: undo.requestKey, reason: undo.reason, expected: { eventId: undo.preview.eventId } };
  if (needsConfirm) body.confirmRosterFingerprint = undo.preview.rosterWork.fingerprint;
  undo.sentBody = body;
  await settle(undo, gx.generation, body, render);
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
  await settle(undo, gx.generation, undo.sentBody || { requestKey: undo.requestKey, reason: undo.reason, expected: { eventId: undo.preview.eventId } }, render);
  return true;
}

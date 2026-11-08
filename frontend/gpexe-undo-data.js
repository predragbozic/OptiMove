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
}

// Back out of the question or the answer; never while a write is in flight or unconfirmed.
export function cancelUndo() {
  const gx = g();
  if (undoBusy(gx)) return false;
  gx.undo = null;
  return true;
}

// The reason is the one thing the person types; checked here before anything is sent.
export function undoReasonProblem(reason) {
  const text = String(reason ?? "").trim();
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
    if (isDefiniteRefusal(info) && info.code !== "outcome_unknown") {
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
  undo.reason = String(reason).trim();
  undo.requestKey = undo.requestKey || globalThis.crypto.randomUUID();
  undo.step = "sending";
  undo.error = null;
  render();
  await settle(undo, gx.generation, { requestKey: undo.requestKey, reason: undo.reason, expected: { eventId: undo.preview.eventId } }, render);
  return true;
}

// Check result: the same request, the same key; the server answers with what it saved.
export async function checkUndo(render) {
  const gx = g();
  const undo = gx.undo;
  if (!undo || undo.step !== "unknown" || !undo.requestKey) return false;
  undo.checks += 1;
  undo.step = "sending";
  render();
  await settle(undo, gx.generation, { requestKey: undo.requestKey, reason: undo.reason, expected: { eventId: undo.preview.eventId } }, render);
  return true;
}

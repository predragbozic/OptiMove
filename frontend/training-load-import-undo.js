// Training Load > Activities: "Delete imported data" on an imported session (v76; the owner, 2026-11-17: "delete an
// imported session easily, with a click on the session; whoever imports may delete it; re-import needs no special
// button"). Over the routes of PR #591:
//   GET  /api/training-load/gpexe/teams/:teamId/status                                  -> viewer.undoImport (only when true)
//   GET  /api/training-load/gpexe/teams/:teamId/activities/:activityId/import-undo      -> { importUndo: { candidateId } } or 404
// then the same undo-preview / undo-import as the Imports review (gpexe-undo-data.js), opened with the session's own team.
// The session's team comes from its roster read (activity.ownerTeamId). Nothing is offered unless the server says so; a
// 404 or any failure of these reads simply offers nothing (never an error on the session).
import { api } from "./api.js";
import { openUndo, undoBusy } from "./gpexe-undo-data.js";
import { UNDO_OFFER_SENTENCE, renderUndoBodyHtml, undoBusyNote } from "./gpexe-undo-view.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";

const BASE = "/api/training-load/gpexe/teams";
const NOT_IMPORTED = new Set(["planned_session", "external_assignment", "manual"]);

const cal = () => state.trainingLoad.calendar;
const gx = () => state.trainingLoad.gpexe;

function entry() {
  const c = cal();
  if (!c.importUndo) c.importUndo = { activityId: null, teamId: null, step: "idle", candidateId: null, admin: false, label: "" };
  return c.importUndo;
}

// The offer of the open session, or null.
export function sessionImportUndo(activityId = cal().selectedActivityId) {
  const e = entry();
  return e.activityId && e.activityId === activityId ? e : null;
}

// The delete opened from this session (its own state, wherever the Imports screen is).
function openFor(activityId) {
  const u = gx()?.undo;
  return u && u.origin === "session" && u.activityId === activityId ? u : null;
}

// After the roster of the open session is read: is it an import this viewer may delete? Two reads, both helpers.
export async function lookUpSessionImportUndo(activityId, render, { teamId, origin = null, label = "", day = "" } = {}) {
  if (!activityId || !teamId || (origin && NOT_IMPORTED.has(origin))) return;
  const e = entry();
  // A delete of this very session that is open stays as it is.
  if (openFor(activityId)) return;
  Object.assign(e, { activityId, teamId, step: "checking", candidateId: null, admin: false, label, day });
  try {
    const status = await api(`${BASE}/${encodeURIComponent(teamId)}/status`);
    if (entry() !== e || e.activityId !== activityId) return;
    if (status?.viewer?.undoImport !== true) {
      e.step = "none";
      return;
    }
    e.admin = status.viewer.isPlatformAdmin === true;
    const { importUndo } = await api(`${BASE}/${encodeURIComponent(teamId)}/activities/${encodeURIComponent(activityId)}/import-undo`, { cache: "no-store" });
    if (entry() !== e || e.activityId !== activityId) return;
    e.candidateId = importUndo?.candidateId || null;
    e.step = e.candidateId ? "offer" : "none";
  } catch {
    // Not imported, no right, another team's, or the read failed: nothing is offered.
    if (entry() === e && e.activityId === activityId) e.step = "none";
  }
  render();
}

export async function openSessionImportUndo(render, { afterDeleted } = {}) {
  const c = cal();
  const e = sessionImportUndo(c.selectedActivityId);
  if (!e || e.step !== "offer" || undoBusy(gx())) return;
  const activityId = e.activityId;
  await openUndo(e.candidateId, render, {
    teamId: e.teamId, origin: "session", admin: e.admin, activityId, label: e.label, day: e.day,
    afterSettled: async () => {
      // The offer is shared by whichever session is open: only this session's is closed (code review).
      if (e.activityId === activityId) e.step = "deleted";
      render();
      await afterDeleted?.();
      render();
    },
  });
}

// The section at the end of an imported session's detail.
export function renderSessionImportUndoHtml(activityId) {
  const open = openFor(activityId);
  if (open) {
    // After the delete, and after a 404 (nothing to delete any more), the next step is the day itself.
    const back = open.step === "done" || open.step === "settled" || (open.step === "refused" && open.error?.status === 404);
    return `<div class="tl-import-undo">${renderUndoBodyHtml(open)}${back ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-calendar-clear-activity">Back to the day</button>` : ""}</div>`;
  }
  const e = sessionImportUndo(activityId);
  if (!e || e.step !== "offer") return "";
  const busy = undoBusy(gx());
  return `
    <div class="tl-import-undo"><section class="gpexe-undo" aria-label="Delete imported data">
      <h4>Delete imported data</h4>
      <p class="muted">${escapeHtml(UNDO_OFFER_SENTENCE)}</p>
      ${busy ? `<p class="muted">${escapeHtml(undoBusyNote(gx()))}</p>` : `<button type="button" class="plain-button gpexe-button" data-action="training-load-session-undo-open">Delete imported data...</button>`}
    </section></div>`;
}

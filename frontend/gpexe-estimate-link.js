// 6b-C2 (the Rukovodilac's decision (A), 2026-11-15): an imported session's review links each athlete whose attendance is
// *Participated · no device data* to the activity's Roster tab, where the estimate panel of 6b-C1 opens for them. There is
// one write path (the Roster tab's), so the review never saves an estimate itself and keeps no second roster state.
//
// Who is listed comes from the activity's roster read (GET /api/training-activity/:id/roster), the same read the Roster tab
// makes: an athlete in state participated_no_values, offered only while the server says estimates are on
// (viewer.estimates). The read is GET only; a failure shows no link (the Roster tab stays reachable from Activities).
import { api } from "./api.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";
import { isEstimateValue } from "./activity-estimate.js";

const g = () => state.trainingLoad.gpexe;

// The confirmed import of a review: its activity id, or null (a session not imported, or whose import was undone - also by
// an undo made in this same review).
export function importedActivityOf(detail) {
  if (detail?.candidate?.importUndoneAt) return null;
  const undo = g().undo;
  // An undo of this session that is in flight, done, or whose result is not confirmed: no estimate is offered.
  if (undo && String(undo.id) === String(detail?.id) && ["sending", "done", "unknown"].includes(undo.step)) return null;
  const o = detail?.outcome;
  if (o?.kind === "imported" && o.result?.import?.activityId) return String(o.result.import.activityId);
  const a = o?.verified === "imported" ? o.approval : null;
  if (a?.import?.activityId) return String(a.import.activityId);
  const c = detail?.candidate;
  if (c?.status === "imported" && !c.importUndoneAt && c.approval?.import?.activityId) return String(c.approval.import.activityId);
  return null;
}

// Reads who may get an estimate after the import. Called when the review of an imported session opens and after the
// import's attendance states were saved (they make athletes participated_no_values).
export async function loadEstimateTargets(detail, render) {
  const activityId = importedActivityOf(detail);
  if (!activityId) return;
  const gx = g();
  const generation = gx.generation;
  // Only the newest read counts: a slower, older answer never replaces a newer one.
  const seq = (detail.estimateReadSeq = (detail.estimateReadSeq || 0) + 1);
  const current = () => generation === gx.generation && gx.detail === detail && detail.estimateReadSeq === seq;
  try {
    const data = await api(`/api/training-activity/${encodeURIComponent(activityId)}/roster`);
    if (!current()) return;
    const athletes = data?.viewer?.estimates === true
      ? (data.athletes || []).filter((a) => a.state === "participated_no_values").map((a) => ({
        athleteId: String(a.athleteId), name: a.name || "Athlete", estimated: (a.values || []).some(isEstimateValue),
      }))
      : [];
    detail.estimateTargets = { activityId, date: data?.activity?.occurredLocalDate ?? null, athletes };
  } catch {
    if (!current()) return;
    detail.estimateTargets = null;
  }
  render?.();
}

// Something of the review that must not be left without asking: the attendance states still being saved, or a group
// whose result is not confirmed yet.
export function reviewHasWorkInFlight(detail) {
  const s = detail?.states;
  if (s?.saving) return true;
  return Object.values(s?.groups || {}).some((v) => v?.status === "sent" || v?.status === "unknown");
}

// The targets still apply: read for the import this review shows now (not undone since).
export function estimateTargetsOf(detail) {
  const t = detail?.estimateTargets;
  return t?.athletes?.length && t.date && importedActivityOf(detail) === t.activityId ? t : null;
}

export function renderEstimateTargetsHtml(detail) {
  const t = estimateTargetsOf(detail);
  if (!t) return "";
  const busy = detail.approving || detail.verifying;
  return `
    <section class="gpexe-estimate-targets" aria-labelledby="gpexe-estimate-targets-h">
      <h4 id="gpexe-estimate-targets-h">Took part without device data</h4>
      <p class="muted">${t.athletes.length === 1 ? "This athlete is" : "These athletes are"} marked "Participated · no device data". You can estimate their values in the session's Roster tab in Activities; an estimate is always labelled and never counted as measured.</p>
      ${busy ? `<p class="muted">Available when the import's answer arrives.</p>` : ""}
      <ul>
        ${t.athletes.map((a) => {
    const label = a.estimated ? "Change the estimate in Activities" : "Estimate values in Activities";
    // The visible text stays whole at the start of the name (WCAG 2.5.3, label in name), then the athlete.
    const aria = `${label}, ${a.name}`;
    return `<li><span>${escapeHtml(a.name)}${a.estimated ? ` <small class="muted">· Estimated</small>` : ""}</span> <button type="button" class="plain-button gpexe-button" data-action="training-load-estimate-in-activities" data-athlete-id="${escapeAttr(a.athleteId)}" aria-label="${escapeAttr(aria)}" ${busy ? "disabled" : ""}>${label}</button></li>`;
  }).join("")}
      </ul>
    </section>
  `;
}

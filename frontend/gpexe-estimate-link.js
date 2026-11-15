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

const g = () => state.trainingLoad.gpexe;

// The confirmed import of a review: { activityId } or null (a session not imported, or whose import was undone).
export function importedActivityOf(detail) {
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
  try {
    const data = await api(`/api/training-activity/${encodeURIComponent(activityId)}/roster`);
    if (generation !== gx.generation || gx.detail !== detail) return;
    const athletes = data?.viewer?.estimates === true
      ? (data.athletes || []).filter((a) => a.state === "participated_no_values").map((a) => ({ athleteId: String(a.athleteId), name: a.name || "Athlete" }))
      : [];
    detail.estimateTargets = { activityId, date: data?.activity?.occurredLocalDate ?? null, athletes };
  } catch {
    if (generation !== gx.generation || gx.detail !== detail) return;
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

export function renderEstimateTargetsHtml(detail) {
  const t = detail?.estimateTargets;
  if (!t?.athletes?.length || !t.date) return "";
  const busy = detail.approving || detail.verifying;
  return `
    <section class="gpexe-estimate-targets" aria-label="Estimate values">
      <h4>Took part without device data</h4>
      <p class="muted">${t.athletes.length === 1 ? "This athlete is" : "These athletes are"} marked "Participated · no device data". You can estimate their values in the session's Roster tab in Activities; an estimate is always labelled and never counted as measured.</p>
      <ul>
        ${t.athletes.map((a) => `<li><span>${escapeHtml(a.name)}</span> <button type="button" class="plain-button gpexe-button" data-action="training-load-estimate-in-activities" data-athlete-id="${escapeAttr(a.athleteId)}" ${busy ? "disabled" : ""}>Estimate values in Activities</button></li>`).join("")}
      </ul>
    </section>
  `;
}

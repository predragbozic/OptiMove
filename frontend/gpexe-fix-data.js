// Imports "Fix" flow, slice 1 (manager's GO, 2026-11-16): a session that needs a person is fixed one problem per screen
// instead of in the full review. The steps run in a fixed order - a) a result not confirmed, b) athletes not linked (one
// GPEXE athlete per step), c) a review out of date, d) a new search - and end on "This session is ready". Every step is
// one of the review's own actions (verify, link + the J20-A1 recompute, the recompute, a check with the session's day);
// nothing here sends a request of its own. Kinds outside the slice keep "See why" -> the full review.
// Pure rules over `gx.detail` (the open review) and `gx`; the review's own state is the truth, so a step is never stored.
// Slice 2 (manager's GO, 2026-11-16): an athlete GPEXE recorded on more than one track (one athlete per step, for whoever may
// import; MT-A's routes), and changes to results already imported (accepted in one step, sent with the approval's own
// acceptChanges). "Needs a look" opens Fix too; what the sheet can't fix there still ends on "See why".
import { isUncertain, notConfirmedForImport, reviewMadeBeforeLinkChange } from "./gpexe-import-data.js";
import { multiTrackIds, trackStepIds } from "./gpexe-fix-tracks-data.js";

// The attention groups the Fix flow covers (gpexe-attention-groups.js keys): slice 1, and "Needs a look" from slice 2.
export const FIX_GROUPS = new Set(["unknown", "unlinked", "stale", "fresh", "review"]);

// A new Fix state for a review opened from a group or one of its rows. `opener` is what the focus goes back to.
export function newFix(opener = {}) {
  return { skipped: [], seen: [], searching: false, searchError: null, tracks: null, trackPick: null, trackWrite: null, trackError: null, opener: { ...opener } };
}

// The GPEXE athletes of the review that still need a link: listed as "not linked" by the preview, and not linked since
// (a link whose recompute failed leaves the preview as it was - the review is then out of date, step c).
export function unlinkedForFix(detail, gx) {
  const linked = new Set((gx?.links || []).map((l) => String(l.gpexeAthleteId)));
  const skipped = new Set((detail?.fix?.skipped || []).map(String));
  const ids = [];
  for (const a of detail?.candidate?.preview?.athletes || []) {
    const id = String(a?.gpexeAthleteId ?? "");
    if (!id || a?.notImported?.code !== "athlete_not_linked" || linked.has(id) || skipped.has(id) || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

function isImported(detail) {
  const o = detail?.outcome;
  return o?.kind === "imported" || o?.verified === "imported" || o?.error?.code === "already_imported" || detail?.candidate?.status === "imported";
}

function resultNotConfirmed(detail, gx) {
  const o = detail?.outcome;
  if (o?.kind === "unknown" && o.verified !== "imported") return true;
  return Boolean(detail?.candidate && !o && isUncertain(detail.candidate, gx));
}

function needsSearch(c) {
  return !c?.snapshot?.available || notConfirmedForImport(c);
}

const canImport = (gx) => gx?.status?.viewer?.canApprove === true;

// The steps still to do, in order: unknown, link (per athlete), track (per athlete), stale, fresh, changes.
export function fixSteps(detail, gx) {
  const c = detail?.candidate;
  if (!c || isImported(detail)) return [];
  const steps = [];
  if (resultNotConfirmed(detail, gx)) steps.push({ kind: "unknown" });
  // While a result is not confirmed nothing else is offered: "check before doing anything else".
  if (steps.length) return steps;
  for (const id of unlinkedForFix(detail, gx)) steps.push({ kind: "link", id });
  // Slice 2: the recordings are read first (only an approver may); a read that failed is a step of its own (Try again).
  const t = detail.fix?.tracks;
  if (t?.status === "error" && multiTrackIds(c).length) steps.push({ kind: "tracksError" });
  for (const id of trackStepIds(detail)) steps.push({ kind: "track", id });
  // c) never a step to press when the recompute after the last link already refreshed the review (it then is current).
  // A session that needs a search can't be recomputed (the server refuses it until the search); the search makes its
  // review current, so it is the step (code review, HIGH).
  if (reviewMadeBeforeLinkChange(c, gx) && !needsSearch(c)) steps.push({ kind: "stale" });
  if (needsSearch(c)) steps.push({ kind: "fresh" });
  // Slice 2: changes to imported results are accepted by whoever imports, in a step of their own, before the import.
  if (c.changesToImported && canImport(gx) && !detail.acceptChanges && c.status === "pending") steps.push({ kind: "changes" });
  return steps;
}

// What the sheet shows now: a step, a moment of waiting, or the end.
// { screen: "loading" | "error" | "step" | "updating" | "searching" | "imported" | "ready" | "other", step?, index?, total? }
export function fixScreen(detail, gx) {
  if (!detail?.fix) return null;
  if (detail.loading) return { screen: "loading" };
  if (!detail.candidate) return { screen: "error" };
  if (isImported(detail)) return { screen: "imported" };
  if (detail.fix.searching) return { screen: "searching" };
  // The recompute after a link, or the step c's own: its answer comes before the next step.
  if (detail.updating) return { screen: "updating" };
  if (detail.fix.tracks?.status === "loading") return { screen: "loading" };
  const steps = fixSteps(detail, gx);
  if (steps.length) {
    // "Step x of y": the steps already seen and gone (done or skipped) come before; one that appears later (a recompute
    // that failed) only adds to y.
    const now = new Set(steps.map(stepKey));
    const done = (detail.fix.seen || []).filter((k) => !now.has(k)).length;
    return { screen: "step", step: steps[0], index: done + 1, total: done + steps.length };
  }
  return { screen: endReady(detail, gx) ? "ready" : "other" };
}

// What the sheet itself handles: a missing link, more than one track (chosen, skipped, or left to whoever imports) and a
// track left out by choice.
const HANDLED_CODES = new Set(["athlete_not_linked", "multiple_tracks", "no_track_by_choice"]);

// The end: the review would offer an import of the whole session as it is now (or for the athletes linked, when some
// were skipped). Anything else - a blocked or withdrawn session, changes not accepted, an athlete left out for a reason the
// sheet does not handle - is not decided here: "See why" opens the full review.
function endReady(detail, gx) {
  const c = detail.candidate;
  if (c.status !== "pending" || c.previewStatus === "blocked") return false;
  if ((c.approvalBlockers || []).some((b) => b !== "blocked" && b !== "team_import_switch_off" && b !== "import_switch_off")) return false;
  // Changes are accepted by whoever imports (the step above, always before the end); anyone else is told who imports. Kept
  // as a guard should the step order change.
  if (c.changesToImported && canImport(gx) && !detail.acceptChanges) return false;
  // Athletes left out for another reason than one the sheet handles (manual review of another kind, not in the team,
  // invalid in GPEXE, a blocking row): the full review names them, so the sheet does not say "ready" (code review, MEDIUM).
  const athletes = c.preview?.athletes || [];
  if (athletes.some((a) => a?.blocksSession || (a?.notImported && !HANDLED_CODES.has(a.notImported.code)))) return false;
  // "Needs manual review" is also the session reason for more than one track: the athlete check above already refuses every
  // other kind of review (each carries its own notImported code), so the reason is allowed here.
  if ((c.reasons || []).some((r) => !["athletes_not_linked", "no_linked_athlete", "athletes_need_manual_review"].includes(r?.code))) return false;
  if (detail.outcome?.kind === "refused") return false;
  return true;
}

function stepKey(step) {
  return step.kind === "link" || step.kind === "track" ? `${step.kind}:${step.id}` : step.kind;
}

// The steps this sheet has shown for the session, kept after each of its actions so a step that is done counts as done.
export function noteFixSteps(detail, gx) {
  if (!detail?.fix || !detail.candidate) return;
  for (const key of fixSteps(detail, gx).map(stepKey)) if (!detail.fix.seen.includes(key)) detail.fix.seen.push(key);
}

// Something the sheet started is still on its way. An approval or its check must be seen: the sheet does not close.
// A link, a recompute or a search may finish while the sheet is closed (their result shows in the list), so leaving
// asks first.
export function fixMustStay(gx, detail = gx?.detail) {
  return Boolean(detail?.approving || detail?.verifying);
}
export function fixWriteInFlight(gx, detail = gx?.detail) {
  return Boolean(gx?.linkBusy || detail?.updating || gx?.checkStarting || detail?.fix?.searching || detail?.fix?.trackWrite?.sending || detail?.fix?.trackWrite?.unknown);
}

// The athletes still left with more than one track (skipped, or for someone who may not choose): the end says so.
export function openMultiTrackIds(detail) {
  return multiTrackIds(detail?.candidate);
}

// "Skip for now" on a link or track step: that GPEXE athlete only, never the session.
export function skipFixAthlete(detail, id) {
  if (!detail?.fix || !id) return false;
  if (detail.fix.skipped.includes(String(id))) return false;
  detail.fix.skipped.push(String(id));
  return true;
}

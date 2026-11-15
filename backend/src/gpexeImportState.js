// The Imports state of one candidate, from the facts its list summary carries: the one rule the candidate list and the
// Imports calendar share. It is the server's half of the frontend's inboxBucket (frontend/gpexe-import-data.js):
//   hidden   - a replaced or withdrawn version, or an import that was undone (never shown, never counted);
//   imported - imported, or "nothing new" for a session in which somebody was imported;
//   out      - stays out of OptiMove for good (a session type that is not imported);
//   needs    - the coach has a step to take (no snapshot, blocked, not confirmed by a successful search, any reason);
//   ready    - nothing to decide.
// The frontend adds two facts only the browser has (an approval whose answer was lost in this tab, a link made after the
// last search) and may move a "ready" row to its attention group; the server cannot know them. A parity test runs this
// rule against the frontend's over the same summaries. Pure: no import, no database, no audience (it reads no code a
// projection changes).

export const CANDIDATE_STATES = Object.freeze(["needs", "ready", "imported", "out"]);

export function candidateState(c) {
  if (!c || typeof c !== "object") return "needs";
  if (c.status === "imported") return c.importUndoneAt ? "hidden" : "imported";
  if (c.status === "superseded") return "hidden";
  if (!c.snapshot?.available) return "needs";
  if (c.status === "blocked") return c.blockedCode === "unsupported_session_type" ? "out" : "needs";
  // v33: a summary without the server's blockers is never "confirmed" (fail-closed, as the frontend).
  if (!Array.isArray(c.approvalBlockers) || c.approvalBlockers.includes("not_confirmed_for_import")) return "needs";
  const reasons = Array.isArray(c.reasons) ? c.reasons : [];
  if (c.previewStatus === "no_changes") return reasons.length ? "needs" : "imported";
  return reasons.length ? "needs" : "ready";
}

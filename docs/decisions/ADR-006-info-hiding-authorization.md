# ADR-006: Info-hiding authorization (missing vs. unauthorized look identical)

**Status:** Active

## Context

If "this resource doesn't exist" and "this resource exists but you can't see it" return
different responses, an attacker (or a curious user) can enumerate real resource ids
belonging to other workspaces/users just by probing — even without ever getting the
resource's actual content.

## Decision

A request for a resource that either doesn't exist, or exists but the caller isn't
authorized to see/manage, returns the same HTTP status and the same `error` field — the
caller can never distinguish "doesn't exist" from "not yours" by status/error code. For
the Training Load dashboard, that's `404 {error: "notFound"}` in both cases.

## Exact contracts

- `requireManageableDashboard` — `backend/src/routes/trainingLoadDashboard.js:214-218`.
  Row missing → `404 {error:"notFound", message:"Dashboard not found."}` (line 217). Row
  exists but `!canManageDashboardRow` → the identical `404 {error:"notFound",
  message:"Dashboard not found."}` (line 218). These two are byte-identical.
- The data-workspace mismatch case (a dashboard the caller can *manage* but whose data
  workspace doesn't match the currently active one — see ADR-002):
  `routes/trainingLoadDashboard.js:763-765` → `404 {error:"notFound"}`, **no `message`
  field**. Same status and `error` value as the two cases above, but not byte-identical
  to them — a caller who can already manage/view the dashboard (just from the wrong
  active workspace) gets a narrower signal (no `message`) than a caller with no
  relationship to it at all. This is a known, minor discrepancy in the current code, not
  something this ADR should claim is fully closed — treat "info-hiding 404" as "same
  status/error code," not "byte-identical body," until/unless the `message` field is
  aligned across all three paths.
- Confirmed as a deliberate, app-wide convention (not just this one router) in
  `backend/src/trainingActivityMaterialize.js:706-707`: "a 404 here — never a 403 leaking
  that a participant id exists — matches this app's existing not-yours-vs-missing
  convention."

## Consequences

- A new route touching a resource with an owner/workspace boundary must return the same
  status/`error` for "doesn't exist" and "exists, not yours" — a route that returns 403
  for the latter is a real information leak, not a cosmetic inconsistency.
- Known residual gap (see the data-workspace-mismatch bullet above): the `message` field
  isn't yet aligned across all three 404 paths on the dashboard query route. Low severity
  in practice (the distinguishing case requires already having manage/view rights on the
  row), but a real, undocumented-until-now narrowing of info-hiding — worth a deliberate
  fix decision, not silent acceptance.
- This is independent of, and doesn't replace, the two-part check in ADR-002 — the
  info-hiding response is what gets returned once either the manage check or the
  data-workspace check fails; which one failed is never distinguishable from the
  response.

## Evidence

Verified against `routes/trainingLoadDashboard.js` and
`trainingActivityMaterialize.js`, in a research pass on 2026-09-14.

## Supersedes / Superseded by

—

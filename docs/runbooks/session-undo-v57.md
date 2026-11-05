# Session undo (migration v57, U5)

The in-app undo of one imported GPEXE session (J19-U5, `docs/ai/j19-u5-undo-contract.md` section 9, plan `docs/ai/u5-undo-plan.md`).
Migration: `migrations_v2/202611051000_training_load_v57_session_undo.sql`. Files beside this runbook:
`session-undo-v57-preflight.sql`, `session-undo-v57-postcheck.sql`, `session-undo-v57-rollback.sql`.

## What it is

* `training_load.undo_imported_session(actor, team, candidate, requestKey, reason, expectedEvent)` removes exactly what
  `backend/scripts/gpexe-undo-imported-session.mjs` removes, in the same order, **without disabling any trigger**; writes one
  `import_deletion_log` row and one `gpexe_session_undo_requests` row; marks the imported candidate undone
  (`import_undone_at`, `import_undone_request_id`; it stays `imported`, history); and, when the candidate's snapshot is still
  available and the check that last saw it succeeded, writes a fresh **pending** candidate of the same content in the same
  transaction. The service then recomputes that candidate's preview after the COMMIT (best effort: without a preview the
  candidate cannot be approved, and the next search recomputes it).
* Four protections get one exception each, true only for a DELETE inside the function's own transaction (the marker
  `optimove.session_undo_tx = txid_current()`, set by the function, off again when it returns): `metric_values_immutable` (v13),
  `metric_event_source_bindings_no_delete` (v20), `activity_source_observations_append_only` (v25),
  `metric_value_source_provenance_append_only` (v34). The candidate guard (v23) gains the rule for the two undone columns.
* The first version is for an **active platform admin** only (owner, 2026-11-05); the routes answer everyone else the identical 404.
  `GET .../candidates/:candidateId/undo-preview` (the same function, always rolled back) and
  `POST .../candidates/:candidateId/undo-import` `{ requestKey, reason, expected: { eventId } }`.

## Lock order

acting user row (`FOR SHARE`) -> platform-admin role row (`FOR SHARE`) -> the team's import lock (the importer's advisory key) ->
the request record (a replay answers here) -> the candidate (`FOR UPDATE`) -> the event (`FOR UPDATE`) -> its activities (by id,
`FOR UPDATE`). A bounded wait is the caller's `lock_timeout` (the service sets 5 s): `409 try_again`, nothing removed.

## Refusals (SQLSTATE 55000, message `session_undo:<code>`; the service answers 409 with a sentence that names what to do)

`candidate_not_imported`, `already_undone`, `approval_missing`, `event_mismatch`, `event_missing`, `event_team_mismatch`,
`event_session_mismatch`, `two_events_for_session`, `manual_occasion`, `shared_activity`, `other_event_link`, `entangled_activity`,
`roster_decisions_exist` (a coach has worked on the roster: refused first, clearing is a later step), `calendar_link_exists`
(remove the session from the calendar event first), `manual_write_request_exists`, `referenced_elsewhere`, `request_key_reused`,
`invalid_reason`. A missing or revoked right is `42501` -> the identical 404.

## Gates before the first real undo (not the main session's to run)

1. The owner's order naming v57, both reviewers' GOs, the Rukovodilac's preflight (`session-undo-v57-preflight.sql`).
2. A fresh restore-verified backup of the environment (J19 condition 1; `docs/runbooks/gpexe-backup-verify.md`).
3. The first real undo is **owner-run**: read the preview, then undo with a reason, then the post-check, then confirm the session
   comes back as Ready (or, when the snapshot had expired, after the next *Find new sessions*).

## Known limits

* The marker proves the call came through the function; like v35 / v56 it is no defence against code that runs SQL as the
  application's role inside one transaction (separate migration and runtime roles are the recorded infrastructure task).
* The maintenance CLI stays as the fallback; an undo done by the CLI does not mark the candidate (it stays `imported`).
* `v57` is forward-only once an undo exists (the rollback script refuses).

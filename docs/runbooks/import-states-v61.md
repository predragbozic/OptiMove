# The attendance states of an import, bound to its approval (migration v61, J20-C)

`docs/ai/j20-session-review-contract.md` sections 5.2 and 5.3. Migration: `migrations_v2/202611101200_training_load_v61_import_states_approval.sql`.
Files beside this runbook: `import-states-v61-preflight.sql`, `-postcheck.sql`, `-rollback.sql`.

## What it is

* The owner's O2 (option A, 2026-11-09): the attendance states of an import are saved right after it, by the same button, as a second
  step. O1 (v60): the undo removes what the import wrote without a question. v60 lets a roster request say `origin = 'import'`; v61
  binds such a request to ONE approval.
* `training.activity_roster_requests.origin_approval_id` (uuid, a foreign key to `training_load.gpexe_import_approvals`; NULL for every
  other request). CHECK: `origin = 'import'` exactly when it is set. No backfill (the preflight shows no import-origin request exists).
* `training_load.import_states_window()` is the one place the window lives: **30 minutes** after the approval (the *Rukovodilac*'s decision
  of 2026-11-10). After it the states are set in the Roster tab. The route reads the same function; no number is duplicated in code.
* The request guard (`training.protect_activity_roster_request_v61`, the trigger re-pointed; v60's function stays for the rollback) keeps
  v60's rules and, for an import-origin request, checks the named approval: the same team, the same user, the same session (its event
  linked to an activity of the request's alias set), `approved_at <= created_at <= approved_at + window`, its candidate not undone (v57);
  and that every decision of the request names an athlete on the session's roster (`training.activity_roster`). An athlete the coach left
  out of the import (v59) is on the roster and may get a state. Refusals are `23514`.
* The writer is `POST /api/training-load/gpexe/teams/:teamId/approvals/:approvalId/states` (the roster bulk command, bound to the
  approval; `backend/src/activityRosterCommands.js` `decideImportStates`). Its own refusals: another user's or team's approval and a
  missing one are the identical 404; `409 import_states_window_closed` after the window; the roster's own codes otherwise. A saved
  request replays its answer even after the window.

## The one thing to know when running it

* The migration refuses to run when v60's guard is not the one in force (md5), when the trigger does not run it, or when an
  import-origin request exists already.
* It takes a short `ACCESS EXCLUSIVE` lock on `training.activity_roster_requests` (`ALTER TABLE`, and the trigger re-point). Run the
  preflight at a quiet moment (no roster command, undo or check in flight); run the post-check after the deploy.
* v61 needs v60 in force (the `origin` column); it is deployed after v60's deploy and post-check.

## Rollback

`import-states-v61-rollback.sql` re-points the trigger to v60's guard, drops the CHECK, the column, the window function and v61's guard,
and removes the v61 record. It refuses (changing nothing) while the migrator runs, when v61 is not the last migration, when a v61 body is
not the one in force, or once an import-origin request exists: after that, v61 is forward-only. The backend before J20-C must be deployed
first (it never writes the column).

# The undo of an imported session is always possible (migration v60, O1)

`docs/ai/j20-session-review-contract.md` section 5.3 and 9.2. Migration: `migrations_v2/202611091200_training_load_v60_session_undo_roster_work.sql`.
Files beside this runbook: `session-undo-roster-work-v60-preflight.sql`, `-postcheck.sql`, `-rollback.sql`.
Tests: `backend/tests/session-undo-roster-work-v60.test.mjs` (16), `backend/tests/session-undo-u5.test.mjs` (30), `frontend/tests/gpexe-undo-u5b.actions.test.mjs` (25).

## What it is

* Before v60 the undo (v57) refused a session that had any roster decision, request, completion or completion log row (`roster_decisions_exist`), and
  nothing could remove them: the four v25 tables are append-only. The owner's decision (O1, 2026-11-09): undo and re-import must always be possible,
  because coaches change statuses later.
* `training.activity_roster_requests.origin` (`'roster'` default, `'import'`) tells the two kinds of work apart. The database accepts `'import'` only
  for a request by the same user who approved an import of this session (an event linked to the activity or its alias set), made after that approval.
  The generic roster routes never name the column. J20-C is the first writer of `'import'`.
* The roster work of a session is split by `training_load.session_undo_roster_work(alias_ids)`:
  * **import-written**: requests with origin `'import'`, the decisions of athletes whose whole chain is such requests', the log rows of such requests,
    the completions all of whose log rows are such;
  * **later** (a coach's own work): everything else. A later decision that supersedes an import-origin one makes the athlete's whole chain later work.
    A completion the coach confirmed after the import is later work.
* `training_load.undo_imported_session` is now a **7-argument** function (the 6-argument one is dropped; a 6-argument call still resolves, the seventh
  argument defaults to null). Import-written work goes with the session without a question. Later work goes only when the call carries the
  **fingerprint** of the list the administrator saw (`p_confirm_later`), compared under the team lock and the activity locks with the list as it is then:
  no confirmation -> `roster_work_needs_confirmation` (409, counts and the fingerprint), another fingerprint -> `roster_work_changed` (409), nothing
  removed in either case. More than 500 later decisions -> `roster_work_too_large` (the log cannot hold the list).
* The value `'preview'` in `p_confirm_later` is the read-only call's marker: it skips that gate and returns the blocks; the service runs it in a
  transaction it rolls back. The route accepts only a 32-character hex fingerprint, so `'preview'` cannot arrive from a client.
* The four roster tables get ONE DELETE exception each, true only inside the undo's own transaction (the v57 marker). UPDATE, TRUNCATE and every other
  DELETE stay refused.
* The deletion log records what went: `import_deletion_log.roster_work_removed` (counts, a list of at most 500 later decisions with athlete id, kind, reason
  code, deciding user and time - never a note - and the administrator who confirmed, who must be the one who ran the undo). The log's insert guard checks
  the shape; the log stays append-only.
* The roster commands and the undo already take the same team import lock in the same users-first order, so an undo and a Change serialise (tested in both orders).

## Running it

* Quiet moment; the preflight (`-preflight.sql`, each block read-only) first. The migration takes short locks on the roster and log tables for the `ALTER TABLE`s and
  refuses to run when any body it replaces is not the one it expects (md5); it checks its own bodies afterwards.
* The deploy replaces the app and the function together; between the migration and the new code there is no window in which the old code calls a function
  that no longer exists only if both go out in one deploy (they do: the migrator runs at start-up, before the server).
* After the deploy: `-postcheck.sql` (read-only).

## What a coach's later work means for the undo screen

The administrator sees two separate statements: the attendance states set at import ("5 attendance states set at import will be removed") and, if a coach has
worked on the session since, a warning with the list (names and states) and its own tick. The request carries the fingerprint of that list. If the list changed
in the meantime the undo is refused with nothing removed and the screen asks to open Undo again.

## Rollback

`session-undo-roster-work-v60-rollback.sql` restores v57's 6-argument function and scope, v25's four trigger functions and v21's insert guard (checked by md5),
and drops the functions and the two columns. It refuses (changing nothing) once any request has origin `'import'` or any deletion-log row has
`roster_work_removed` (forward-only from then on), under a later migration, when a body in force is not v60's, or while the migrator runs.

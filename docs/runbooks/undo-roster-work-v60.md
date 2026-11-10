# The undo also removes the roster work (migration v60, O1 of J20)

`docs/ai/j20-session-review-contract.md` section 5.3. Migration: `migrations_v2/202611101000_training_load_v60_undo_roster_work.sql`.
Files beside this runbook: `undo-roster-work-v60-preflight.sql`, `-postcheck.sql`, `-rollback.sql`.

## What it is

* The owner's O1 (2026-11-09): undo and re-import must always be possible. Before v60 the undo (v57) refused any session with
  roster work (`roster_decisions_exist`); after v60 it removes the session's roster work with it.
* **What the import wrote** (a roster request with `origin = 'import'`, J20-C's states route; the decisions, completion and log rows
  that request wrote) never blocks and needs no question of its own; the preview names it ("The undo also removes the N
  attendance states the import set.").
* **Later work** (everything else: the Roster tab, a colleague's change, a Complete, a Reopen, an automatic *Needs review*) is
  removed only with `laterRosterFingerprint`, the fingerprint of exactly the list the preview showed: sending it IS the
  confirmation, so a confirmation without a fingerprint cannot exist. The function compares it under the team's import lock,
  which every roster command takes too: a change in between is `409 roster_work_changed` and nothing is removed; without a
  fingerprint it is `409 roster_work_needs_confirmation`; a fingerprint sent while there is no later work at all is
  `roster_work_changed` too. A completion-log row without a request (an automatic *Needs review*) counts as later work; it can only
  exist after a later Complete, which is later work itself. `laterWork.changes` is the server's count of the coach's later acts
  (decisions plus Complete / Reopen), the number the screen shows.
* `activity_roster_requests.origin` (`roster` | `import`, DEFAULT `roster`, no rewrite). The generic roster routes never name it.
  `import` is accepted only for a `decide` or `decide_bulk` (J20-C writes states, nothing else), and only when an approval of the same session (an event linked to an activity of the alias set) by the same
  user exists from before the request; otherwise `23514`.
* The four roster tables (decisions, completion log, completions, requests) accept a `DELETE` only inside the undo's own
  transaction (v57's marker); `UPDATE` and `TRUNCATE` stay refused.
* `import_deletion_log.roster_work_removed` records what was removed: the counts of both kinds, the list of later changes (at most
  60; athlete, kind, reason code, by, at; never a note), the fingerprint and `confirmed_by` (the undoing administrator whenever later
  work was removed). The insert guard checks this closed shape; the table stays append-only. `removed_counts` carries the four
  roster tables.
* `training_load.undo_imported_session` has seven arguments (the new `p_later_roster_fingerprint text default null`)
  and returns `roster_work_removed`; v57's six-argument signature is dropped. Its request hash is v57's when nothing is confirmed,
  so a request saved before v60 replays unchanged.

## The one thing to know when running it

* The migration refuses to run when any body it replaces or copies is not the one it expects (md5 of `prosrc`): v57's undo, scope
  and marker, v21's log guard and v25's four roster guards.
* It takes short `ACCESS EXCLUSIVE` locks on `training.activity_roster_requests` and `training_load.import_deletion_log` (`ALTER
  TABLE`), and re-points five triggers (`DROP TRIGGER` / `CREATE TRIGGER` lock each of the five tables: the four roster tables and
  the deletion log). A decision's `UPDATE` that supersedes it (the roster command's own write) stays allowed as before. Run the preflight at a quiet moment (no undo, roster command or check in flight); run the
  post-check after the deploy.
* The new backend calls the seven-argument function, so the deploy that applies v60 and the code that calls it are the same deploy
  (`npm start` runs the migrator before the server).

## Rollback

`undo-roster-work-v60-rollback.sql` re-points the five triggers to their originals, restores v57's scope and undo exactly (checked by
md5 afterwards), drops the two columns and every v60 function, and removes the v60 record. It refuses (changing nothing) while the
migrator runs, when v60 is not the last migration, when a v60 body is not the one in force, once an import-origin request exists, or
once a deletion log row records roster work: after that, v60 is forward-only. The backend before v60 must be deployed first (it
calls v57's six-argument function).

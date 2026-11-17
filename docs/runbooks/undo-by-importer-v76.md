# An imported session is deleted by whoever may import it (migration v76)

Migration: `migrations_v2/202611171000_training_load_v76_undo_by_importer.sql`. Files beside this runbook:
`undo-by-importer-v76-preflight.sql`, `-postcheck.sql`, `-rollback.sql`. Tests: `backend/tests/undo-by-importer-v76.test.mjs`.

## What it is

* The owner (2026-11-17): "We must be able to delete an imported session easily, with a click on the session, e.g. in the
  calendar. Deleting may be done by the coach, i.e. by whoever imports. Re-import needs no special button." Until v76 the in-app
  undo (U5, v57; v60; v63) was a platform admin's only.
* **The right to undo is the right to approve an import of that team** (the Rukovodilac's decision, option (a)): the same four
  bases, in the same order, with the same mode rule as `lock_gpexe_import_approver` (v56):
  `platform_admin`; `team_grant` (an active coach of the team with an unrevoked approver grant); `club_admin` of the team's club
  and `team_coach` of the team, both only while the team's switch is in mode `team`. **The switch being off does not take the
  right away**: a wrong import must stay deletable.
* `training_load.lock_gpexe_session_undo_right(user, team)` derives it under `FOR SHARE` locks in the revocations' order (users,
  then the role rows, then the switch row last) and returns the basis, or `42501` (the route answers the identical 404).
* `undo_imported_session` takes its right from it and writes the basis to `import_deletion_log.authorized_via`, whose CHECK now
  takes the four bases. The log's insert guard (`validate_import_deletion_log_v60`) derives the basis again: a row naming a basis
  its user does not hold is refused (`42501`), so a coach cannot record an undo as a platform admin's.
* A coach may undo a session another coach (or a platform admin) imported: the same right; the log names who deleted it.
* What the undo removes, refuses and offers again is unchanged (v57, v60, v63). The athlete's RPE
  (`training_load.session_feedback`) is not touched: it belongs to the planned session, not to the import. After the undo the
  athlete's "My training" no longer counts the session (`GET /api/training-activity/self` answers `hasRecordedSessions: false`
  when it was her only recorded session).

## The API (for the screens)

* `GET /api/training-load/gpexe/teams/:teamId/status`: `viewer.undoImport: true` when this viewer may delete an imported
  session of the team (whatever the switch); absent otherwise.
* `GET /api/training-load/gpexe/teams/:teamId/activities/:activityId/import-undo` (new; `no-store`): the import behind a
  session of the calendar or Activities, through the activity's alias set: `{ importUndo: { candidateId } }` for the newest
  approved import of the session that is still imported and not undone. Everything else, including no right, a session that
  was not imported, another team's, an undone one and a malformed id, gets the identical 404.
* `GET …/candidates/:candidateId/undo-preview` and `POST …/candidates/:candidateId/undo-import` with
  `{ requestKey, reason, expected: { eventId }, laterRosterFingerprint? }`: unchanged, for the new audience. The preview's later
  roster changes keep both names (the athlete's and the staff member's) for every audience.
* The three refusals a coach can meet read as one sentence and one next step, without a code:
  * `calendar_link_exists`: "This session is attached to a calendar event. Remove it from the calendar event first, then delete
    it again."
  * `manual_occasion`: "Some results of this session were entered by hand, so its imported data cannot be deleted here. Ask a
    platform administrator to delete it."
  * `entangled_activity`: "This session was merged with another session, so its imported data cannot be deleted here. Ask a
    platform administrator to delete it."

## The one thing to know when running it

* The migration refuses to run when a body it replaces is not the one it expects (md5 of `prosrc`): v63's
  `undo_imported_session` and v60's `validate_import_deletion_log_v60`; and when there is not exactly one `authorized_via`
  CHECK. v74 (generic source fields) touches neither, so v76 applies with or without it.
* It takes the deletion log's `ACCESS EXCLUSIVE` lock with `lock_timeout` 5 s before its first change (the CHECK is replaced);
  a busy table fails the migration with nothing applied. Run the preflight at a quiet moment; run the post-check after the
  deploy.
* No table, column or row changes. The backend that offers the undo to the new audience and the bodies that allow it are the
  same deploy (`npm start` runs the migrator before the server); the backend before v76 offers the undo to a platform admin only.

## Rollback

`undo-by-importer-v76-rollback.sql` restores v63's undo and v60's log guard exactly (checked by md5 afterwards), the
platform-admin-only CHECK, drops `lock_gpexe_session_undo_right` and removes the v76 record. It refuses (changing nothing) while
the migrator runs, when v76 is not the last migration, when a v76 body is not the one in force, or once a deletion log row names a
basis other than `platform_admin`: after the first coach's or club admin's undo, v76 is forward-only. Deploy the backend before
v76 first.

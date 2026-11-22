# v89: a session type per athlete, and a type changed after the import (ST-3)

Migration `migrations_v2/202611221400_training_load_v89_participant_session_types.sql`. The plan is
`docs/ai/session-type-plan.md`; its section 16 records what was built. The files beside this one are:
- `participant-session-types-v89-preflight.sql`;
- `participant-session-types-v89-postcheck.sql`;
- `participant-session-types-v89-rollback.sql`.

The number and the 12-digit prefix are provisional until the *Rukovodilac* confirms them before the merge. If they
change, the file names, the names inside the four files, the md5 lines and `backend/tests/_gpexe-disposable-db.mjs`
change with them.

## What it does

- **`training.participant_activity_types`**: an athlete's own session type in one session (the exception). One live row
  per participant; a row only ever ends (who, when, why).
- **`training.effective_activity_type(participant)`**: the canonical participant's live exception, otherwise the
  canonical activity's type.
- **`training.activity_type_requests`**: the append-only request record of the two routes.
- **Guards:** the acting user (`optimove.session_type_actor`) with the roster decider's right on the session's team;
  the exception's type active, offered to the team's club and different from the session's.
- **`training.merge_activity_participants` and `training.reparent_activity_participant`** (v4) are replaced under an
  md5 gate. Each gains one block: a merge ends the merged participant's exception, a reparent ends the participant's.
- **`training.activity_field_correction_log`**: its foreign key to the activity becomes `ON DELETE CASCADE`, and a guard
  refuses every delete outside the sanctioned undo of an imported session. The undo's function is not changed. A new
  correction is dated by the wall clock (a trigger).
- **Locks at deploy:** the migration sets `lock_timeout = '5s'`. Its foreign keys take a short lock on the activity,
  participant, athlete and user tables. If a long transaction holds one of them, the migration fails with a lock
  timeout and changes nothing; the deploy is repeated at a quieter moment.
- **What it does not change:** no activity, no type, no other row. No exception exists after the migration.

## Before the merge

1. **Preflight**, read-only, each block as `begin transaction read only; <block>; rollback;`. Every ok column must be
   true.
   - Block 2 checks that the two bodies in force are v4's. If another migration replaced one of them first, v89
     refuses to run and must be rebuilt on the new body.
   - Block 3 shows the correction log's size: the migration rebuilds its foreign key, which reads every row once
     under an exclusive lock on that table. Before ST-3 nothing wrote that table, so it is expected to be empty.
2. **Block 5 of the preflight, in git:** the 12-digit prefix is unique on the merge tree.

## After the deploy

- **Post-check**, read-only. Every ok column must be true. Block 4 (no exception, no request row) holds only right
  after the deploy.
- The routes answer 401 without a login:
  - `POST /api/training-activity/<zero UUID>/type` with `{}`;
  - `PUT /api/training-activity/<zero UUID>/roster/<zero UUID>/type` with `{}`.

## Rollback

`participant-session-types-v89-rollback.sql`, one transaction, at a quiet moment, and only on its own approval.
- **Before running it:** the deployed commit no longer contains the v89 file and no longer calls
  `training.effective_activity_type` or the two tables (the estimates and the roster read probe for the table, so an
  older world reads as before ST-3).
- **When it refuses**, changing nothing: once an exception or a request row exists, a later migration is applied, or
  the two bodies in force are not v89's. From then on v89 is forward-only.
- **What it restores:** v4's two bodies verbatim (checked by md5) and the correction log's v1 foreign key.
  `backend/tests/session-types-st3-migration.test.mjs` test 1 checks that the catalog then equals the one before v89.

## Known limits

- The guards prove that the row, the actor and the right agree. They do not stop whoever holds the database
  credentials (as v35 states it).
- **The undo of an imported session removes the session's type changes and exceptions without a question.** They go
  with the activity and its participants (the cascade, under v57's marker). The deletion log does not count them, and
  the undo's confirmation of later roster work (v60) does not list them. Listing them belongs to the undo's own
  migration (the one that lists manual values, ST-4).
- An exception belongs to a participant row. An athlete with no record in a session (no recording, no estimate, no
  RPE) cannot get one: `409 athlete_has_no_record`.
- The mark on a saved estimate is derived from the correction log and the exception rows. A type changed on a
  provisional activity by a plain `UPDATE` writes no correction, so the mark does not see it.
- Two settings open a guard for a sanctioned function, and any SQL session could set them: `training.allow_participant_type_end`
  (a merge or a reparent ending an exception) and v57's undo marker (the deletes). This is the class of the existing
  `training.allow_*` settings.
- The older undo CLI (`backend/scripts/gpexe-undo-imported-session.mjs`, disposable databases only) does not set v57's
  marker. The delete guards refuse it for a session with a type change or an exception.
- After a COMMIT whose answer was lost, the request is looked up by the caller's own (user, key) and hash, without a
  second rights check: it confirms a write the same request made.
- Not run on PostgreSQL 17 (production runs 17.6).

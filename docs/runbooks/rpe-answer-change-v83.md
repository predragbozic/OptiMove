# Runbook — migration v83: an athlete changes their own RPE answer (central calendar K4b)

Migration: `migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql`. Contract:
`docs/ai/central-calendar-k4b-contract.md` (PR #647; the OptiMove manager's GO of 2026-11-19, Q1: the duration may change).
★★: a migration (trigger 1) and a transaction with a lock order, a race and idempotency (trigger 4).

## What v83 does

- Adds `training_load.session_feedback_changes`, the append-only history of a changed answer (who, when, old and new
  values, the basis `athlete_self`, the request key and its hash; one revision per change).
- Adds `training_load.change_external_rpe(actor, assignment, requestKey, rpe, durationMinutes, note, expectedRevision)`,
  the sanctioned change of an **external (calendar) RPE answer**, in place, while the question is open. Lock order: the
  acting user (share) → schedule → occurrence → assignment (the submit's own order, all `FOR UPDATE`) → the athlete of the
  **locked** assignment (share; its `user_id` must be the actor) → the answer (`FOR UPDATE`) → the history row. The window
  is read with `clock_timestamp()` after the locks.
- Re-points the trigger `protect_session_feedback_snapshot` to a v83 function that copies the v5 rule and its message and
  lets `rpe`, `duration_minutes` and `athlete_note` differ only under the transaction-local marker
  `optimove.rpe_change_tx` (set by the function for its own call) and only on a `scheduled_external` row. The v5 function
  stays in place.
- A BEFORE INSERT guard on the history (the marker, the athlete's own active user, the window under share locks, the old
  values, the next revision) and a deferred constraint trigger `session_feedback_change_link` (a changed answer without its
  history row from the same transaction, or written in a savepoint, is refused at COMMIT).
- Writes no row of any existing table. `srpe` is a generated column and follows a change; every reader of
  `session_feedback` reads the one current row (contract 1.5, ADR-004).

The route is `POST /api/training-load/external-assignments/:assignmentId/rpe/change` (the athlete only; everyone and
everything else the identical 404 "Training session not found."). A closed question answers `409 answer_locked` "This
answer can no longer be changed. The question is closed."

## Before the merge (the OptiMove manager, the same day)

1. The rehearsal on PostgreSQL 17 by the owner (below) — until then PostgreSQL 17 is **NOT RUN**.
2. The read-only preflight `docs/runbooks/rpe-answer-change-v83-preflight.sql`, each block as
   `begin transaction read only; <block>; rollback;`. Every `ok_*` column true; block 5 is information.
   - Block 2 expects nothing recorded after v83. Note: v84 (roles R2) has the prefix `202611201000`, which sorts
     **before** v83's `202611201200`; whichever is merged second, the runner applies both by name. Once v83 is applied,
     v84's own rollback refuses ("later migrations are applied"), and the other way round v83's does not care about v84.
3. The owner's order naming the file: `202611201200_training_load_v83_rpe_answer_change.sql` and its sha256 (the
   post-check's block 1 holds it).

## After the deploy

The read-only post-check `docs/runbooks/rpe-answer-change-v83-postcheck.sql`, each block in a read-only transaction.
Every `ok_*` column true. Its digests (blocks 2 and 3) are from PostgreSQL 16; on 17 a digest that differs is read block
by block (the rehearsal's step 9 prints any difference), never "fixed" in the file.

## The rehearsal (one trip with v84)

`backend/scripts/rpe-answer-change-v83-rehearsal.mjs` (with `.sh` and `.ps1` wrappers): a disposable database from the
legacy snapshot and the real runner, the preflight, v83 applied, the post-check, the runner again, the rollback with the
catalog compared, v83 again, one real change (the answer changed, `srpe` followed, a raw update refused, the rollback then
refused), and a `pg_dump` / `pg_restore` read-back of v83's catalog. Loopback only; its databases are
`optimove_tests_k4bv83rehearsal_*` and are always dropped.

When the v84 rehearsal script (`permission-roles-v84-rehearsal.mjs`) is in the same checkout, the wrappers run it right
after v83's, with the same password: one command, one prompt, both results.

```
# Windows (PowerShell), PostgreSQL 17:
powershell -ExecutionPolicy Bypass -File backend\scripts\rpe-answer-change-v83-rehearsal.ps1 -DbHost 127.0.0.1 -Port 5432 -User postgres -PgBin "C:\Program Files\PostgreSQL\17\bin"
# bash:
backend/scripts/rpe-answer-change-v83-rehearsal.sh --host 127.0.0.1 --port 5432 --user postgres --pg-bin /usr/lib/postgresql/17/bin
```

Expected: every line `PASS` and `=== v83: PASS ===` (plus `· v84: PASS` when v84's script is there).

## Rollback

`docs/runbooks/rpe-answer-change-v83-rollback.sql`, one transaction, never automatic. It refuses (`23514`, changing
nothing) while the migrator runs, when v83 is not recorded or a later migration is, **once any history row exists** (an
answer was changed), when another table refers to the history, or when the v5 function is not the one v83 was applied
over. From the first change on, v83 is forward-only. Before it is run anywhere real: the deployed commit no longer
contains the v83 file, and the database is named in its own approval.

## What the guards do not stop

They prove that the row, the history and the window agree; they do not stop whoever holds the database credentials (who
can set the marker and write a well-formed history row, or disable a trigger) — the same statement as v35. The separate
migration and runtime roles stay the later infrastructure task.

# Manual values on the roster: migration v87

Migration: `migrations_v2/202611221100_training_load_v87_manual_values.sql` (the 12-digit prefix is temporary until the
*Rukovodilac* gives the final one before the freeze; rename the file and every reference below together).
Plan: `docs/ai/session-type-plan.md` sections 7, 8 and 13 (Q3), and section 16 "ST-4 as built".

## What it changes

- `training_load.metric_manual_values`: the provenance of every manual value written on the roster (entry, correction,
  restore): who, when, on which right, which request. Append-only; removed only by the session undo.
- Guards: the acting user (`optimove.manual_value_actor`), the occasion's shape per kind, a restore equal to the measured
  values in every semantic column, a roster manual occasion without provenance refused at COMMIT, an occasion with
  provenance closed to further input values.
- `training.activity_roster_needs_state`: an athlete with roster-written values has a state.
- The session undo: manual values are listed (count, current ones, fingerprint) and removed only with
  `p_manual_values_fingerprint` (a new trailing argument with a default; a seven-argument call is unchanged). A
  Metrics-screen write request still refuses first. `import_deletion_log.manual_values_removed` records what was confirmed.
- `training_load.gpexe_import_approvals`: `replaced_manual_athlete_ids` and `chosen_activity_type_key` (empty until the
  re-import question and ST-2's chosen type write them) and v59's subset-hash pair rule widened over them.

## Order of the deploy

1. The owner's order naming v87, and a quiet moment (no import, check or undo running: the migration takes the occasions
   and values SHARE ROW EXCLUSIVE and the deletion log and approvals ACCESS EXCLUSIVE, `lock_timeout` 5 s).
2. Preflight: `manual-values-v87-preflight.sql` (read only; every column true).
3. Deploy (the migrator applies v87 at start).
4. Post-check: `manual-values-v87-postcheck.sql` (read only; every column true).

The server flag `MANUAL_VALUES_ENABLED` is on unless it is `"false"` (the *Rukovodilac*, 2026-11-22): no Render change is
needed. Setting it to `false` makes every manual-values route the identical 404 and hides the roster action; it does not
touch data.

## Rollback

`manual-values-v87-rollback.sql`, one transaction, only with the owner's approval for that database and a fresh
restore-verified backup, and only from a commit that no longer contains the v87 file. It restores v76's undo, v63's scope
and v26's needs-state by md5, v59's pair rule, and drops everything v87 added. It refuses, changing nothing, while the
migrator runs, under a later migration, over a changed v87 body, and once v87's data is used (a provenance row, a logged
manual removal, an approval choice): from then on the way back is forward only.

Rehearsed on disposable databases: `backend/tests/manual-values-st4.test.mjs` tests 13 and 14.

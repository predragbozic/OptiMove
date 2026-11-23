# Manual values on the roster: migration v88

Migration: `migrations_v2/202611221300_training_load_v88_manual_values.sql` (number and prefix given by the *Rukovodilac*
on 2026-11-22; first named v86 / `202611221100`, renumbered v88 / `202611221300` the same day so the positions
migration v87 goes first - v86 stays unused).
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

1. The owner's order naming v88, and a quiet moment (no import, check or undo running: the migration takes the occasions
   and values SHARE ROW EXCLUSIVE and the deletion log and approvals ACCESS EXCLUSIVE, `lock_timeout` 5 s).
2. Preflight: `manual-values-v88-preflight.sql` (read only; every column true).
3. Deploy (the migrator applies v88 at start).
4. Post-check: `manual-values-v88-postcheck.sql` (read only; every column true).

The server flag `MANUAL_VALUES_ENABLED` is on unless it is `"false"` (the *Rukovodilac*, 2026-11-22): no Render change is
needed. Setting it to `false` makes every manual-values route the identical 404 and hides the roster action; it does not
touch data.

## Rollback

`manual-values-v88-rollback.sql`, one transaction, only with the owner's approval for that database and a fresh
restore-verified backup, and only from a commit that no longer contains the v88 file. It restores v76's undo, v63's scope
and v26's needs-state by md5, v59's pair rule, and drops everything v88 added. It refuses, changing nothing, while the
migrator runs, under a migration applied after v88 (by `applied_at`: v89, applied before v88 on production by the
runner's name order, does not block), over a changed v88 body, and once v88's data is used (a provenance row, a logged
manual removal, an approval choice): from then on the way back is forward only.

Rehearsed on disposable databases: `backend/tests/manual-values-st4.test.mjs` tests 13 and 14.

## Before the merge: the rehearsal on PostgreSQL 17

`backend/scripts/manual-values-v88-rehearsal.mjs` (wrappers `.sh` and `.ps1`, the v85 pattern) runs on any local server
and prints PASS / FAIL per step and `RESULT: PASS`. It builds a disposable database through v85 with the real runner,
runs the preflight, applies v88 (checksum = the file's sha256), writes a guarded manual entry as the service does (rolled
back, then committed) with the five refusals (no acting user, a forged author, no provenance by COMMIT, a value after the
provenance, a TRUNCATE), runs the post-check, the runner again, the rollback (the catalog of `training` and
`training_load` equal to the one before v88), v88 again, the rollback's refusal once a manual value exists, and a
`pg_dump -Fc` / `pg_restore` read-back of v88's objects. Loopback only; it creates and drops only its own
`optimove_tests_st4rehearsal_*` databases and takes no database name. Needs `npm --prefix backend ci` and `pg_dump` /
`pg_restore` of the server's major version.

    backend/scripts/manual-values-v88-rehearsal.sh --host 127.0.0.1 --port 5432 --user postgres --pg-bin /usr/lib/postgresql/17/bin

    powershell -ExecutionPolicy Bypass -File backend\scripts\manual-values-v88-rehearsal.ps1 -DbHost 127.0.0.1 -Port 5432 -User postgres -PgBin "C:\Program Files\PostgreSQL\17\bin"

The password comes from `PGPASSWORD` if set, otherwise it is asked once, hidden, and never printed. In step 8 a restore
re-prints a varchar IN-list (`ARRAY['a'::character varying]::text[]` as `ARRAY[('a'::character varying)::text]`; a v21
constraint shows it too): constraints are compared with those casts and parentheses taken out, and the count of such
constraints is printed. Run on PostgreSQL 16.15 here: `RESULT: PASS` (6 constraints equal after that re-print).

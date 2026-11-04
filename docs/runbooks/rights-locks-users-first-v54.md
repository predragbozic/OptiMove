# Runbook: migration v54, the database's own rights locks take the users row first (LO-2)

Migration: `migrations_v2/202611041100_training_load_v54_rights_locks_users_first.sql`.
Suite: `backend/tests/rights-locks-users-first-lo2.test.mjs` (disposable databases only).
Files beside this one: `rights-locks-users-first-v54-preflight.sql`, `-postcheck.sql`, `-rollback.sql`.

## What it does

Replaces seven function bodies (`CREATE OR REPLACE`; no table, column, trigger, index or row):

| Function | Came with | Role in a request |
|---|---|---|
| `training_load.lock_gpexe_import_approver` | v23 | first rights lock of an import approval |
| `training.lock_activity_decider` | v26 | first rights lock of a roster decision |
| `calendar.lock_event_writer` | v49 | first rights lock of a calendar event write and of v51's settings writes (the users row was locked last) |
| `training_load.source_metric_require_platform_admin`, `..._require_club_admin` | v34 | inside the write's triggers |
| `training_load.source_metric_actor_basis` | v35 | inside the write's triggers |
| `training_load.metric_variable_change_basis` | v38 | inside the write's triggers |

In each, the acting user's row is locked `FOR SHARE` in a statement of its own before the role row(s), the order the
revocations of `routes/organization.js` lock in. The role queries keep the active-user condition, so an inactive or
unknown user reaches the same outcome as before (the suite compares return value, SQLSTATE and message over 135
combinations of user state and role state, before and after). Signatures and error codes are unchanged. One
difference: the users row is now share-locked also when the role row does not exist.

Wider locking, stated: each call now holds a `FOR SHARE` lock on the acting user's (active) `users` row until the end
of the transaction; it conflicts only with an exclusive write of that same row (a revocation, which is intended, or a
profile or password write). None of the services that call these functions updates that row in the same transaction
(checked by grep).

## Evidence (disposable databases)

- Before v54, on the v53 bodies: a revocation of the same user (users row, then role row) against each of the 15
  function/basis cases ends in `40P01` in all 15 (the suite asserts all 15), including v23 and v26, which LO-1 had not yet reproduced for the
  functions themselves.
- After v54: no `40P01` in any case; the revocation takes its role row and the function completes after it.
- The md5 gate refuses a database whose body is not the one v54 replaces (`23514`) and changes nothing.
- The rollback restores the seven v53 bodies byte for byte (md5), refuses under a later migration, a missing record
  or a changed body, and v54 applies again.
- Mutations (each killed): the users lock removed from one body; the active-user condition dropped from v49's user
  lock; v26's users lock moved after the role query.

## Deploy

0. Run the preflight and post-check as the role the migrator uses (the application's `DATABASE_URL` role), or a member of it:
   block 4 of the preflight checks ownership of the seven functions with `pg_has_role`. The lock-wait blocks look at
   this database only.
1. Preflight (read-only): `rights-locks-users-first-v54-preflight.sql`, four blocks, every `ok` true: v53 is the last
   migration and v54 absent; the seven md5 values equal the bodies v54 replaces; a quiet moment; the migrator's role
   owns the seven functions.
2. Deploy. `npm start` runs `node src/migrate.js` first; v54 takes the function rows briefly (no table lock).
3. Post-check (read-only): `rights-locks-users-first-v54-postcheck.sql`, four blocks, every `ok` true.

## Rollback

`rights-locks-users-first-v54-rollback.sql` (not a migration, never automatic). Only with a fresh restore-verified
backup, after the deployed commit no longer contains the v54 file, and with the owner's approval for that database.

## Known limitation (L1, the *Nezavisni revizor*, LOW)

The users lock carries `is_active = true`, so an inactive user's row stays unlocked. A user reactivated between the two
statements of one function is seen as active by the role query while the users row is not locked, and a later
deactivation does not wait for the write in flight. Theoretical, not reproduced; microseconds and a double change of
state. Cleaner fix for later (the *Rukovodilac*): lock the users row without the `is_active` filter and read the
activity from the column.

## Recorded, not changed

- LO-1's DB-2 (an import approval locks its rights rows first and reads T4 later; A1 holds T4 and takes its rights
  after it; a platform revocation locks every platform admin in user id order): users-first does not change this
  difference in position. Nothing is written (`40P01` / `try_again`). The *Rukovodilac* accepted a documenting
  test only, no reordering (2026-11-04); that test is not part of this migration.

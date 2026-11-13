# Dashboard Simple atomic save (v66)

Migration: `migrations_v2/202611131000_training_load_v66_dashboard_simple_atomic_save.sql`.

## Preflight

- Confirm that the target commit adds only this pending migration and that the preceding migration ledger matches the approved baseline. Confirm that a fresh backup can be restored.
- With a read-only connection, check that the receipt table and widget presentation column are absent. Compare the hash of the installed trigger function with the migration gate:

  ```sql
  select md5(prosrc) from pg_proc
  where oid = to_regprocedure('training_load.dashboard_widgets_bump_revision()');
  ```

- Record widget and series counts. Obtain the owner's approval before merge and deploy.

## Postcheck

- Confirm the migration ledger records the filename and the repository checksum. Verify the presentation column, validation constraint, both presentation triggers and the save receipt table exist.
- Compare widget and series counts during the release window. Verify the Simple capability and authenticated preview. Exercise a save and retry only on a disposable database or an explicitly approved test dashboard.

## Rollback

Restore the previous application version and stop dashboard writes before using [the rollback script](dashboard-simple-v66-rollback.sql). Run it with `psql -v ON_ERROR_STOP=1` only on the approved database. The script refuses if a later migration is present, the revision function changed, or saved presentations or request receipts exist. If it refuses, stop and plan a forward fix or an approved backup restore.

Before requesting release approval, rehearse apply, rollback, catalog comparison and reapply against a disposable copy of the target schema. Record the results in the PR.

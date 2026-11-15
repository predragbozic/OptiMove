# Dashboard Simple atomic save (v71)

Migration: `migrations_v2/202611151000_training_load_v71_dashboard_simple_atomic_save.sql`.

## Preflight

Run [preflight SQL](dashboard-simple-v71-preflight.sql) with psql and confirm all three schema checks and each slot_matches value return true. Each recorded value may be true or false.

- Confirm that the target commit adds only this pending migration and that the preceding migration ledger matches the approved baseline. Confirm that a fresh backup can be restored.
- With a read-only connection, check that the receipt table and widget presentation column are absent. Compare the hash of the installed trigger function with the migration gate:

  ```sql
  select md5(prosrc) from pg_proc
  where oid = to_regprocedure('training_load.dashboard_widgets_bump_revision()');
  ```

- Record widget and series counts. Obtain the owner's approval before merge and deploy.

## Postcheck

Run [postcheck SQL](dashboard-simple-v71-postcheck.sql) with psql and compare the reported counts and checksum with the release records.

- Confirm the migration ledger records the filename and the repository checksum. Verify the presentation column, validation constraint, both presentation triggers and the save receipt table exist.
- Compare widget and series counts during the release window. Verify the Simple capability and authenticated preview. Exercise a save and retry only on a disposable database or an explicitly approved test dashboard.

## Rollback

Restore the previous application version and stop dashboard writes before using [the rollback script](dashboard-simple-v71-rollback.sql). Run it with `psql -v ON_ERROR_STOP=1` only on the approved database. The script refuses if a later migration is present, the revision function changed, or saved presentations or request receipts exist. If it refuses, stop and plan a forward fix or an approved backup restore.

Before requesting release approval, rehearse apply, rollback, catalog comparison and reapply against a disposable copy of the target schema. Record the results in the PR.

## Activation

Apply PR #530's v70 before v71. The preflight value v70_required_recorded must be true. Keep DASHBOARD_SIMPLE_MODE=off during deployment, then move to preview before enabled. Invalid active configuration stops server startup. Active mode refuses transaction pooling on port 6543 or with pgbouncer=true. Verify the target DATABASE_URL provides session affinity before activation.

The required settings are DASHBOARD_SIMPLE_MODE, DASHBOARD_SIMPLE_BUDGET_VERIFIED, DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED, DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE, DASHBOARD_SIMPLE_KEY_ID, and DASHBOARD_SIMPLE_KEY_BASE64. DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON is optional for key rotation.

While off, the Simple editor routes stay unavailable. Legacy query responses carry presentation_config when present, widget create/update accepts presentation, dashboard cloning preserves it, and measured aggregates exclude estimates. Add widget checks Simple capabilities and falls back when the route returns 404.

The request ledger has no dashboard foreign key so receipts can outlive their dashboards through the retention window. The existing app retention schedule checks for the cleanup function and processes up to five batches of 100 expired receipts per tick. Updates, truncates and deletions before expiry are refused. Receipts are removed only after expiry. With Simple off, rollback can run at the earliest seven days and ten minutes after the last save and after a cleanup tick has emptied the ledger. A faster path requires a separate owner-approved operation.

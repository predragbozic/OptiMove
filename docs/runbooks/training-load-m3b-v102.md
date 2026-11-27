# Training Load Estimates Manage bridge (v102)

The bridge requires the approved v101 migration and stages Estimates Manage for the existing native Club admin and Team coach roles, live club versions and effective custom layers. Pending default updates stay pending. Proposal and save check the bound workspace and fresh rights. The v64 hash and provenance rows still back retries and receipt checks.

## Preflight and rehearsal

1. Confirm the migration slot, the exact v101 record and the deployed predecessor SHA.
2. Run `training-load-m3b-v102-preflight.sql` read-only. Require its four results to be true.
3. On a dedicated loopback PostgreSQL 17 cluster, run `backend/scripts/training-load-m3b-v102-rehearsal.ps1` or `backend/scripts/training-load-m3b-v102-rehearsal.sh` with Node 20 or newer. Set `OPTIMOVE_M3B_PREVIOUS_SERVER` to the clean checkout of the deployed predecessor and `OPTIMOVE_M3B_PREVIOUS_SHA` to its full SHA. PowerShell accepts `PGPASSWORD` or a hidden password prompt. Verify the exact prior-server case executed.

## Apply and postcheck

1. Apply `202612041000_training_load_v102_estimates_manage_bridge.sql` once through the normal runner on the owner's order.
2. Run `training-load-m3b-v102-postcheck.sql` read-only. Compare the checksum and seed counts, require the expected body and a null first checked write, and check service health.
3. Keep `ESTIMATES_ENABLED` off. Permission exposure follows retirement of old writers in its own release. Enabling estimates also requires the separate participant-provenance release and the owner's approval.

## Rollback

Drain bridge and previous writers before authorizing `training-load-m3b-v102-rollback.sql`. It refuses after checked use, a changed seeded layer or permission item, a different body, or a later recorded migration. It restores the v101 permission body and the audited v102 seed. Unrelated native memberships, role assignments and their receipts keep their current state. A membership change that ends a seeded custom role still makes rollback refuse. If rollback refuses, keep the migration in place and review a forward fix.

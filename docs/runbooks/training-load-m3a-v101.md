# Training Load Roster Decide bridge (v101)

This bridge requires the approved v99 migration. Dashboard v100 may be present or absent. The bridge seeds the existing Roster Decide permission for the two native basic roles and the applicable live club versions and custom layers. Existing unresolved default updates remain pending. It does not expose the permission in Settings → Roles or change the native permission projection.

## Preflight

1. Confirm the deployed production SHA, the migration order and the v101 file checksum against the frozen release packet.
2. Run `training-load-m3a-v101-preflight.sql` read-only during a quiet moment. Require all four results to be true.
3. Rehearse the approved pre-bridge build and the proposed bridge on the same migrated disposable PostgreSQL 17 database. Run the old and bridge staff requests, replay and role-edit checks before authorizing deployment.

## Apply and verify

1. Apply `202612031000_training_load_v101_roster_manage_bridge.sql` once through the normal runner on the owner's order.
2. Run `training-load-m3a-v101-postcheck.sql` read-only. Confirm the checksum matches the packet, first checked write is initially null and the permission body matches. Compare seeded role, version and custom counts with the migration evidence.
3. Verify the bridge health and the authorized staff roster and role-editor behavior. Confirm every pre-bridge writer has stopped serving before considering exposure in a separate release.

## Rollback

Drain the bridge and old writers first. Run `training-load-m3a-v101-rollback.sql` only before first checked use and exposure. It refuses after a later recorded migration, changed permission body, changed seeded state or grants, or checked use. It restores the exact v99 body. If rollback refuses, keep the bridge deployed and use a forward fix with independent review.

## Rehearsal

Run `backend/scripts/training-load-m3a-v101-rehearsal.ps1` on Windows or `backend/scripts/training-load-m3a-v101-rehearsal.sh` on Unix with Node 20 or newer and an isolated loopback PostgreSQL 17 cluster. The PowerShell script can request the password without echoing it. Set `OPTIMOVE_M3A_PREVIOUS_SERVER` to the clean checkout of the recorded prior build (with backend dependencies installed) and `OPTIMOVE_M3A_PREVIOUS_SHA` to that build’s full SHA to include the real previous-server check. The scripts run the local disposable rehearsal and print `RESULT: PASS` when both suites pass.

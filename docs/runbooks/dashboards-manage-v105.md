# Dashboard Manage v105

`202612071000_training_load_v105_dashboards_manage_bridge.sql` stages
`dashboards.manage` in PostgreSQL. Native club and team writes continue to
require dashboard View, the club licence and their existing owner/workspace
rules. The bridge keeps public Roles projection closed. It neither changes
permissions on P3 reference tables nor touches dashboard preferences.

## Preflight and deployment

1. Record the exact live server SHA. Use an isolated PostgreSQL 17 cluster and
   run `backend/scripts/dashboards-manage-v105-rehearsal.ps1` or the matching
   `.sh` with `OPTIMOVE_DASHBOARDS_PREVIOUS_SHA` set to that full SHA. The
   rehearsal requires Node 20 or newer and prints `RESULT: PASS`. Use the same
   environment for the explicit full disposable gate.
2. Run `dashboards-manage-v105-preflight.sql` read-only. Require every check
   true. It checks exact v103 and v104 registry checksums and the v103
   `public.permission_word_honoured(text)` body. It does not use the most recent
   registry row as a dependency.
3. Run only the approved migration and deploy the frozen bridge. The migration
   acquires the existing club ceiling lock in ascending club order. It stages
   the word on both built-in staff roles, current versions of those roles and
   active held custom copies, preserving pending default versions. Authored
   roles and unrelated membership/assignments stay separate.
4. Run `dashboards-manage-v105-postcheck.sql` read-only. Compare the recorded
   checksum, list the seed counts, verify the exact function body and confirm
   the use marker is present. A null first-use timestamp means the new bridge
   has not authorised a committed native dashboard write.
5. Verify the predecessor and bridge route contracts before retiring the old
   binary. Only a separate exposure release may advertise the word for Roles
   editing. Keep the Pages, Simple and reference flags at their agreed states.

## Rollback

Drain bridge and predecessor writers before running SQL rollback. Check the
preflight evidence, deployment approval and restorable backup. Run
`dashboards-manage-v105-rollback.sql` through `psql -v ON_ERROR_STOP=1 -f`. It
refuses while the migration runner is active, after a later migration, after
a checked native write, after a mismatched permission body or when the seeded
role layers/words changed. It restores the exact v103 function and audited
seed columns, then drops only the v105 tables and registry row. Unrelated
assignments or legacy holding changes survive rollback. After any refusal,
retain the current schema and diagnose forward. A successful replay, status
lookup, denied operation, failed transaction and platform override do not
record first use.

The test rehearses identical catalogue and audited seed on application,
rollback and reapplication, then runs a prior Page-copy receipt through the
bridge and verifies a real committed native copy makes rollback refuse.
Exact previous-build evidence belongs in the frozen release packet.

# Sources provider host and connection generations v117

The migration adds a private-use bigint generation to each existing host and credential connection row. An actual change to host approval/profile or connection identity, state or encrypted credential fields increments the row's generation in the same write. Display text, error timestamps and a successful repeat Test with identical transport inputs leave it unchanged. No extra advisory or resource-row lock is taken by the capture triggers.

The v116 provider admission remains closed and empty. This stage supplies no new route, public permission or dispatcher. Team and pointer placement and bound-set history require a separate privacy and query-cost review. Existing API table grants on either target are a stop condition. A table-level grant automatically includes the new column. Use a separately reviewed private side table if such grants are needed for existing callers. Existing column-only grants are preserved.

## Rehearsal and apply

1. Rehearse on an isolated PostgreSQL 17 cluster using Node 20 or later. Run `backend/scripts/sources-provider-v117-rehearsal.sh` or `backend/scripts/sources-provider-v117-rehearsal.ps1`. Require `RESULT: PASS`. The test covers both legacy lock directions, named API and PUBLIC access, metadata-only DDL, legacy capture, apply, guarded rollback and reapply. It does not contact a provider.
2. Verify the exact deployed v116 predecessor independently, then run the read-only `sources-provider-v117-preflight.sql`. All booleans must be true. A failed ACL check needs a design decision before migration.
3. Apply the reviewed file through the standard migrator at a quiet moment. It takes `ACCESS EXCLUSIVE NOWAIT` locks on the two existing source tables and `SHARE NOWAIT` locks on the closed store, inside the migration transaction. Either lock conflict aborts without a partial schema change. Both counters use PostgreSQL's constant-default column path with no backfill, table rewrite or index build.
4. Run `sources-provider-v117-postcheck.sql`. Every integrity boolean must be true. The counts of nonzero generations are informational. An ordinary legacy write may already have advanced a counter.

## Rollback

Use `sources-provider-v117-rollback.sql` while the bridge is closed and unused. It refuses a running migrator, a later migration, altered guards or grants, and any captured generation. The script removes only the two added columns and functions/triggers and the exact migration row. After a captured generation use a forward correction and keep admission closed. A later dispatch release needs the complete generation/legacy lock inventory and separate producer-drain evidence.

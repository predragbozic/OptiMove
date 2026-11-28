# Sources provider v116 unopened store rehearsal

This local candidate adds private storage only. The database refuses every
admission or attempt write. The existing Sources provider and Import routes
continue using their deployed behavior. No Sources permission word, generation
writer, claim consumer or operator switch is installed by this migration.

1. Verify deployed v115 identity and migration SHA independently. Run
   `sources-provider-v116-preflight.sql`. All returned booleans must be true.
2. Rehearse on an isolated PostgreSQL 17 loopback cluster. Run
   `backend/scripts/sources-provider-v116-rehearsal.ps1` or
   `backend/scripts/sources-provider-v116-rehearsal.sh` using Node 20 or newer.
   Require `RESULT: PASS`. The script runs in a disposable database only.
3. Apply through the normal migrator only after separate release approval.
   Run `sources-provider-v116-postcheck.sql`. All returned booleans must be
   true. This includes the disabled singleton, empty attempt tables, exact
   active closure trigger, row security and API privileges.
4. Rollback uses `sources-provider-v116-rollback.sql`. It requires the exact
   migration checksum, no later migration, the exact active closure guards,
   and a closed empty store. It removes only the three v116 tables, their
   owned indexes and triggers, the v116 guard function and the v116 recorded
   migration. It preserves existing v115 permission and use evidence.

Later adoption must prove exact provider and SQL caller overlap before
replacing this closure. A configuration change alone cannot enable this
store.

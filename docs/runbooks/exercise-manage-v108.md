# Exercises Manage v108 bridge

This release stages Exercise Add and Remove in the existing R4 SQL evaluator and installs the native writer checks. It leaves the new words hidden in Settings and excludes media-provider permissions and ownership changes.

## Prerequisites

- Freeze after the Builder RPE Roles rollout. Pin the actual deployed predecessor and its v107 registry checksum. Exercise production approval and migration numbering are separate from this rehearsal.
- Rehearse on isolated PostgreSQL 17 and Node 20 or newer with one of the two exercise-manage-v108-rehearsal wrappers. PowerShell accepts a loopback DATABASE_URL or a hidden local password, and both wrappers print RESULT: PASS after their checks. Use the exact predecessor binary referenced in the rehearsal and retest if the live predecessor changes.
- Run exercise-manage-v108-preflight.sql read-only and confirm every check. Record the existing Exercise Use holds and custom overrides from the exact registry for reviewer comparison.
- After the migration, run exercise-manage-v108-postcheck.sql. Confirm the exact checksum, evaluator fingerprint, staged item audit and first-use status. Continue to hold the Settings words while older writers still run. The postcheck unused field may become false after a successful native write.
- Site-managed activation is a distinct change after old writers are fully drained. Keep Exercise Media Upload hidden and exercise ownership personal.

## Rollback

Drain the candidate writers and confirm Settings exposure has not happened. Run the paired rollback SQL only while the first-use marker has zero rows. The rollback refuses a later migration, altered evaluator, authored changes to the seeded permission layers or a real guarded write. It restores prior revision metadata, audit rows and evaluator body. Its named permission guards are temporarily disabled and re-enabled inside the same transaction. If rollback refuses, preserve the database and use a reviewed forward correction.

# Leaving athletes out of an import (migration v59, J20-B)

`docs/ai/j20-session-review-contract.md` section 5.1 and 9.1. Migration: `migrations_v2/202611091100_training_load_v59_import_approval_subset.sql`.
Files beside this runbook: `import-approval-subset-v59-preflight.sql`, `-postcheck.sql`, `-rollback.sql`.

## What it is

* An approval may record `excluded_athlete_ids` (GPEXE athlete ids, ids only, no names; at most 60) and `subset_hash`, the hash of the preview recomputed
  with that set. Every approval that exists before v59 reads as "nobody left out" (`'{}'`, no hash); nothing is rewritten.
* The approval's `preview_hash` is still the whole candidate's stored hash, so the v33 trigger still compares the candidate and the approval as before.
* The trigger cannot recompute a preview: that the set and the hash agree with a preview computed under the locks is `approveCandidate` step 12's job
  (tested). A raw writer that supplies a well-formed set and a well-formed wrong hash is outside that guarantee, like v35's guards.

## The one thing to know when running it

* The migration takes a short `ACCESS EXCLUSIVE` lock on `training_load.gpexe_import_approvals` for the two `ALTER TABLE`s. It refuses to run when the trigger
  function in force is not v33's (md5), and checks afterwards that the body changed.
* Run the preflight at a quiet moment (no approval in flight); run the post-check after the deploy.

## What a left-out athlete means afterwards

The candidate becomes `imported` as a whole. A later check of unchanged GPEXE content is `no_changes`: a left-out athlete is not importable until GPEXE's content for the
session changes. The roster reads such an athlete as needing a state (J20-C offers the states for them). The undo (U5) removes what was imported and offers the fresh candidate
as before; the recorded exclusion stays with the approval.

## Rollback

`import-approval-subset-v59-rollback.sql` restores v33's trigger body and drops the columns and CHECKs. It refuses (changing nothing) once any approval has a non-empty set or
a hash, under a later migration, when the body in force is not v59's, or while the migrator runs. After a subset approval exists, v59 is forward-only.

# Migration v63: estimated values (phase 5b, 6b-A)

`migrations_v2/202611121000_training_load_v63_metric_value_estimates.sql`. Contract: `docs/ai/phase5b-estimates-contract.md`.

## What it does

- `metric_measurement_occasions.entry_method` also takes `estimate`.
- A new table, `training_load.metric_value_estimates`: one provenance row per estimated value, holding the method, the basis
  (a closed shape per method), the author, the time and an optional note. It is append-only, except a DELETE inside the session
  undo's own transaction.
- **The guards (M1, M2).**
  - An estimate occasion is whole-session, with nothing of a source, and is written by the transaction's acting user
    (`optimove.estimate_actor`).
  - It holds one value, and that value is numeric, standalone, not derived and not_applicable.
  - It is refused while an effective measured whole-session value of the same variable exists for the same participant
    (`estimate_measured_exists`).
  - Its provenance row is required by COMMIT.
  - The method must be allowed by the variable's daily aggregation:
    - `sum`: every method;
    - `avg`: `copy_athlete` and `team_average`;
    - `max`, `last`, `none`: never.
- **M3.** A later whole-session value of the same variable for the same participant supersedes the estimate occasion. This holds
  for a measured, effective value and for another estimate.
- The dashboards' series `source_policy` takes `estimate` (6b-D shows estimates only under it).
- **The session undo** keeps v60's bodies, replaced under an md5 gate:
  - the scope counts `estimateOccasionCount` and `estimateValueCount`;
  - the undo deletes the provenance rows before the values and records `metric_value_estimates` in `removed_counts`;
  - estimates never block it.

Nothing writes an estimate until 6b-B, and its route stays behind `ESTIMATES_ENABLED` (off) until 6b-D is merged and deployed.

## Order

After v62 (#493): v63 refuses to run without v62's table. Merge #493 first.

## Before the deploy (the Rukovodilac)

1. The owner's order naming this migration file.
2. `metric-value-estimates-v63-preflight.sql`, block by block in read-only transactions: every `ok` must be true.
   - v62 is the last migration.
   - v60's undo bodies are in force (md5 `b6f34358…` and `3d78cc86…`).
   - There is exactly one `entry_method` CHECK and one `source_policy` CHECK.
   - It is a quiet moment.
3. Deploy; the migrator applies v63 at start-up.

## After the deploy

`metric-value-estimates-v63-postcheck.sql`, read-only, checks:
- v63 is recorded once and is the last migration;
- the undo bodies are v63's (md5 `4d33a337…` and `495c1406…`);
- the 8 triggers are enabled;
- both CHECKs carry `estimate`;
- no estimate exists;
- there is no idle transaction and no lock wait.

## Rollback

`metric-value-estimates-v63-rollback.sql`, one transaction. It restores v60's bodies and the original CHECKs, drops v63's
objects and removes the record. It refuses when:
- the migrator is running;
- v63 is not recorded, or a later migration is;
- an estimate occasion or provenance row exists;
- a series uses the `estimate` policy;
- the undo bodies are not v63's.

Rehearsed on disposable databases (`backend/tests/metric-value-estimates-v63.test.mjs`, test 9): apply, then rollback, then the
v62 catalog exactly, then re-apply. Run anywhere real only with the owner's approval for that database, after a fresh
restore-verified backup, on a commit that no longer contains the migration.

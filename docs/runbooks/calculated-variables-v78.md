# Calculated variables add up only amounts (migration v78)

Migration: `migrations_v2/202611181100_training_load_v78_calculated_variables_additive.sql`. Files beside this runbook:
`calculated-variables-v78-preflight.sql`, `-postcheck.sql`, `-rollback.sql`. Tests:
`backend/tests/calculated-variables-v78.test.mjs` (the migration and the database guards) and tests 7 and 16-19 of
`backend/tests/calculated-variables-v77.test.mjs` (the API). Contract: `docs/ai/gpexe-metric-variable-mapping-discovery.md`,
J21 ("PR 2a").

## What it is

* The owner's rule of 2026-11-18, "a sum adds only what can be added": two top speeds share a unit but are not an amount.
  The *Rukovodilac* decided (same day, decision A) that the database twins go into calculated variables PR 2a, in one ★★
  round with the API.
* v78 replaces one function body and adds one guard; no table, column, index or row:
  * `training_load.metric_calculation_version_guard` (v77's body, `CREATE OR REPLACE`, with an md5 precondition): a calculated
    version's day rule (`daily_aggregation_method`) is `sum`; each input's current version is combined by `sum`; an input of
    a calculated variable's current version keeps `sum` in a new version, as it already kept its unit;
  * `training_load.metric_calculation_state_guard` (`BEFORE UPDATE OF state ON metric_definitions`): an input of an active
    calculated variable's current version is not archived, and a calculated variable is restored only while every input of
    its current version is active.
* The API refuses the same cases first, with sentences naming the variable (`calculation_input_not_additive`,
  `calculated_day_rule_fixed`, `calculation_input_day_rule_in_use`, `calculation_input_archive_in_use`,
  `calculation_input_not_active`); the database answers any other writer, and the API maps its messages to the same codes.
* **Deployed alone, v78 changes nothing a reader sees**, and nothing a writer sees unless the write breaks one of the rules.

## Running it

* Preflight (read-only, each block in a read-only transaction): v77 recorded and v78 not; the version guard in force is v77's
  (md5 `a4d8225e2c3b70e618c58c18eb712dcc`); no state guard yet; the three violation counts 0; a quiet moment; the role owns
  `metric_definitions`. The migration refuses on its own when a count is not 0 or a body differs.
* It creates a trigger on `metric_definitions` (`SHARE ROW EXCLUSIVE`) with `lock_timeout` 5 s; a busy table fails it with
  nothing applied.
* Post-check: v78 recorded once and last (compare `checksum` with the file's sha256); the version guard's md5
  `eae4cc9d519a498ca7f4acf0bedbdcbd` and the state guard's `1954b245cfd2c147540c3daf3bb95a92`; the trigger enabled; the three
  counts 0; nothing waiting.
* Locks: an archive (the variable's row `FOR NO KEY UPDATE`) and a calculation being created over the same variable (the
  version guard's `FOR SHARE` of its inputs) wait for each other; the second is refused (test 3, both orders).

## Rollback

`calculated-variables-v78-rollback.sql` restores v77's body exactly (and its comment), drops the state guard and removes the
v78 record. It refuses while the migrator runs, when v78 is not the last migration, or when a body in force is not v78's. It
changes no row, so it is allowed at any time; afterwards the rules are the API's alone. Deploy a commit without the v78 file
first (the API's refusals may stay: they do not depend on v78).

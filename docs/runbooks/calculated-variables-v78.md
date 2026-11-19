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

* Preflight (read-only, each block in a read-only transaction): v77 recorded and v78 not (other tracks' migrations, the
  dashboard's v75 and the calendar's v81, may be recorded or not - v78 depends on v77 only); the version guard in force is v77's
  (md5 `a4d8225e2c3b70e618c58c18eb712dcc`); no state guard yet; the three violation counts 0; a quiet moment; the role owns
  `metric_definitions`. The migration refuses on its own when a count is not 0 or a body differs.
* It creates a trigger on `metric_definitions` (`SHARE ROW EXCLUSIVE`) with `lock_timeout` 5 s; a busy table fails it with
  nothing applied.
* Post-check: v78 recorded once (compare `checksum` with the file's sha256); the version guard's md5
  `eae4cc9d519a498ca7f4acf0bedbdcbd` and the state guard's `51fc201fb536a64e5803f413b9fbffdf`; the trigger enabled; the three
  counts 0; nothing waiting.
* Locks: an archive (the variable's row `FOR NO KEY UPDATE`) and a calculation being created over the same variable (the
  version guard's `FOR SHARE` of its inputs) wait for each other; the second is refused (test 3, both orders). So do an
  archive and a restore of a calculated variable over it (the state guard's `FOR SHARE` of the inputs in id order; test 4,
  both orders; the API locks the same way before its own check, v77 test 20).

## Rollback

`calculated-variables-v78-rollback.sql` restores v77's body exactly (and its comment), drops the state guard and removes the
v78 record. It refuses while the migrator runs, when v78 is not recorded, or when a body in force is not v78's or the trigger
is missing (a later Metrics Core migration that replaced one, such as v79, is rolled back first). It never looks at later
migrations by name, so another track's migration does not block it. It changes no row, so it is allowed at any time;
afterwards the rules are the API's alone. Note: v77's own rollback, as merged, refuses once any later migration is recorded;
from v78 on, this rollback is the path back. Deploy a commit without the v78 file first (the API's refusals may stay: they do
not depend on v78).

Known limit (the db-reviewer, LOW): the day-rule stickiness fires on a version INSERT; re-pointing an input's
`current_version_id` to an older non-sum version is not guarded. No route does that (every update sets the id of a version
just inserted); a route that ever does must refuse it too.

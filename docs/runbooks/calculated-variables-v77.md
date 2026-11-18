# Calculated variables, step 1 (migration v77)

Migration: `migrations_v2/202611181000_training_load_v77_calculated_variables.sql`. Files beside this runbook:
`calculated-variables-v77-preflight.sql`, `-postcheck.sql`, `-rollback.sql`. Tests:
`backend/tests/calculated-variables-v77.test.mjs`. Contract: `docs/ai/gpexe-metric-variable-mapping-discovery.md`, C141–C150
and J21.

## What it is

* The owner (2026-11-18), option B: a calculated variable is a Metrics Core variable whose value is OptiMove's sum of 2–10
  other variables, written once beside its inputs in the import's own transaction. The first one is HMLD = power zone
  distance 3 + 4 + 5.
* v77 adds `metric_definition_versions.calculation` (null, or `{"kind": "sum", "inputs": [definition ids]}`) and four guards:
  * on a version: a variable is calculated from its first version or never; a calculated version is numeric with no bounds or
    condition; its inputs are active, not calculated, numeric variables of the same owner (or system ones) with its unit and
    every level it has; an input keeps its unit while a calculation uses it;
  * on the levels: a calculated variable gets only a level all its inputs have, and an input keeps a level in use;
  * on a mapping version: a calculated variable is never a mapping target;
  * on a value: a value of a calculated variable is exactly the sum of one non-derived value per input on the same
    occasion, and names its formula version and those values; nothing else may write one.
* **Deployed alone, v77 changes nothing a reader or a writer sees:** no row is written, no body in force is replaced, and no
  variable is calculated until an administrator creates one. Nothing computes a value yet: the writer is the next pull request.

## The API (for the screens)

* `POST /api/training-load/sources/metrics/variables` and `POST …/variables/:id/versions` take an optional
  `calculation: { kind: "sum", inputs: [ids] }`. With one, `minValue`, `maxValue` and `condition` are not allowed.
* Refusals: `409 calculation_input_unavailable` (missing, archived, or not a variable of this workspace or an OptiMove one),
  `calculation_input_calculated`, `calculation_unit_mismatch`, `calculation_level_mismatch`, `calculation_kind_fixed`, and
  `variable_used_by_calculation` (a new version of an input that changes its unit).
* Reads: `currentVersion.calculation` and each version's `calculation` are null or `{ kind, inputs: [{ id, key, label }] }`;
  a team coach's reduced view says only `calculated`.
* A calculated variable is no mapping target (`canonical_calculated`), takes no column on the drag board, is never estimated,
  and is not copied into a club in step 1.

## The one thing to know when running it

* It takes `metric_definition_versions`' `ACCESS EXCLUSIVE` lock (the new column and CHECK; every existing row is null, so no
  rewrite) with `lock_timeout` 5 s; a busy table fails the migration with nothing applied. Run the preflight at a quiet
  moment; run the post-check after the deploy.
* The value guard reads one version row per value written; an import's values keep their single statement per result.

## Rollback

`calculated-variables-v77-rollback.sql` drops the four triggers, the six functions, the CHECK and the column and removes the v77
record. It refuses (changing nothing) while the migrator runs, when v77 is not the last migration, or once a calculated
variable or a calculated value exists: from the first calculated variable on, v77 is forward-only. Deploy the backend before
v77 first (its reads name the column).

# Calculated variables: a ratio and a difference (migration v79)

Migration: `migrations_v2/202611191200_training_load_v79_calculated_ratio_difference.sql`. Files beside this runbook:
`calculated-variables-v79-preflight.sql`, `-postcheck.sql`, `-rollback.sql`. Tests:
`backend/tests/calculated-variables-v79.test.mjs` (the migration, the database guards, the API and a real import) and tests
10-11 of `backend/tests/calculated-variables-2b-routes.test.mjs` (an athlete never sees one; a dashboard refuses a ratio).
Plan and dashboard contract: `docs/ai/calculated-variables-v79-plan.md` (accepted by the *Rukovodilac* with O1-O6).

## What it is

* The owner's intensities: metres per minute, HMLD per minute, HMLD as a percentage of total distance; and a difference
  (total distance minus HMLD). A sum still adds only amounts; a ratio is never totalled or averaged.
* v79 replaces four function bodies (each with an md5 precondition and an md5 check after) and widens two CHECKs; no table,
  column, index or row:
  * `metric_calculation_shape_ok`: also `{"kind":"ratio","inputs":[numerator, denominator],"scale":1|100}` and
    `{"kind":"difference","inputs":[a, b]}` (the role of an input is its place);
  * `metric_calculation_version_guard`: the day rule follows the kind (a ratio's is `ratio`, a sum's and a difference's
    `sum`; an ordinary variable never takes `ratio`); one level of nesting (a ratio or a difference uses ordinary variables or
    sums, never another ratio or difference; a sum adds ordinary variables only); units from the inputs (a difference has its
    inputs' unit; a ratio `<numerator unit>/<denominator unit>`, a percentage `%` over two inputs of one unit; no conversion
    inside a formula); a variable keeps its kind; a sum used by a ratio or a difference keeps its unit;
  * `metric_calculation_value_guard`: the value is exactly the sum; `a - b` with `a - b >= 0`; or
    `round(numerator * scale / denominator, 6)` with `denominator > 0` and `numerator >= 0`; the input values in the
    calculation's order; a ratio's or a difference's input may be a sum's own value;
  * `dashboard_widget_series_validate_aggregation_type_compat` (v16's): a series of a ratio combines only as `ratio`, `max`,
    `last` or `none`; `ratio` is only for a ratio;
  * CHECK `metric_definition_versions.daily_aggregation_method` and `dashboard_widget_series.analytical_aggregation` also take
    `ratio`.
* The writer (`backend/src/calculatedValues.js`) runs two passes per occasion when a ratio or a difference applies (sums first,
  so a ratio can divide a sum); a team with only sums still sends one statement per occasion. No value is written for a
  missing input, a zero denominator or a difference below zero.
* Until the dashboard stream builds the ratio rule (the plan's section 6), the application refuses a ratio on a dashboard
  (`409 ratio_not_available`, "Dashboards cannot show a ratio yet. Use the variables it divides for now."), the simple builder
  does not list it, a template clone leaves a hint naming one unresolved, and the query answers a ratio series under `sum`,
  `avg` or `ratio` as an error. A difference is an amount and works everywhere a sum does.
* **The definition answer** (`GET /api/training-load/metrics/definitions` and `/definitions/:id`, staff workspaces; the
  *Rukovodilac*'s ruling 1 for the dashboard stream): every row also carries `calculation` - `null` for a measured variable,
  otherwise `{ kind, scale (a ratio only), inputs: [{ definitionId, name, shortName, unit }] }` in the formula's order -
  and `allowedAggregations` (a ratio `["ratio","max","last","none"]`; any other number `["sum","avg","max","last","none"]`;
  text and yes/no `["last","none"]`). The row keeps its existing names (`current_version_id`, `daily_aggregation_method`,
  snake_case from the table; `ownerScope`, `hiddenInClub`, `calculated` as before). An input is named by the same
  visibility rule as the row; one the viewer may not read keeps its place with every field `null`.
* **The preview's `reason`**, when every input has a value and still none is written: `denominator_zero`,
  `denominator_negative`, `numerator_negative` (a ratio) or `below_zero` (a difference), from the same input values the
  writer used. Since every calculated entry now carries the key, a candidate previewed before the deploy whose preview
  holds a calculated entry answers `preview_changed` once at its first approval (*Review again* imports it). Before the
  deploy, read whether any pending candidate's preview holds one; with no calculated variable in use, none does.
* **Deployed alone, v79 changes nothing a reader or a writer sees**: no ratio or difference exists until the API creates one.

## Running it

* Preflight (read-only, each block in a read-only transaction): v78 recorded and v79 not; the four bodies in force (md5s in
  block 2); both CHECKs present and nothing of the new kinds stored; a quiet moment; the role owns both tables. Block 6 lists
  the active mapping versions that fill `duration`, so the unit a ratio divides by is read before anyone makes one (expected:
  `s` to `min`, the variable in `min`).
* It replaces four functions and alters two CHECKs (`ACCESS EXCLUSIVE` on `metric_definition_versions` and
  `dashboard_widget_series` for the validation scan) with `lock_timeout` 5 s; a busy table fails it with nothing applied.
* Post-check: v79 recorded once (compare `checksum` with the file's sha256); the four new md5s; both CHECKs take `ratio`; the
  three guard triggers enabled; no ratio or difference yet; nothing waiting.
* Locks: as v77/v78 (the variable's row `FOR NO KEY UPDATE`, its inputs `FOR SHARE` in id order; the series trigger's
  `FOR SHARE` of the series' variable). Nothing new.

## Rollback

`calculated-variables-v79-rollback.sql` restores the four bodies exactly (with their comments), narrows the two CHECKs back
and removes the v79 record. It refuses while the migrator runs, when v79 is not recorded, when a body in force is not v79's,
or once a ratio or a difference version, a `ratio` day rule or a `ratio` series exists (v78's guards and the narrowed CHECKs
could not hold them). It never looks at later migrations by name. It changes no row. Deploy a commit without the v79 file
first; the application's refusals may stay.

Known limits:
* Re-pointing a variable's `current_version_id` to an older version of another kind is not guarded (as v78's day-rule note);
  no route does that.
* A ratio's unit is made of the stored units: a club whose duration variable is stored in `s` gets `m/s`, written as `m/s`,
  never relabelled. The Divide screen (the next pull request) says the unit before Save.

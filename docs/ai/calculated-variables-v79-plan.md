# Calculated variables, step 4: ratio and difference (v79) — plan and dashboard contract

Status: **proposed, not built** (2026-11-19). It is written on the *Rukovodilac*'s order of the same day, given on the owner's
order „hajde onda radi na tome". Nothing here is in force until the *Rukovodilac* accepts it and the owner answers section
9. No code and no migration file exist yet. The migration needs the owner's own order naming it.

Verified against `caa6b4b5` (main), and against PR #623 (`2cdb58e1`, PR 3, open) for the screen.

- The parent record is J21 of `docs/ai/gpexe-metric-variable-mapping-discovery.md` (C141–C150).
- Section 6 is the **dashboard contract**. It is self-contained so it can be handed to the dashboard stream as it is.

## 0. What the owner asked for, and what is already decided

The owner wants intensities: HMLD per minute, metres per minute, and a percentage (HMLD as % of total distance). Sums must
add only what can be added.

Already decided (the *Rukovodilac* on the owner's behalf, told to the owner):

- **Materialized at import like a sum (option B):** a value is written once, beside its inputs, and never recomputed at read
  time.
- **No switch per team.**
- **Values that are not written:** a missing input gives no value. So do a negative difference and a division by zero.
- **Athletes never see calculated variables.** This is the PR 3 rule; it holds for every new kind.
- **No backfill in this step.** The audited "calculate for earlier sessions" action is a separate PR, with its own migration
  and the owner's order.
- **An incomplete occasion is left out of a ratio and counted** (section 6.4).

## 1. The shape of a calculation

### 1.1 Recommended

Every kind keeps the one key `inputs`, as v77's sum does. The role of each input is its place in the list:

```json
{ "kind": "sum",        "inputs": ["<id>", "<id>", "..."] }                    // v77, unchanged: 2-10 inputs
{ "kind": "ratio",      "inputs": ["<numerator>", "<denominator>"], "scale": 1 } // scale 1 or 100
{ "kind": "difference", "inputs": ["<minuend>", "<subtrahend>"] }
```

Why one list rather than named keys (`numerator` / `denominator` / `minuend` / `subtrahend`):

- v77's helpers (`metric_calculation_inputs`, the FOR SHARE locks in id order, v78's state guard) and the 2b writer already
  read `inputs`.
- `computed_by_ref.inputValueIds` already carries the values in the input order, which `calculatedValues.js` says "carries
  the roles of a later kind".
- With one list, nothing that reads inputs changes. Only the arithmetic and the shape CHECK grow.

The alternative is named keys (`{"kind":"ratio","numerator":…,"denominator":…,"scale":…}`). It reads better in a dump, but
every v77 and v78 function and the writer would need a second branch per kind. **Not recommended**: the screen and the API
name the roles anyway.

`scale` is `1` (a plain quotient: m/min) or `100` (a percentage). No other value, and the key is only on a ratio.

### 1.2 May an input itself be calculated?

HMLD is a sum of three zones, so HMLD per minute needs a ratio over a sum.

**Recommended: exactly one level.**
- An input of a ratio or a difference may be a measured variable or a **sum**.
- It is never a ratio or a difference.
- A sum's inputs stay measured only (v77, unchanged).

That covers every case the owner named (HMLD/min, HMLD % of total distance, m/min, total minus a zone). It still rules out
any cycle: the depth is at most 2 and a sum never takes a calculated input.

Alternatives:
- (a) No nesting at all: HMLD/min would need its own three-zone formula. **Not recommended.**
- (b) Any depth with a cycle check. **Not recommended:** a second-level ratio over a ratio is never additive, so it means
  nothing over a period.

**Write order inside one occasion.** The writer runs the kinds in two passes in the same transaction:
1. sums, from measured values;
2. ratios and differences, from measured values and the sums just written.

The writer's input read (`not iv.is_derived`) becomes "not derived, or a derived value of a sum's current version". It is
still one statement per pass.

**Database guard for it (v79):**
- *Version guard:* an input of a ratio or difference is either not calculated or a sum (its current version's `kind =
  'sum'`). An input of a sum is still never calculated.
- *Value guard:* an input value of a ratio or difference may be derived only if it is a value of a sum. It must also be on
  the same occasion, as today.
- *Locks:* the inputs are still locked FOR SHARE in id order. A sum used as an input keeps its kind, because v77's "calculated
  from version 1 or never" rule already holds that.

## 2. Units

### 2.1 Recommended

| Kind | Inputs | Result unit |
|---|---|---|
| difference | both inputs in the **same unit** | that unit (m − m = m). No conversion, and the result stays an amount. |
| ratio, scale 100 | both inputs in the **same unit**, after the conversion below | `%` |
| ratio, scale 1 | any two units | `<numerator unit>/<denominator unit>`, e.g. `m/min`, written by the server |

- **No conversion inside the formula.** A ratio divides the values as they are stored. Duration is stored in **min** (the
  mapping already converts GPEXE's `s` to `min`, J17), so `total_distance / duration` is already `m/min`. HMLD (m) / duration
  (min) is m/min, the unit coaches read.
- **Who names the unit:** the server derives it from the inputs (`m/min`, `%`). The admin cannot type it. The unit-token rule
  accepts `/` and `%`, but no space, so a unit like "per min" is not offered.

**When the stored units do not give the unit a coach reads**, e.g. a duration stored in `s`: recommended is to refuse it with
a sentence naming the input's unit. The fix is to map the input to the unit wanted; that is the mapping's job (a conversion
row of `unit_conversions` at import), not the formula's. This keeps the guard exact and the formula free of `unit_conversions`
rows.

**Alternative:** an optional `"convert": {"input": 1, "conversionId": "<unit_conversions id>"}` that scales one input
(scale/scale_divisor, `offset = 0` only) before dividing. It is closer to "m per min with duration in s". The cost:
- the value guard must apply the same conversion row, so a retired row would have to stay readable for every stored value;
- the formula's meaning would depend on a second table.

**Not recommended for v79. Owner question O3.**

### 2.2 What an input's unit change does

v77 already freezes an input's unit while a calculated variable's current version uses it. That holds unchanged for ratio
and difference.

## 3. Values in the database

### 3.1 Value guard

This follows v77's pattern: the guard recomputes the value from the input value ids.

- **difference:** `value = minuend − subtrahend`, exactly (numeric). A negative result is refused, and the writer never writes
  one (decided: no value). Zero is a value.
- **ratio:** `value = round(numerator × scale / denominator, 6)`. A denominator of 0 is refused, and the writer writes
  nothing (decided: no value). A numerator of 0 with a denominator above 0 is a value (0).
  - A negative numerator or denominator is refused. Inputs are amounts (v78) and amounts are not negative; a negative
    measured value is already refused by its own bounds when they exist.
  - Owner question O5 is only whether "no value" is right for a negative.
- **Rounding:** exactly 6 decimal places, half away from zero (PostgreSQL `round(numeric, 6)`). The writer and the guard use
  the same SQL expression, so they agree to the last digit, as the sum's exact arithmetic does today. Six places keep m/min
  to the micrometre and a percentage to 0.000001 %. The screen rounds again for display.
- **Alternatives:** store the unrounded quotient (numeric's own division scale, at least 16 significant digits), or 4
  places. Not recommended:
  - unrounded makes the guard depend on PostgreSQL's division scale rules;
  - 4 places loses precision for small percentages.

### 3.2 A ratio is never additive

- **v78's rule extends to it:** a ratio is never an input of a sum (v79: an input of a sum must be measured, and it already
  is). It is also never summed or averaged over time.
- **The day rule for a ratio is a new value, `ratio`.** `daily_aggregation_method` gains `'ratio'`, and a ratio version must
  carry it. Within one day, an athlete's ratio is Σ numerators / Σ denominators over that day's occasions that have the
  stored ratio (section 6.3), the same rule as for a period.
- **A difference stays an amount:** day rule `sum`, and every aggregation allowed. A difference of amounts adds up, because
  Σ(a − b) = Σa − Σb over the same occasions.
  - A difference may be an input of nothing in v79 (one level, section 1.2). That makes "a sum over a difference" impossible.
  - Allowing it later is a separate decision.

## 4. Aggregation over a period (the core of the contract)

- A ratio over a period, or over any group of occasions, is **Σ numerators / Σ denominators over the occasions that have a
  stored ratio value**, × scale, rounded to 6 places. It is **never the mean of the stored ratios.**
- **Stored per occasion:** the ratio, and through `computed_by_ref.inputValueIds` the exact numerator and denominator values
  it was made of.
- **Computed at query time:** the period's sums of those two input values, the quotient and the counts. The query reads the
  input values through `computed_by_ref`, never "the latest input value of that day". So an occasion counts in the period
  only if it had a ratio, which means both inputs and a denominator above 0.
- **Aggregations allowed on a ratio series:**
  - `ratio` — new, the default;
  - `max` — the highest stored per-occasion ratio;
  - `last` — the latest occasion's stored ratio.
- **Refused:** `sum` and `avg`, with code `aggregation_not_allowed` and the sentence "This metric cannot be totalled or
  averaged. Choose Ratio, Highest or Latest."
- `none` follows its current meaning: no aggregation, one row per occasion. Each row then carries its own numerator and
  denominator.

## 5. Team and group level

**Recommended: pooled.** A team's (or any group's) ratio for a day or a period is **Σ over the athletes' occasions of the
numerators / Σ of the denominators**. It is one quotient over all included occasions of all included athletes.

- This is the team's real metres per minute.
- It equals the per-athlete ratio when there is one athlete.
- It never lets a 5-minute athlete count as much as a 90-minute one.

**Not offered:** the mean of the athletes' ratios. If it is ever wanted, it is a separate, named aggregation, never a silent
alternative.

## 6. The dashboard contract (self-contained)

> This section is written to be handed to the dashboard stream as it is. It assumes nothing outside it.

### 6.1 What a ratio variable is

A Metrics Core variable whose current version has `calculation.kind = "ratio"`.

- Its stored per-occasion values are **already computed by OptiMove** at import: `is_derived = true`, `aggregation_role =
  'derived_rollup'`.
- Each value names its formula version and its two input values in `computed_by_ref`:
  `{"formulaVersionId": "<version id>", "inputValueIds": ["<numerator value id>", "<denominator value id>"]}`.
- `calculation.scale` is `1` or `100`.
- The unit is the version's unit (e.g. `m/min`, `%`).
- Its day rule (`daily_aggregation_method`) is `ratio`.

A **difference** (`kind = "difference"`) is an ordinary amount for the dashboard: day rule `sum`, every aggregation as for a
measured amount. Only the ratio needs this contract.

### 6.1a What the definition answer says (built in v79 PR 1)

`GET /api/training-load/metrics/definitions` (also with `purpose=dashboardSeries`) and `GET /api/training-load/metrics/definitions/:id`
answer, in a staff workspace, rows in the existing shape: the table's own columns in snake_case, among them
`current_version_id` and `daily_aggregation_method`, and the computed fields `ownerScope`, `hiddenInClub` and `calculated`
as before. **What PR 3 carries today** for a calculated variable is only `calculated: true` (the list). **PR 1 adds, on
every row** (list and GET):

```json
{
  "id": "…", "label": "Metres per minute", "unit": "m/min", "value_type": "numeric",
  "current_version_id": "…", "daily_aggregation_method": "ratio", "calculated": true,
  "calculation": {
    "kind": "ratio", "scale": 1,
    "inputs": [
      { "definitionId": "…", "name": "Total distance", "shortName": "TD", "unit": "m" },
      { "definitionId": "…", "name": "Duration", "shortName": null, "unit": "min" }
    ]
  },
  "allowedAggregations": ["ratio", "max", "last", "none"]
}
```

- `calculation` is `null` for a measured variable. `kind` is `sum`, `ratio` or `difference`; `scale` (1 or 100) is present
  only for a ratio. `inputs` are in the formula's order: a ratio's numerator first, a difference's minuend first.
- `allowedAggregations`: a ratio `["ratio", "max", "last", "none"]`; any other number (a sum and a difference are amounts)
  `["sum", "avg", "max", "last", "none"]`; text and yes/no `["last", "none"]` (the database's own rule, v16 and v79).
- **An input the viewer may not read.** It is judged by the same visibility rule as the row itself. It keeps its place,
  because the place is its role, and every field is `null`: `{ "definitionId": null, "name": null, "shortName": null,
  "unit": null }`. No id, name or unit of something the viewer cannot see. Through the routes this does not happen today:
  an input is the calculation's owner's or OptiMove's, which is visible wherever the calculated variable is. A screen shows
  "an input you cannot see" and never charts the variable from such an answer.
- An athlete's workspace never receives a calculated row (6.2).

### 6.2 Who sees it

Staff workspaces only (platform, private coach, club, team). An athlete's workspace never lists, reads or charts a calculated
variable; PR 3 already enforces this, and an athlete's board refuses the series with the same 404 as a missing id. Every
count below respects the viewer's access: only occasions of activities the viewer may see, of athletes in the series' scope.

### 6.3 The rule

For a bucket (a day, a week, a session, a component, an athlete, a cohort — the widget's `group_by`) and a period:

```
included   = the occasions in the bucket that have a stored value of the ratio variable
value      = round( Σ numerator(included) × scale / Σ denominator(included), 6 )
             numerator / denominator = the input values named by each stored value's computed_by_ref.inputValueIds[0] / [1]
```

- **It is never the mean of stored ratios.**
- **A stored 0 counts as a value** (included, numerator 0).
- **Pooled across athletes:** an `athlete` bucket is one athlete. A `cohort` or `day` bucket pools every athlete in scope.
  The mean of the athletes' ratios is not offered.
- **`max`** is the highest stored ratio among the included occasions. **`last`** is the stored ratio of the latest included
  occasion (by its start, ties by occasion id).

### 6.4 Left out, and counted

An occasion in the bucket is **left out** when it has **no stored ratio** and the athlete has **a current value of at
least one input of the variable's current version** there, at that level. An occasion with no stored ratio has no
`formulaVersionId` of its own, so the current version decides. That happens when the other input is missing, the
denominator is 0 or below, the numerator is below 0, or the session was imported before the variable existed (no
backfill). "A current value" is the value the writer would use: the input's own current value on that occasion, in the
input's current unit; for a sum input, the sum's own stored value.

An occasion with no value of any current input is not counted at all: nothing was measured.

**Where this rule is not exact:** after a calculation's inputs change, an older occasion that has a value only of a
*former* input, and no stored ratio, counts as "nothing measured", not as left out. The period of such an occasion
usually also holds stored ratios under the former calculation, and with any stored ratio of the current one it answers
`calculation_changed_in_period` (6.5) anyway. Only a period that holds stored ratios of the former calculation alone
shows a count of left-out occasions that may be too low.

### 6.5 The calculation changed inside the period

If the included occasions' values name **more than one distinct calculation**, the series is not computed and answers
`calculation_changed_in_period`. Distinct means different inputs or a different scale between their formula versions. A new
version with the same calculation (e.g. a renamed variable) does not count as a change.

### 6.6 Request

No new field. A series is configured as today, with `analyticalAggregation` one of `ratio`, `max`, `last`, `none`:

```json
POST /api/training-load/dashboards/:dashboardId/widgets/:widgetId/series
{ "expectedWidgetRevision": 3, "seriesOrder": 0, "metricDefinitionId": "<ratio id>",
  "dataScopeLevel": "session", "analyticalAggregation": "ratio",
  "aggregationRolePolicy": "all_including_derived" }
```

- A series of a ratio variable with `analyticalAggregation` `sum` or `avg` is refused when it is saved: `409
  aggregation_not_allowed`, nothing written.
- v79 widens `dashboard_widget_series.analytical_aggregation` to accept `ratio` (not
  `dashboard_builtin_series.default_analytical_aggregation`: no built-in series is a ratio). A non-ratio variable refuses
  `ratio` with the same code and the sentence "Ratio is only for a calculated ratio. Choose another way to combine values."
- A ratio series reads only derived values. Its `aggregationRolePolicy` must admit derived values (`all_including_derived`);
  another policy is refused as `aggregation_not_allowed` with the same sentence as `sum`/`avg`.

### 6.7 Answer

The same envelope as today. A ratio series' rows carry four extra fields:

```json
POST /api/training-load/dashboards/:dashboardId/query   { "dateFrom": "2026-11-01", "dateTo": "2026-11-14" }
{
  "dashboardRevision": 7,
  "widgets": [{
    "widgetId": "…",
    "presentation_config": { … },
    "series": [{
      "widgetId": "…",
      "seriesId": "…",
      "status": "ok",
      "calculation": { "kind": "ratio", "scale": 1, "unit": "m/min" },
      "data": {
        "current": [
          { "bucketKey": "2026-11-03", "athleteId": null, "unit": "m/min", "value": 21.412500,
            "numerator": 1713.0, "denominator": 80.0, "includedOccasions": 1, "leftOutOccasions": 0 },
          { "bucketKey": "2026-11-05", "athleteId": null, "unit": "m/min", "value": 19.875000,
            "numerator": 3180.0, "denominator": 160.0, "includedOccasions": 2, "leftOutOccasions": 2 }
        ],
        "comparison": []
      },
      "coverage": { "includedOccasions": 3, "leftOutOccasions": 5 }
    }]
  }]
}
```

- **`numerator` / `denominator`:** the bucket's two sums in the inputs' own units. They are present for `ratio` and `none`,
  and `null` for `max` / `last`.
- **`includedOccasions` / `leftOutOccasions`:** per bucket, and for the whole series in `coverage`. The screen writes
  "2 sessions without a value" from `leftOutOccasions` (session level), or "2 drills without a value" at component level.
- **`coverage` is computed independently of the rows.** `coverage.includedOccasions` and `coverage.leftOutOccasions` count
  every occasion of the series' scope and period, including occasions in buckets that are omitted because they have no
  included occasion. So `coverage` can be larger than the sum of the rows. Example, daily buckets: 03.11 has 1 included
  and 0 left out; 05.11 has 2 included and 2 left out; 07.11 has 0 included and 3 left out, so it is omitted. The rows
  sum to 3 included and 2 left out; `coverage` is `{ "includedOccasions": 3, "leftOutOccasions": 5 }`.
- **No included occasion in a bucket:** the bucket is omitted, as an empty bucket is today. If the whole series has none, it
  answers `status: "ok"` with `current: []` and `coverage.includedOccasions: 0`. The screen writes "No sessions with a value."
- **`calculation`:** present only on a calculated series. For a sum or a difference it is `{ "kind": "sum" | "difference",
  "unit": "…" }` with no `scale`, and their rows carry no extra fields.

### 6.8 Errors (per series; the widget's other series still answer)

| `status` / code | When | Sentence the screen shows |
|---|---|---|
| `aggregation_not_allowed` (409 on save; `status: "error"` on read if stored earlier) | `sum`/`avg`, or a policy without derived values, on a ratio; `ratio` on a non-ratio | "This metric cannot be totalled or averaged. Choose Ratio, Highest or Latest." / "Ratio is only for a calculated ratio. Choose another way to combine values." |
| `calculation_changed_in_period` (`status: "error"`) | 6.5 | "The calculation changed during this period. Choose a shorter period." |
| empty (`status: "ok"`, `coverage.includedOccasions: 0`) | no stored ratio in the period | "No sessions with a value." |

The shapes are today's. On read, the failed series is one entry of its widget's `series`, and the other series answer as
usual:

```json
{ "dashboardRevision": 7, "widgets": [{ "widgetId": "w1", "presentation_config": { … }, "series": [
  { "widgetId": "w1", "seriesId": "s1", "status": "error", "error": "calculation_changed_in_period" },
  { "widgetId": "w1", "seriesId": "s2", "status": "ok", "data": { "current": [ … ], "comparison": [] } }
] }] }
```

On save, `HTTP 409` with today's body, nothing written:

```json
{ "error": "aggregation_not_allowed", "message": "This metric cannot be totalled or averaged. Choose Ratio, Highest or Latest." }
```

**Until the dashboard stream ships this section**, v79 PR 1 refuses every series of a ratio on save with
`409 { "error": "ratio_not_available", "message": "Dashboards cannot show a ratio yet. Use the variables it divides for now." }`,
the simple builder does not list one, and a read of such a series answers `{ "status": "error", "error": "seriesQueryFailed" }`.
The stream's pull request removes that refusal and keeps the database's (v79 refuses `sum`/`avg` on a ratio and `ratio` on
anything else).

A series of a calculated variable also keeps PR 3's note on the widget: "<name>: Calculated for sessions imported after this
variable was made. A session imported earlier gets it only if it is corrected or imported again with changed data."

### 6.9 What the dashboard must not do

- Average or add stored ratios.
- Recompute a ratio from "the input's value that day" instead of the stored `inputValueIds`.
- Count an occasion without a stored ratio as 0.
- Show a calculated variable in an athlete's workspace.

## 7. Migration v79, the code and the PR split

### 7.1 v79 (★★, the owner's order naming it)

- `metric_calculation_shape_ok` accepts `ratio` (exactly 2 distinct inputs, `scale` 1 or 100) and `difference` (exactly 2
  distinct inputs, no `scale`). `sum` is unchanged.
- **Version guard** (md5 precondition on v78's body):
  - a ratio's day rule is `ratio`;
  - a difference's day rule is `sum`;
  - the unit rule of section 2.1: difference equal units; ratio % equal units; ratio scale 1 unit = `<num>/<den>`;
  - nesting is one level (section 1.2);
  - inputs are locked as today.
- **v78's state guard:** unchanged. It already reads `metric_calculation_inputs`.
- `daily_aggregation_method`, `analytical_aggregation` and `default_analytical_aggregation` CHECKs widen by `'ratio'`.
  Fail-closed: no row changes, and the widening refuses nothing stored.
- **Value guard:**
  - `difference`: exact, ≥ 0;
  - `ratio`: `round(n × scale / d, 6)` with d > 0, n ≥ 0;
  - an input value may be derived only if it is a sum's value;
  - same occasion, `computed_by_ref` as today.
- **The rollback refuses:**
  - once a ratio or difference version, or any value of one, exists;
  - once a series or catalog row uses `'ratio'`;
  - under a later migration;
  - if a body in force is not v79's.
- **Preflight:** v78 is the last migration of this family, the md5 of the bodies, 0 rows that the widened CHECKs would need,
  a quiet moment. **Post-check:** the bodies, the CHECKs and 0 rows.
- **Locks:** as v78. Only CREATE OR REPLACE of functions and the ALTER of three CHECKs (`lock_timeout` 5 s; the series table
  takes a short ACCESS EXCLUSIVE). The dashboard tables are touched only for their CHECK.

### 7.2 Code

- **`calculatedValues.js`:**
  - `KINDS` gains `ratio: "round((select value_numeric from inputs where ord = 1) * <scale> / nullif(…ord = 2…, 0), 6)"`
    and `difference`;
  - two passes per occasion (section 1.2);
  - "complete" also requires `denominator > 0` and `difference ≥ 0`, otherwise no value.
  - The preview and the estimates reuse it as for sums.
- **The admin API** (`canonicalVariableAdminService.js`):
  - accepts the two kinds;
  - derives the unit and the day rule;
  - refuses with the sentences of section 8.
- **The dashboard** (`trainingLoadDashboardQuery.js` and the series write): sections 6.3–6.8. The dashboard stream builds
  this against the contract.
- **The screen (PR 3's form):** "What fills it > Calculated by OptiMove" offers **Add up** / **Divide** / **Subtract**.
  - Divide shows "Divide [variable] by [variable]" with "As a percentage" (scale 100), and the derived unit as text ("m/min").
  - Subtract shows "[variable] minus [variable]".
  - Inputs are chosen by name, as for Add up. The list offers measured and Add up variables of a fitting unit, with the reason
    for the rest.

### 7.3 PR split

1. **v79 + API + writer (★★, backend):**
   - the migration with its runbook, preflight, post-check and rollback;
   - the shape, the guards, the writer's two passes, the API;
   - tests: guards with mutations, writer and preview, import / undo / re-import, the athlete exclusion for the new kinds.
   - **Needs the owner's migration order.**
2. **The screen (frontend):** Divide / Subtract in the form; the detail's "divides X by Y" / "X minus Y"; the sentences.
3. **The dashboard (the dashboard stream, against section 6):** the `ratio` aggregation, the counts, the two errors, the
   empty sentence; its own reviews. It needs PR 1 deployed, for the CHECK and the values.
4. **The audited backfill action** (already planned in J21, separate): it gains the two kinds for free through
   `writeCalculatedValues`.

## 8. Sentences (new, for PR 1 and the screen)

- "Divide" / "Subtract" / "Add up".
- "Divide [A] by [B]. Both are measured or added up; a ratio is never divided again."
- "As a percentage: A is shown as a share of B (both in the same unit)."
- Refusals:
  - "Both variables of a percentage must have the same unit."
  - "Both variables of a difference must have the same unit."
  - "A ratio or a difference cannot use another ratio or difference."
  - "A ratio has no day total: OptiMove divides the day's sums."
- Value rules shown below the form:
  - "If B is 0 or missing in a session, this variable has no value there."
  - "If A minus B is below 0 in a session, this variable has no value there."

## 9. Open questions for the owner (each answerable in one word)

1. **O1:** May a ratio divide a sum, e.g. HMLD per minute where HMLD adds up three zones? (recommended: **yes**, one level)
2. **O2:** A team's metres per minute: the whole team's metres divided by the whole team's minutes? (recommended: **yes**;
   the alternative, the mean of the players' figures, is not offered)
3. **O3:** Should a formula convert units itself, e.g. seconds to minutes? (recommended: **no**; the unit is set where the
   value comes in)
4. **O4:** Keep 6 decimal places for a stored ratio? (recommended: **yes**)
5. **O5:** A difference below zero (more in the zone than in total): show no value? (recommended: **yes**, already decided;
   confirm)
6. **O6:** May a difference later be added up into a sum? (recommended: **later**, not in v79)

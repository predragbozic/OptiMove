# Dashboard display model and configuration contract

This contract covers the existing Training Load dashboard renderer. It does not add a
charting library, change a query, persist a configuration or introduce a frontend
calculation. The backend remains authoritative for values, aggregation and conflicts.

## Entry points

- `normalizeDashboardDisplayConfig(widget)` in
  `frontend/training-load-analysis-display-config.js`.
- `buildDashboardWidgetDisplayModel(widget, queryResult, options)` in
  `frontend/training-load-analysis-display-model.js`.

`queryResult` is ONE widget's existing `{widgetId, series}` batch-response entry, not
the whole dashboard response. `options` accepts `loading`, `error`, and `period`
(`{dateFrom, dateTo}`). Explicit loading supersedes cached values. A completed query
with a missing/malformed entry is an error, not an empty measurement.

These functions have no state, DOM, fetch or mutation dependencies. They do not change
the saved widget or API response. Returned definitions, raw rows, source context and
period are detached copies; changing the output cannot change the input.

## Configuration versions

Normalization returns `{status, sourceVersion, effective, issues}`. Each issue has a
stable `code` and `path`. Status is `ready`, `invalid`, or `unsupported`.

- Absent/null legacy configuration and `{schemaVersion: 1}` are supported. V1 extra
  fields remain untouched in storage and have no newly invented meaning. The effective
  runtime configuration uses the defaults below. Reading never upgrades or writes V1.
- V2 permits ONLY the following optional sections and fields. Omitted sections/fields
  use defaults; malformed values and unknown fields are invalid.
- An unknown positive integer version is explicitly unsupported. The renderer does
  not silently render it as V1/V2 or save a downgraded copy.
- Invalid version types, non-object configurations and unsupported widget types are
  reported explicitly.

```json
{
  "schemaVersion": 2,
  "numberFormat": { "maximumFractionDigits": 1 },
  "legend": { "visible": true },
  "valueLabels": { "visible": false }
}
```

`maximumFractionDigits` is an integer from 0 through 6; the two `visible` fields are
booleans. No callbacks, HTML, arbitrary ECharts options, new aggregation names or
source policies are accepted in V2. The legacy renderer uses number formatting;
legend/value-label settings are declarative metadata for a future chart adapter.
Its existing labeled rows and numeric equivalents remain visible in this phase.

The server's existing schemaVersion check is unchanged. This is a read-side frontend
contract, not a claim that the API already enforces the complete V2 schema. No new
configuration editor or V2 write path is introduced here.

## Normalized result

The model contains `widgetId`, `widgetType`, `title`, `groupBy`, `period`, `config`,
`status`, `reasons`, `series`, and (for KPI) `kpi`. Widget-level status is `ready`,
`loading`, `error`, or `unsupported`.

Each series retains a detached `definition`, its `id`, status/reasons, `current` and
`comparison` rows, `comparisonRange`, and current/comparison chart groups. Unresolved
and ambiguous series remain explicit and do not need an executable query result.
Duplicate configured/result series IDs and malformed/foreign widget entries are not
resolved by taking the first match.

Each row contains:

- `identity`: series, metric/built-in reference, athlete, bucket, actual returned unit,
  grouping and source context;
- `status`, `reasons`, `valueType`, `value`, `rawValue`, `rawCount`, and `rowIndex`;
- `raw`: the complete detached server row, including additional provenance and
  conflict candidates which are not necessarily present in the public row identity;
- `chartStatus`: eligibility for a single numeric chart point.

Source context distinguishes configured `policy`/`configuredConnectionId` from the
source fields actually reported on a row. Known camel/snake-case source identifiers,
entry method, source metric/mapping identifiers and nested provenance are retained.
No actual source is inferred from a configured policy. If the server omitted an
individual fact's source, the display layer cannot reconstruct it.

## Values and grouping

| Input | Row outcome |
|---|---|
| Finite number, including zero/negative | `value`; no coercion |
| String or boolean, including empty text/false | `value`; table/KPI retain its type |
| Array of scalar values/nulls | `value`, type `array`; retain it for a table |
| Explicit null without a problem flag | `missing` |
| Source/unit/type/semantic conflict | `conflict`; keep all reasons/raw values |
| Row error, missing value field, malformed identity/value/flag | `error` |
| Non-finite numeric or object value | `error` |

`value` is null for missing/conflicted/error rows; `rawValue` retains what the server
actually returned. A problem flag takes precedence over a number. Error messages
shown by the renderer are fixed labels, not arbitrary backend error detail.

Rows are partitioned for charts by series, metric, athlete, unit, grouping and available
source context. Every row remains present and its server value is unchanged. A group
is a display partition, not an aggregation. Duplicate or missing bucket keys are
marked in `chartStatus` and never reduced to one point; tables retain all rows. Text,
booleans and arrays are not coerced to numeric chart points.

The legacy bar/line renderer still uses its existing magnitude scaling to allocate
pixels. This is visual scaling, not a new metric aggregation. Zero has a zero-width
mark and a visible numeric label; missing/conflicted/error/unsupported values have no
numeric mark. Labels keep series, available athlete/source context and units visible.

## KPI and comparison

- No configured series: keep the existing add-series empty state.
- More than one configured KPI series: error.
- No current rows: `empty`; one null row: `missing`.
- Exactly one scalar current row: show its value or its problem state.
- More than one row: `multipleGroups`, no selected row or numeric headline. The user
  must narrow the query or use a table. This also applies to duplicate groups and to
  one valid row accompanied by another group's error/conflict.
- One raw array: `unsupported`; use a table.

Comparison has its own `none`, `value`, `incompatible`, or `error` state. Both current
and comparison must have exactly one scalar, valid value of the same type, matching
athlete and unit, and matching available source context. An explicitly supplied
athlete identity (including cohort's explicit null) is required in both rows.

For cohort/athlete/session/component grouping, bucket keys must match. For day/week
grouping, valid dates must fall within the supplied current period and server-returned
comparison range at matching relative calendar positions. Without sufficient context
the comparison is unavailable. Calendar-position checks only align rows; they never
calculate metric values. Distinct session/component IDs are conservatively incompatible.

No frontend delta, percentage, unit conversion, sum, mean or formula is introduced.
The raw comparison rows remain available even when they cannot safely form a KPI.

## Compatibility and limits

- Existing four widget keys, API shapes, mutations, revisions, filters, layout,
  configuration objects and database schema remain unchanged.
- Existing single-group KPI/table/numeric charts render without a migration or save.
- Intentional corrections: multi-group KPI is no longer the first row; problematic
  values no longer appear as reliable numbers; null/arrays/text do not become zero
  or coerced numeric bars; unsupported configuration is visible.
- This is not a full line/bar chart redesign. ECharts/GridStack and new statistics,
  configuration controls, source resolution, data fetching and persistence are out
  of scope. V2 validation at write time remains future backend work.

## Executable evidence

- `frontend/tests/training-load-analysis-display-model.test.mjs`: configuration,
  cardinality, identity, malformed responses, immutable inputs and comparisons.
- `frontend/tests/training-load-analysis-display-view.test.mjs`: all four legacy widget
  renderers, no network/write during render, zero/null/conflicts/arrays, configuration
  states, escaping and comparisons.
- Existing dashboard action/editor/UX suites continue to cover persistence and
  navigation. Their real results are recorded in the PR, not assumed by this document.

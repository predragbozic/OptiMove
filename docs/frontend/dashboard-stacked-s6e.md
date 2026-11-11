# S6e: Stacked bar

Stacked bar is the tenth chart-gallery choice for Dashboard Pages. It requires Advanced mode and two to eight distinct resolved numeric catalog metrics with the same nonempty unit, day/week grouping, and primary axes. Each series uses sum, standalone_only, and complete_only with matching scope, source policy, and connection. Comparisons and fixed Y bounds are unsupported.

## Author declaration

Matching units do not establish additivity. An initially unchecked acknowledgement declares that these are non-overlapping components of one quantity, excluding a total together with its parts. The declaration is user supplied, not inferred or catalog verified. Changing metrics, units, or relevant policies invalidates the acknowledgement. Pending setup cannot be saved. Existing series policies are preserved rather than silently converted.

The presentation uses chartVariant=stacked, chartComposition=components-v1, and stackDefinition with schemaVersion=1, semantics=non-overlapping-additive, unit, and the distinct metric-definition IDs. The existing bar_chart storage type is retained. Simple compilation requires Advanced mode. Future opaque presentation versions remain untouched.

## Query and display

The Page query attaches a server-built metricStack proof. The browser validates its query, widget, period, definition, bindings, raw-row locators, units, source, values, and total before rendering. It does not infer joins. Source rows remain available in the table.

Missing, duplicate, conflicting, negative, or nonfinite component data blanks the entire athlete/bucket across all components. Zero remains valid. Limits are eight components, twenty athletes, and eight thousand buckets. Athletes with only omitted buckets remain visible when other athletes have valid data. Each athlete gets a plot with metric colors. Valid configured hex colors are honored; other values use the stable palette.

Local date zoom and reset are supported. Hiding a legend component explicitly warns that visible heights are partial. Tooltip totals are labeled Original total (all components).

Existing staged Advanced save and revision/idempotency behavior is retained; this change does not introduce an atomic transaction for the whole editor. Same-workspace page duplication remaps series/widget IDs and obtains fresh proof. A changed declared metric set requires reconfirmation.

## Database capability

Migration v64 replaces the presentation validator and compatibility function without changing their OIDs or rewriting saved rows. The new marker enables stackedCharts only for authorized Page ports with query/manage access. Before v64, crafted stacked preview requests are refused. No production migration was run.

## Verification

- Targeted frontend union: 502/502 pass; targeted backend union: 235/235 pass.
- Production build passes with the existing chunk-size warning. A final color-only follow-up passes 5/5 composer tests.
- Isolated PostgreSQL/real HTTP rehearsal passes: pre-migration gating, v64 capability and OID preservation, save/replay/query with 42 + 58 = 100, page duplication with fresh proof, SQL rejection cases and whole-bucket omission for a missing third component. Synthetic rows only; database/server/port/cluster cleanup confirmed.
- Browser checks use actual ECharts and editor rendering with synthetic fixtures: desktop, narrow viewport without horizontal overflow, zero values, gaps, original totals, legend warning/reset, and initially unchecked acknowledgement with Save disabled. Browser and PostgreSQL checks are separate, not one full end-to-end session.
- Independent read-only review found a malformed generated migration, corrected before the successful PostgreSQL run, and obsolete gallery-count expectations, also corrected. No confirmed P1/P2 remained in that bounded review. Reviewer did not independently run PostgreSQL or browser checks.

These are targeted results, not a claim that the historical full-suite frontend failures/timeouts or backend Builder baseline failure are resolved. The local backup/rehearsal helpers and evidence are excluded from the PR.

Reference: [Apache ECharts stacked bar guide](https://echarts.apache.org/handbook/en/how-to/chart-types/bar/stacked-bar/).

Next: Box plot; thresholds and references follow the agreed gallery work. No merge or deploy is included.

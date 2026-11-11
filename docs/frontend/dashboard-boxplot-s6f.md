# S6f: Box plot

The eleventh gallery choice displays one numeric metric across returned athlete-level aggregates for each day or week. The existing aggregation remains explicit in the caption. These observations are not individual sessions and rawCount does not weight the distribution. Original values remain in the table.

## Statistical and data rules

At least five distinct valid athletes are required for a bucket. Quartiles use linear interpolation at (n-1)p (type 7). Whiskers are the observed values inside Q1 - 1.5 IQR and Q3 + 1.5 IQR; outside observations remain individually selectable scatter points. These are descriptive statistical markers, not clinical thresholds, reference attainment, or significance tests.

Missing, conflict, error, unsupported and duplicate athlete/bucket rows are excluded. The sample count and exclusions among athletes present anywhere in the returned period are shown in summary details; this is not a claim about the entire roster. Fewer than five values or nonfinite arithmetic leaves a gap. Zero, negative and equal values are valid. Entirely missing athletes cannot be counted from the result alone.

Mixed units or source identities refuse the display instead of merging observations. Whole-group rows are unsupported. Limits: twenty returned athletes, eight thousand rows, day/week grouping within the existing date-period limit. One primary series, no comparison, automatic value axis only. The storage type remains bar_chart with chartVariant=boxplot and chartComposition=distribution-v1. No joins, percentile query, or synthetic session observations are inferred.

Derived summary details contain every contributing original row/index and the query identity. Outlier details retain exact original row identity. Local zoom, reset and legend controls follow existing chart behavior. Missing boxes use null five-value tuples because the bundled ECharts boxplot rejects null data items; a real bundled-renderer test verifies invalid missing buckets remain gaps.

## Persistence and capability

Page-only Simple capability is marker-gated by dashboard_boxplot_v1. v65 preserves existing presentation function OIDs via CREATE OR REPLACE; it does not rewrite saved rows. Known v1 sidecars require paired distribution composition and automatic axes; future opaque versions remain preserved.

Deferred constraints validate the final single-series shape, numeric binding, primary axis and absence of comparisons. Existing unresolved/ambiguous portable clone bindings remain allowed through the existing series validator; they cannot render until repaired. Advanced requests flush these two constraints before COMMIT so deterministic shape rejection returns invalidRequest rather than uncertain-outcome recovery. Older databases skip this flush through function discovery.

Advanced editing keeps existing staged/revision/idempotency behavior. Before series writes on a known Box plot, its sidecar is cleared; the intended final presentation is restored last. This permits DELETE/ADD metric replacement and explicit conversion to Separate plots. Title-only edits preserve the sidecar. A partial failed staged save is not an atomic whole-editor save.

## Validation

- Targeted frontend union: 521/521 PASS, including statistics, exclusion/provenance, real bundled ECharts SVG gaps, keyboard/click details, gallery capability, saved editor and simulated commit invariants.
- Targeted backend union: 241/241 PASS, including schema/compiler, capability/auth and pre-COMMIT constraint-flush behavior. Build PASS with the existing chunk-size warning.
- Isolated PostgreSQL/real HTTP rehearsal passes pre-v65 refusal, v65 migration/OID preservation, save and exact replay, six athlete values with median 25 and outlier 100, Page duplication with fresh query, guarded delete rejection, clear/delete/add/restore recovery, SQL unresolved/ambiguous binding allowance and invalid composition/axis/type/group rejection. Synthetic rows only; temporary database/server/port/cluster cleaned up. Portable cross-workspace unresolved cloning was statically traced and its SQL validator checked; it was not executed end to end.
- Separate browser component check passes at narrow and wide viewports with actual ECharts: gap for a four-athlete bucket, outlier, derived summary/contributor details, keyboard selection/reset, no horizontal overflow or chart failure. This is not a browser-to-database end-to-end test.
- Independent bounded read-only review identified staged-save ordering and unresolved-clone guard issues; both corrected. Final review scope/status is recorded in the task output report. The reviewer did not execute PostgreSQL or browser checks.

Historical full-suite frontend failures/timeouts and the backend Builder baseline failure remain outside these targeted checks. Local backup/rehearsal helpers are excluded from the PR. No production migration, merge or deploy is part of this change.

ECharts reference: [Box plot five-value input](https://apache.googlesource.com/echarts-doc/+/ae767fee3156557096b46357fef87cfb993125e3/en/option/series/boxplot.md), [Apache implementation](https://github.com/apache/echarts/blob/master/extension-src/dataTool/prepareBoxplotData.ts).

Next planned work: thresholds and references, including manual values and bindings to static tables or dynamic athlete/position baselines.

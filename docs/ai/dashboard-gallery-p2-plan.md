# P2 — chart gallery, interactions and browser PDF

Status: implemented; Draft review packet and frozen head are recorded in PR #742.
Level: RISKY (stored presentation validation and server-side derived chart data).
P1 #741 is merged and deployed as 3cf0f7f92ec82ee75ed470149c9ab688c1fd384b.
This implementation includes that main; the final evidence packet records the final base.
Contract date: 2026-11-23; final revalidation: 2026-11-24. This branch does not modify or push the reviewed P1 branch.

## Delivery boundary

P1 already includes Page navigation, management, selected-page Simple/Advanced editing,
copy-to-page and legacy Home compatibility. Do not build a second Pages UI. Continue
with the accepted P2 gallery/output topic from #715: all seven chart forms together,
with one validation design and one focused RISKY implementation PR. This document is
its shared contract; the owner authorized continued work while P1 finishes its gate.

P1 is merged. This branch targets main b1b4a8ea36770a990919e3e1522b4ed9657fb032.
Both independent reviews and an owner order are still required; do not merge or deploy.

## Verified base and migration need

Read against the checked-out P1 head, not the old draft descriptions:

- backend/src/dashboardSimple/schema.js permits kpi, line_chart, bar_chart and table.
  presentationV1 supports athletes-v1, interactions and table formatting; it has no
  gallery variant/composition contract.
- migrations_v2/202611151000_training_load_v71_dashboard_simple_atomic_save.sql,
  dashboard_presentation_valid, rejects new schemaVersion=1 keys and compositions.
  Unknown versions are opaque preservation, NOT an escape hatch for new writes.
- frontend/training-load-analysis-echarts-options.js draws line/bar plots, with named
  athlete lines and the shared per-widget group-label map. It does not draw the seven
  proposed variants.
- P1's backend/src/dashboardPages/widgetValidation.js delegates the existing write
  contract; its query service is the selected-page entry point. P2 must validate both
  Page and legacy entry points and reuse their authorization and query results.

One new migration consolidates validation and compatible-series
checks, rather than the six sequential validator replacements from #391–#397.
Owner confirmed v94 / 202611261000. The file is
migrations_v2/202611261000_training_load_v94_chart_shapes.sql.
v92 / 202611241000 (roles) and v93 / 202611251000 (calendar delete) are independent. Never rename/replay
an old migration or widen dashboard_builtin_series for these display variants.
v94 replaces four bodies: presentation validation, compatibility, Page copy and
atomic Simple save. The runbook records their predecessor and resulting body gates.

## One presentation contract

Implementation shape: extend validated presentation schemaVersion=1 with a nested
chartShape object, preserving every previously valid payload byte-for-byte. Reject unknown keys,
invalid combinations, nonfinite numbers, dangling series references and oversized
arrays in JS and SQL. Existing opaque future payloads remain preserve-only. The
JS contract and the v94 SQL contract must accept and reject the same payloads.

Use underlying line_chart/bar_chart types where semantics fit; composition identifies
the new shape. Gallery choices are server capabilities, never inferred from roles in
the browser. Do not enable writes until the deployed database supports the contract.
A schema-only deploy must remain readable by the previous server; UI activation
follows the new server deployment. Record the exact compatibility boundary in runbooks.

| Form | Inputs and server rule | Display and refusal |
| --- | --- | --- |
| Area | Existing ordered line series; no change to aggregation or query grain. | Fill under the line; missing values break the area, never become zero. |
| Horizontal bar | Existing bar series and grouping. | Swap category/value axes; retain safe athlete/group names and selectable legend. |
| Bar + line | Explicit series-to-mark and series-to-axis assignments; at most two labelled axes. | Share an axis only for the same known unit. Distinct units require separate axes; never silently normalize. |
| Heatmap | One numeric series, athlete by day/week cells, same authorized query result. | Duplicate/conflicting cells remain unavailable; missing is distinct from zero. Label the colour scale with its unit. |
| Scatter | Explicit X/Y series and exact athlete + occasion/grain identity pairing from authorized rows. | Pair only matching identities; never zip by position, interpolate, or choose among duplicate/conflicting candidates. Report omitted unmatched points. |
| Stacked bar | Explicit named additive components aligned to the same athlete/bucket/grain and known unit. | Never stack ratios, percentages, unknown/mixed units or an undeclared total with its components. Missing/conflicting components leave the stack unavailable. |
| Box plot | Distribution of authorized returned athlete aggregates for each bucket and unit. | Not unseen raw observations. State sample count; use one documented quartile/outlier convention in server and tests. Missing/conflicting values are excluded and counted. |

Chosen box convention: sorted finite samples, linearly interpolated
quantiles at (n-1)*p, median Q2, whiskers to the outermost sample within 1.5 IQR,
remaining samples as outliers. One sample is a degenerate box; no samples is no data.
Do not hide a mathematical choice inside ECharts defaults.

Multi-series composition is an Advanced gallery capability initially; it does not
silently expand the separately deferred Simple multi-variable-table contract. Simple
may offer compatible single-metric forms; preserve existing drafts, recovery and
Advanced-required behavior for unsupported compositions.

## Data, ratios and access

Build derived chart data server-side from the same already-authorized batch result;
no extra source of athletes, membership or facts. Keep owner_scope access separate
from data_workspace scope. Retain the #696 shell cohort as an additional intersection,
including constrained-empty. Do not change weekly/calendar or the shared filter.

For ratio variables, reuse #648's sums of paired inputs and coverage; never average
stored ratios. Keep ratio/max/last/none and reject sum/avg with the existing sentence.
Area, horizontal and combined may display valid returned ratio values with their own
unit. Scatter may pair valid returned ratios, with each axis labelled. Heatmap/box
may display distributions of returned ratios, explicitly not an alternative ratio
aggregation. Stacking a ratio is refused. Mixed calculation versions retain the
existing per-series error; omitted buckets do not disappear from coverage counts.

Do not alter estimates/source-policy eligibility or calculated-value writers. Athlete
workspaces retain the server's restrictions. Every derived sample must be traceable
to an eligible returned row; a conflicting candidate never becomes a chart point.
No authorization change is proposed. Access/route additions, if actually needed,
require an explicit route list and independent review, not a new parallel auth chain.

All chart captions, tables, tooltips, legends, accessible text and printed output use
the existing safe names and shared group-label map. No UUID, source provenance JSON,
receipt/token or fingerprint in coach/club-admin DOM, even in collapsed panels.
Use existing roster sorting, number formatting and DD.MM. axis / DD.MM.YYYY detail
formatting. Missing names say 'Athlete name unavailable'. No invented labels/values.

## Interaction and PDF

Use one widget composer/renderer for preview-compatible and saved display; preserve
legend settings and distinct labels for same-name athletes. Hiding/showing a series
must work across forms. Details and data-table expanded state survives navigation.
Zoom is local until the coach explicitly applies the selected period; changing the
period reuses current Page/filter/cache generation logic. Bind actions to workspace,
dashboard, Page, period and shell-filter context; discard late replies.

Browser PDF prints the selected Page, with an explicit action for all Pages if included
in the approved UI. Do not print hidden Pages accidentally. Order widgets by their
visible layout order (top to bottom, then left to right; stable tie-break), not fetch
or creation order. Charts render at print size before invoking the print dialog.
Only currently expanded data tables are included. Put a table on the next sheet when
it cannot fit under its chart; very long tables may continue with repeated headers.
Do not shrink rows into unreadability or clip columns. Exclude controls, menus,
selection handles, collapsed technical sections and scroll clipping. Browser print
has no server PDF service, upload or new permission. Read-only viewers can print
only data already visible to them.

At 360/375/390 px allow internal chart/table scroll where necessary, never page-wide
clipping; readable 16 px inputs and approximately 44 px touch targets. Check keyboard,
legend toggles, local zoom/reset and loading/error states at 1280 px as well.

## Expected files and boundaries

- backend/src/dashboardSimple/{schema,compiler,capabilities,previewService}.js and
  binding/hash helpers only where the new persisted fields must enter fingerprints.
- backend/src/dashboardPages/service.js and new bounded chart-data helpers for
  pairing, declared components and distributions; legacy path shares the helpers.
- Existing dashboard write-validation exports and SQL presentation/series guards.
  Preserve v71 request/receipt semantics and dashboard -> page -> widget -> series locks.
- frontend/training-load-simple-{view,controller,actions}.js as needed for gallery;
  training-load-analysis-{data,view,echarts,echarts-options}.js; new focused composer,
  interaction and print modules. CSS in a clearly titled P2 block, not broad restyling.
- Relevant backend/frontend tests, e2e browser/print tests, per-migration runbooks,
  ADR-003 updates only if sanctioned writes change.

Do not touch GPS import files, backend/src/calculatedValues.js, mapping migrations,
roles/calendar work, target tables/Radar (P3), or D2a/v75. Do not change the shared
query engine unless a concrete missing identity forces it; identify that dependency
and coordinate before editing it. No multi-variable Simple table in this topic.

## Verification packet and review checkpoints

1. Before implementation: confirm this validation/pairing/distribution contract and
   use the owner-confirmed v94 / 202611261000 slot. Review the exact field allow-lists and
   bounds, old/new-server compatibility, and dependent function/trigger inventory.
2. Disposable DB tests: JS/SQL validation parity; each form's allowed/refused shapes;
   both Page and legacy save/edit/copy/clone; rollback refusal after new payloads;
   apply -> rollback -> identical catalog -> apply; recorded SQL lock order if any
   writer changes; unchanged legacy receipts/hash replay. No persistent DB migration.
3. Derived-data tests: real conflicts vs unrelated definitions; missing vs zero;
   unmatched/duplicate scatter; additive declarations and unit mismatch; quantile
   boundaries/outliers; ratio formulas/coverage/source exclusions; shell empty and
   cross-workspace narrowing; safe names in all outputs.
4. Mutations: bypass SQL variant guard; remove unit check; positional scatter pairing;
   conflicting candidate admitted; missing component as zero; ratio stacked; shell
   restriction removed; print collapsed data; ignore legend visibility; stale action
   uses previous Page. Every claimed invariant needs a killed mutation or an explicit
   documented gap, not a passing example alone.
5. Commands on final candidate, same Node/PG/browser as clean base:
   node scripts/test-runner.mjs --project backend --file <new-test-file>
   node scripts/test-runner.mjs --project backend --kind disposable
   node scripts/test-runner.mjs --preset backend-fast
   node scripts/test-runner.mjs --preset frontend-fast
   npm --prefix frontend run build
   node scripts/test-runner.mjs --preset e2e
   Record exact counts, baseline failures and anything not run. Browser evidence at
   360/375/390/1280 px and rendered PDF page inspection, not only a screenshot of UI.
6. After #741 merges: update base, run final gates, freeze full SHA; Claude and an
   independent reviewer review the same head. Owner separately orders migration and
   activation; merging/deploy is not authorized by this WIP branch.

## Implementation and evidence boundary

All seven gallery forms now share the versioned chartShape contract, bounded server
projection, Advanced picker and saved renderer. Simple offers the compatible
single-metric forms only. Existing authorization and fact queries remain unchanged.
The capability requires the installed v94 marker and the existing Simple pilot.

v94 replaces four bodies: presentation validator, presentation compatibility guard,
Page copy and atomic Simple save. Copy and save remap persisted series references to
the actual newly created series. Nine new helpers, five triggers and an immutable
usage ledger enforce references, units and the rollback boundary. No backfill or
trigger disabling is used. Opaque future presentation is preserved unchanged.

The migration and its preflight, postcheck, rollback, body manifest and rehearsal
scripts are in this PR. The wrapper accepts Node >=20 and uses only loopback
self-created disposable databases. Actual apply -> rollback -> identical catalog ->
reapply is tested, as are changed-body, later-migration and real-write refusals.
The owner-operated staging CLI selects only the approved v94 plus already-recorded
files; unrelated unrecorded v92/v93 are never applied by that artifact.

PDF exports only the current Page in visible layout order, using full static legends,
without chart controls. Only expanded data tables are included, after the charts;
long tables repeat headers. The browser suite produces mobile screenshots and a
PDF for raster inspection. Non-box charts are bounded to 20 returned athletes; box
plots may summarize the bounded distribution. Row and cell limits remain enforced.

Final commands, counts, baseline differences, mutations and omissions belong in the
frozen-head PR packet. In-progress test output is not a final GO. P3 target tables /
Radar, Simple multi-variable tables and all production activation stay out of scope.

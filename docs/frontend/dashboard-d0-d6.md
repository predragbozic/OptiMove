# Dashboard D0–D6 delivery plan

## D0 — discovery, 2026-10-27

GitHub reported PR #220 open, draft, not merged, at the owner-approved
`b7d1127a11edb1debb5d1c222bd1db442ade724c`. Main was
`a1bb932f1689b528817cb01087913b62fcc7ad4d` (PR #229). A PR's synthetic merge
commit is not evidence of a merge or deployment. No deployment was verified.
The referenced chat exposed only content-reference placeholders, so this plan
maps the stages in the owner's current request; it does not claim to reproduce
an unavailable earlier document.

### Existing architecture

- `training-load-analysis-data.js`: one batch query, context cache/revision and
  generation guards; intentionally skipped template/archive queries.
- `training-load-actions.js`: dashboard actions, editor, layout drafts, pointer
  drag/resize, save/cancel, mobile ordering. Existing API remains authoritative.
- `training-load-analysis-view.js`: pure HTML, four widget types. PR #220 adds
  detached display models and strict read-side V1/V2 configuration.
- `training-load-analysis-display-model.js`: scalar eligibility, conflict/missing
  states, identity partitions and duplicate-bucket diagnostics. Chart adapters
  must consume this output, never reinterpret raw query responses.
- `app.js`: replaces the Training Load surface on render. An imperative chart
  must release its instance and observers on DOM removal and reject late loads.
- `styles.css`: 12-column grid, 46px rows, explicit x/y/width/height and independent
  mobile order. Existing accessible editor/buttons and H1–H4 flows remain.
- Plain browser ES modules in development; Vite builds production. The existing
  pinned, self-hosted Mediabunny vendor pattern supports both environments.

### Integration decisions within the authorized scope

Use a pinned Apache ECharts browser ESM distribution, lazily imported only when a
numeric chart is mounted. Retain its license/notice and record the upstream file
hash. No CDN runtime requests, framework, backend route or V2 persistence path.
Use a small custom element for mount/disconnect ownership and ResizeObserver for
container changes. Keep a readable, escaped numeric/status equivalent available
even when the library fails. SVG/canvas output is supplemental to those values.

One display-model identity partition per plot prevents different athletes,
metrics, units and reported sources from sharing a line or scale. Explicit
missing/conflict/error/unsupported/duplicate rows become gaps, never zero.
No frontend aggregation, delta, percentage, unit conversion or source inference.
V2 legend/value-label visibility and precision are presentation only.

## Delivery sequence

| Stage | Reviewable result | Base |
| --- | --- | --- |
| D0 | This read-only discovery and integration plan | approved #220 HEAD |
| D1 | Line pilot, pinned library, pure adapter, mount/dispose/resize and failure fallback | D0 |
| D2 | Bar widgets through the same adapter; negative/zero values and partition coverage | D1 |
| D3 | KPI identity context and accessible, lossless tables | D2 |
| D4 | Layout/GridStack assessment and bounded content sizing | D3 |
| D5 | Carbon-referenced hierarchy, readable feedback and focus/mobile UX | D4 |
| D6 | Final regression, production build, fixture browser QA and independent review evidence | D5 |

Each stage has its own branch/PR. These are stacked while #220 remains unmerged;
their bases must be reviewed in order. They are not independently mergeable to
main until their prerequisites are integrated. No changes to #220 itself.

## Acceptance and boundaries

Preserve V1/absent config without writes, reject invalid/unsupported versions,
retain every row/status in the readable equivalent, and honor zero and negatives.
Keep template/archive/unresolved/loading/error behavior and query ownership.
Test adapter and async element lifecycle, existing dashboard/editor/action suites,
and the actual production build. Browser QA uses synthetic fixtures at desktop,
360, 375 and 390px, with no backend or database. Report fixture limits honestly.

Independent review follows implementation; LOW/MEDIUM findings in scope are
corrected. HIGH/BLOCKER findings, API/architecture changes and risky operations
are escalated. Metrics Core/GPEXE/import code, migrations and other PRs remain
owned by Claude. No merge, deployment or production writes are authorized.

Official references: [ECharts imports](https://echarts.apache.org/handbook/en/basics/import/),
[container lifecycle](https://echarts.apache.org/handbook/en/concepts/chart-size/),
[6.1.0 release](https://github.com/apache/echarts/releases/tag/6.1.0).

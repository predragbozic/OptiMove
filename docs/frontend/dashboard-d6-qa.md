# Dashboard D6 — verification and review

Subsequent whole-chain review, npm remediation, current-main validation and merge
gates are recorded in [dashboard-integration-review.md](dashboard-integration-review.md).
The HIGH findings below describe the earlier checkpoint and are now resolved;
the full-suite baseline failures and release HOLD remain explicit in that update.

## Scope and dependency

The D0–D6 branches are stacked on the approved PR #220 commit
`b7d1127a11edb1debb5d1c222bd1db442ade724c`, which was still open and draft
when this work began. D0–D5 each have a separate commit/branch; D6 includes the
following review/browser corrections. Review the complete stack through D6.
Intermediate drafts are not a recommendation to merge before these corrections.
No merge, deployment, persistent database write or production-data QA was done.

## Independent review disposition

Two read-only agents reviewed the authored diff against #220: code/compatibility
and mobile/UX. They did not execute tests. The main session ran the tests and
browser checks below. Neither review found a HIGH/BLOCKER in the Dashboard changes.

| Finding | Correction | Executable evidence | Status |
| --- | --- | --- | --- |
| MEDIUM: content disclosure/legend/scroll interactions could fall through to widget drag in edit mode | Exclude the new widget body in both delegated pointer targeting and direct card bindings; retain explicit grip/header/resize | New action regression; real-browser disclosure and legend clicks leave the draft unchanged; handle resize still works | Fixed |
| MEDIUM: partitions differing only in reported source identity/system/entry method had identical visible context | Preserve all reported source metadata in visible provenance; retain concise single-connection labels and never substitute configured source | New view regression for chart captions, table and KPI, including distinct sourceIdentityId partitions | Fixed |
| Browser QA: long provenance squeezed table headings/values to single letters | Minimum table width, nonwrapping headers, bounded bucket column; keyboard scrolling retained | Desktop and 360/375/390px browser captures/assertions | Fixed |
| Browser QA: wider table exposed intrinsic sizing of the Analysis grid track | Constrain the outer grid track with minmax(0, 1fr) | No document horizontal overflow at all four tested widths | Fixed |

These were MEDIUM/UI corrections, not API, backend, data-model or migration changes.

## Automated regression

Node v24.22.1, 2026-10-27. Actual command from the repository root:

```text
node scripts/test-runner.mjs --project frontend --file training-load-analysis-echarts.test.mjs --file training-load-analysis-display-model.test.mjs --file training-load-analysis-display-view.test.mjs --file training-load-analysis.actions.test.mjs --file training-load-dashboards.actions.test.mjs --file training-load-dashboards-editor.actions.test.mjs --file training-load-dashboards-h4.actions.test.mjs --file training-load-dashboards-ux.actions.test.mjs --file production-build.test.mjs --log-dir ../d6-corrected-tests
```

**213 passed, 0 failed, 0 skipped; all 9 files passed.** The production-build suite
ran the actual Vite build and passed all 7 checks. The runner confirmed DATABASE_URL
unset and backend .env not read. No backend dependencies or database were needed.

The initial D1 run found a test-fixture mistake (`config` instead of the actual
`display_config` field); the corrected pilot suite passed 7/7. D2 targeted suites
passed 33/33; D3 passed 34/34. The final 213-test run includes both new independent
review regressions and supersedes the earlier 211-test D5 run. Whitespace check
`git diff --check` passed.

## Real-browser fixture QA

Headless installed Chrome, actual stylesheet, actual Analysis renderer and pointer
bindings, actual ECharts 6.1.0 SVG renderer. Only synthetic local fixtures were served
by a loopback static server. It served no backend files. Fetch was refused in the
fixture; **0 API requests**, no database and no production account/data were used.

**18 check groups passed**, with no captured browser warning/error entries on the
normal rendering path:

- 1440, 360, 375, 390px: four identity-partitioned SVG plots, three readable tables,
  no document horizontal overflow, widget bodies inside their saved bounds, no
  injected image from hostile source text; mobile inputs at least 16px.
- Actual ECharts options preserve -4.25 and zero and contain null gaps for missing
  and conflict rows; scalar comparison is still owned by the existing display model.
- Keyboard Enter toggles the native Values and status disclosure.
- In layout edit mode, disclosure and legend pointer clicks do not alter layout.
- Real pointer resize updates the local draft and the observed SVG container size.
- Mobile reorder works with a target of at least 44px; desktop resize handle hidden.
- Loading, template, archive, unresolved, unsupported config, malformed result,
  query error and duplicate buckets show explicit states without numeric plots.
- Removing the dashboard releases every ECharts instance.
- Intentionally aborting the library request shows the explicit failure fallback
  while readable values remain available. The expected abort is separate from
  the clean normal-path console check.

Screenshots and machine-readable browser results are retained in the session's
`outputs/dashboard-qa/`. Unit lifecycle tests additionally cover delayed import
after detach/reattach and library/partial-render failure cleanup.

Limits: fixture QA is not a live backend/data audit, real-device iOS/Safari test,
assistive-technology certification, a production deployment check or evidence that
the unmerged stack has been integrated into current main. Table and widget regions
scroll to preserve saved desktop dimensions; multiple identities intentionally use
separate plots and scales. The full self-hosted ECharts distribution adds a lazy
chunk of about 1.1MB uncompressed; it is not fetched by non-chart screens.

## HIGH findings outside this change — owner escalation

`npm audit --prefix frontend --json` reported **3 HIGH packages** in the existing
frontend dependency lockfile: `source-map-js`, `undici`, and direct development
dependency `vite`. Fixes are reported available. The manifest/lockfile are unchanged
from #220 and the main snapshot used for discovery; ECharts is vendored and did not
add npm dependencies. The audit report was retained in the session work directory.

Examples from the audit: [source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q),
[undici advisory](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5),
[Vite advisory](https://github.com/advisories/GHSA-698v-4r3x-3vcv).
No exploitability conclusion or silent dependency upgrade is made here. These HIGH
findings need a separate owner-approved dependency/remediation decision before
release readiness; the Dashboard PRs remain drafts and are not merge/deploy approval.

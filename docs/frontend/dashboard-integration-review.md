# Dashboard whole-chain integration review and controlled merge plan

Latest owner-condition verification against advanced main fdc2c2e and confirmed
Render deployment behavior: [dashboard-owner-gate.md](dashboard-owner-gate.md).
The a1bb932 counts and unconfirmed-workspace statements below are retained as
historical checkpoint evidence; use the owner-gate report and current JSON for
the latest gate disposition.

Review date: 2026-10-27. This continues the existing Work session and existing
PR #220 → #230 → #231 → #232 → #233 → #234 → #235 → #236 chain. No new
development branch or PR was opened for this review.

**Disposition: Dashboard review closed; release HOLD.** Scoped checks and npm
audit pass. The complete frontend suite has independently reproduced main
baseline failures. They have not been waived. Deployment-trigger settings still
need verified workspace access, and all merges/deployments require owner approval.

Machine-readable evidence: [dashboard-integration-evidence.json](dashboard-integration-evidence.json).
Raw browser check results: [dashboard-integration-browser.json](dashboard-integration-browser.json).
Matched failing test names: [dashboard-baseline-failures.json](dashboard-baseline-failures.json).
This supersedes earlier D6 statements about unresolved npm HIGH findings.

## Verified GitHub and source snapshot

| Item | Verified state |
| --- | --- |
| Main | `a1bb932f1689b528817cb01087913b62fcc7ad4d` |
| PR #220 | OPEN, draft, unmerged, approved HEAD unchanged: `b7d1127a11edb1debb5d1c222bd1db442ade724c` |
| #230 / D0 | `64c69cd0cd54cbd3f4093db222aa58bfa430be5a` |
| #231 / D1 | `4daa88597a78699ad92456a9696dacf344d8653c` |
| #232 / D2 | `49684e7bb570f67612bef6218523c4d05d59c90f` |
| #233 / D3 | `6ab8277a67282f5a9a3c12ba5c0a74ee2ea4edae` |
| #234 / D4 | `a8ccede140b79b875ea77a0c884bbd2b345c39fc` |
| #235 / D5 | `a1ab3900fadba02bbf731265bee1fc7de95291ea` |
| #236 / reviewed code | `dbf3383ebb2b1b0e9a06e5bf15303376d465ce5f`; later evidence-only commit is identified by the PR HEAD/status comment |

The common base is `deb2aa1bbc129b264fe3c1ebf53846fb81756259`. The entire
Dashboard patch, including #220 and the integration corrections, was applied to
an isolated archive of current main using `git apply --check` then `git apply`.
No merge commit or main ref update was used for this compatibility simulation.

The snapshot retains all other main files: 1,026 unchanged files were compared
byte-for-byte to a separate archive of main. Twenty-five nonshared Dashboard
files matched the author branch after normalizing working-tree CRLF/LF.
The three shared files (`app.js`, `styles.css`, `training-load-actions.js`) were
patched against main, retaining its other changes. Vendor bytes were separately
verified without line-ending normalization.

Claude's open #237 was only checked for filename overlap: `styles.css` is shared;
Dashboard rules remain scoped to Dashboard selectors. Its branch, metric variable
files, Metrics Core/GPEXE/import implementation, backend and migrations were not
modified. No production database, credentials or API was used in tests.

## Corrections and independent disposition

Two independent read-only agents reviewed the whole chain/#220 and dependency
security respectively. The main author reproduced findings, made corrections,
ran tests and requested narrow follow-up reviews until the findings were closed.
Reviewers did not execute tests and are not presented as human/GitHub approvals.

| Finding | Correction | Evidence | Final status |
| --- | --- | --- | --- |
| MEDIUM: accepted cached query kept a previous context error | Clear queryError when accepting a successful result | Error in period B → cached A → forced A refresh regression | Closed by code re-review |
| MEDIUM: activity handoff could show A values under B while metadata loads | Reset existing query ownership before changing activity context | Deferred metadata plus old pending success and error; old values never return | Closed by code re-review |
| MEDIUM: incomplete ECharts redistribution notices | Restore upstream d3 license and emit all three notices in the actual production distribution | Output/vendor byte comparison; security re-review and production test | Closed |
| LOW: handoff mock did not hold the real metadata URL | Match the complete query URL and assert the deferred resolver and loading state | 45/45 action tests, narrow independent re-review | Closed |
| LOW: app-update wiring test assumed a single Vite plugin | Allow other plugins while requiring buildStamp; additionally test actual HTML stamps and absence from JS bundles | app-update 8/8 and production build 9/9 | Closed |
| LOW: Windows checkout could alter the pinned vendor hash | Add only frontend/vendor/echarts/** -text, following the existing Mediabunny pattern | Fresh checkout-index under core.autocrlf=true matches all four upstream files byte-for-byte; security re-review | Closed |

Before the query corrections, the three new regressions actually failed
(42 passed / 3 failed). After correction and the mock fix the action file passed
45/45. No unresolved Dashboard HIGH/BLOCKER or significant architecture/API
decision was identified by these reviews.

## The three npm HIGH packages

The initial audit on the unchanged lockfile reported source-map-js 1.2.1,
Undici 8.10.0 and Vite 8.2.1. The bounded remediation used
`npm audit fix --prefix frontend --package-lock-only --ignore-scripts`, without
`--force`. Package manifest and its version ranges remain unchanged.

| Package | Final installed version |
| --- | --- |
| source-map-js | 1.2.2 |
| undici | 8.12.3 |
| vite | 8.3.5 |
| jsdom | 30.0.1, unchanged |

Rolldown/OXC and supporting lock entries follow Vite's dependency closure. Clean
installation succeeded; a fresh full audit including development dependencies
reported **0 vulnerabilities of any severity**. Independent security review
confirmed lock scope, installed versions, integrity metadata and unchanged ranges.

These are build/test tooling dependencies, not demonstrated browser/runtime
imports. They still execute in deployment infrastructure; devDependency is not
treated as proof of non-exposure. No exploitability exemption was used.

ECharts remains 6.1.0 and matches its upstream npm tarball byte-for-byte, including
the complete notices. SHA-256 of the module:
`28515f26aa57f87eb1e4ed4eb446927eaf329b5f5e02b4bfd4b0264fea40d1da`.

## Actual integrated validation

All commands below ran on the isolated **main + complete Dashboard stack +
corrections** snapshot, with Node test runner v24.22.1. Clean dependency install
explicitly invoked npm-cli.js with that bundled Node. Existing npm build shims
use installed Node v24.12.0, which also completed the Vite build; this does not
claim tests ran on a live Render runtime.

Focused integration command:

```text
node scripts/test-runner.mjs --project frontend --file training-load-analysis-echarts.test.mjs --file training-load-analysis-display-model.test.mjs --file training-load-analysis-display-view.test.mjs --file training-load-analysis.actions.test.mjs --file training-load-calendar.actions.test.mjs --file training-load-dashboards.actions.test.mjs --file training-load-dashboards-editor.actions.test.mjs --file training-load-dashboards-h4.actions.test.mjs --file training-load-dashboards-ux.actions.test.mjs --file production-build.test.mjs --file app-update.test.mjs --log-dir ../integration-final-targeted-tests
```

**274 passed, 0 failed, 0 skipped; all 11 files passed.** Includes the actual
production build (9 checks), licensing and real HTML build-stamp checks.

Full frontend command:

```text
node scripts/test-runner.mjs --project frontend --log-dir ../integration-main-final-tests
```

**2,105 passed, 14 failed of 2,119; 148 files: 140 pass, 4 known-fail, 4 fail.**
The runner's failed count includes 12 failed and 2 cancelled tests. This command
returned FAILED. Of the 14 unsuccessful events, 9 are already classified by
the runner and 5 are additional failures across these four files:

- builder-create-form-fixes.test.mjs: one fixed-size source-slice assertion.
- builder-performance-fixes.test.mjs: two fixed-size source-slice assertions.
- exercise-ownership.test.mjs: one expected request-count assertion.
- exercise-personalization.test.mjs: one expected media-fallback assertion.

All 14 failing test names matched failures executed on pristine main with its
original lockfile, not inferred from untouched paths. They are not newly
introduced by the Dashboard patch or dependency remediation. They were not
suppressed, added to an allowlist, modified or treated as passing.

Pristine-main baseline commands, in detached temporary worktrees at a1bb932:

```text
node scripts/test-runner.mjs --project frontend --file app-update.test.mjs --file builder-create-form-fixes.test.mjs --file builder-performance-fixes.test.mjs --file exercise-ownership.test.mjs --file exercise-personalization.test.mjs --file builder-mobile-section-workflow.test.mjs --file organization-panel-cache.test.mjs --file tests-schedule-management.actions.test.mjs --log-dir ../integration-baseline-tests
node scripts/test-runner.mjs --project frontend --file training-load.actions.test.mjs --log-dir ../integration-baseline-timeout-tests
```

First baseline: 140 passed / 12 failed, 8 files. Second: 115 passed / 2 known
cancelled tests at the per-test limit, 1 file. Both temporary worktrees were
removed in finally blocks. Separate event-name comparison confirmed exactly
14 matching baseline failure events and zero new failure events.

`node scripts/verify-render-build.mjs` also passed on the integrated snapshot:
clean isolated npm ci --include=dev under production/dev-omitting settings,
then a real build producing both HTML entries. It never contacted Render or
started the backend/migration runner. Whitespace checks passed.

Actual Chrome fixture QA passed all 18 groups at 1440/360/375/390px, with
0 API requests and no normal-path warning/error entries. This includes real
ECharts values/gaps, keyboard disclosure, layout-mode interactions, pointer
resize, mobile reorder, explicit states, disposal and library-failure fallback.
It is not production-data, real-device Safari or assistive-technology QA.

## Controlled merge plan — prepared, not executed

GitHub currently permits merge commits, squash and rebase. Main is unprotected
and has no repository rulesets; no native CI checks were reported on #220/#236.
These settings do not supply approval or remove the following manual gates.

1. **Freeze and revalidate.** Capture all current PR head/base SHAs and main.
   Any changed relevant ref invalidates the corresponding compatibility evidence.
   Confirm the working tree is clean and review the complete final diff. Keep
   automatic merging disabled and the drafts intact until explicitly approved.
2. **Deployment-trigger gate before any merge.** Verify the intended Render
   workspace/service, tracked branch, automatic deploy and preview settings.
   Read-only access currently returned "no workspace selected". The sole listed
   workspace is "My Workspace", but the agent did not select it without owner
   confirmation. No service settings, live deploy or deployment triggers have
   been inferred or changed. Any temporary pause of deployment automation needs
   separate explicit approval; do not risk intermediate or preview deployments.
3. **Owner decision on existing test debt.** The full suite is not green. Before
   main merge the owner must explicitly accept the enumerated, reproduced main
   baseline failures as existing debt, or have their separate owner repair them
   and rerun validation. Dashboard review does not waive them automatically.
4. **Approve feature-branch consolidation only.** Prefer merge commits, preserving
   ancestry, in reverse dependency order: #236 into #235's branch; then #235 into
   #234's branch; #234 into #233; #233 into #232; #232 into #231; #231 into #230;
   and #230 into #220. Re-read each newly advanced head and pin the merge to that
   expected SHA. Record every resulting merge commit. Do not squash/rebase or
   force-push this dependent stack. Main must remain unchanged throughout.
5. **Recheck the consolidated #220.** Its head will no longer be the previously
   approved b7d1127. Verify the consolidated tree contains all final corrections
   and notices, compare it with current main, run focused regression/audit/build
   against that actual tree and confirm no new baseline failure events. Obtain
   new approval for the exact consolidated HEAD; the old approval is insufficient.
6. **One main merge, on explicit approval.** Only after gates 1–5 and an explicit
   approval covering the verified deployment-trigger behavior, merge #220 into
   main. This avoids eight intermediate main revisions. Record main's new SHA
   and verify it contains the reviewed final tree. No merge command is authorized
   by this document.
7. **Separate deployment gate.** If deploy was not explicitly covered by the final
   approval, stop. Before an approved deploy, verify current service/live commit
   and pending migration state through the responsible owner's process; backend
   startup runs migrations even though Dashboard adds none. Do not run Claude's
   migrations or production post-checks on his behalf. Then verify the approved
   deployment reaches live and perform agreed read-only smoke checks.

Stop conditions: changed refs, new/unexplained failures, audit regression,
conflicts affecting non-Dashboard code, unexpected deployment triggers, missing
notices, or any HIGH/BLOCKER. Preserve the reviewed branches and evidence; do not
reset, force-push or run a compensating production operation automatically.

No merge, deployment, auto-merge enablement or production write was performed.

# Dashboard final owner conditions and deployment gate

2026-10-27. Same Work session and existing #220/#230–#236 chain. This report
supersedes the earlier a1bb932 integration checkpoint. Application code is
unchanged from reviewed `dbf3383`; this update contains evidence only.

The owner confirmed Render **My Workspace** and conditionally accepted all 14
baseline failures subject to five explicit conditions. The owner explicitly
stated that neither confirmation is merge or deployment approval.

## Current-main revalidation

Main advanced independently through Claude's #237 to
`fdc2c2efd0fb1c70e2241775f9af1132d0ceb550`. The entire Dashboard patch, including
#220 and all corrections, applies cleanly to an isolated archive of this main.
No merge, rebase, main update or alteration of Claude's work was used.
1,027 non-Dashboard main files match the control archive byte-for-byte; 29
nonshared Dashboard files match the author branch after working-tree EOL
normalization. Shared app/styles/actions were patched against current main.
ECharts' actual module was separately restored/checked against upstream bytes:
SHA-256 `28515f26aa57f87eb1e4ed4eb446927eaf329b5f5e02b4bfd4b0264fea40d1da`.

## Evidence for the owner's five conditions

| Condition | Actual evidence |
| --- | --- |
| 1. All 14 reproduce identically on unmodified main, same environment and procedure | Two complete pristine-main runs: one with its original committed lock; a second with the exact candidate installed dependency tree. Both reproduce all 14. Same machine, Node v24.22.1, full runner command, database scrub and test limits. Tracked source and lock remain unchanged; temporary worktrees removed. |
| 2. No new failures or worsening | Three-way comparison includes file, test name, failure type, message and hash of complete actual/expected error detail. Exactly 14 matching signatures, zero new/worse signatures; 12 assertion failures plus 2 same-limit cancellations. No assertion content removed from comparison. |
| 3. All 274 Dashboard/integration tests remain successful | Fresh final focused run on current main + Dashboard: 274 passed, 0 failed, 0 skipped; all 11 files passed, including actual production build 9 checks and calendar/app-update integration. |
| 4. Five unmarked cases tracked without concealment | [Issue #239](https://github.com/predragbozic/OptiMove/issues/239) lists all five exact cases for separate follow-up. No test skip, allowlist, test-debt repair or unrelated application change was introduced. |
| 5. Independent confirmation of attribution | Independent read-only code reviewer examined environment fingerprints, actual logs/signatures and unchanged failure paths; final disposition is recorded in the canonical #236 status. Reviewers did not execute tests. |

Final independent disposition: **all five evidence conditions met**. The reviewer
independently recomputed all three sets of failure signatures from the actual
logs and found 14 identical signatures and zero differences, verified both
274/274 focused runs and issue #239, and confirmed no remaining evidence gap.
Accordingly the owner's conditional acceptance applies to these exact 14 cases
on tested main fdc2c2e. This accepts documented debt, not passing test results,
merge authority or deployment authority. Revalidate if relevant refs change.

Full-suite results, all commands returning FAILED because the failures remain:

| Tree / installed dependencies | Files | Passed | Unsuccessful | Total |
| --- | --- | --- | --- | --- |
| Pristine main fdc2c2e, original lock | 146 | 2,052 | 14 | 2,066 |
| Main fdc2c2e + Dashboard, reviewed security lock | 149 | 2,140 | 14 | 2,154 |
| Pristine main fdc2c2e, exact candidate installed dependency tree | 146 | 2,052 | 14 | 2,066 |

The additional candidate tests are not confused with a different baseline
procedure. Each tree ran the same complete frontend runner; it selects the files
that exist on that ref. Original-lock differences are disclosed in
[environment proof](dashboard-owner-environment.json). The additional
[dependency-aligned control](dashboard-owner-aligned-environment.json) verifies
the identical installed tree through a temporary ignored node_modules junction;
no tracked main source/lock change was made. The junction was removed before
the detached worktree was removed.

[Signature evidence](dashboard-owner-failure-signatures.json) retains exact
failure types, messages, actual/expected detail hashes and bounded excerpts.
Only CRLF/LF and stack-frame locations are normalized. The runner, reporter
and all eight unsuccessful test files also have identical source fingerprints.

Full-suite commands, run in the corresponding isolated roots:

```text
node scripts/test-runner.mjs --project frontend --log-dir ../owner-pristine-main-tests
node scripts/test-runner.mjs --project frontend --log-dir ../owner-integrated-main-tests
node scripts/test-runner.mjs --project frontend --log-dir ../owner-aligned-main-tests
```

Final focused command:

```text
node scripts/test-runner.mjs --project frontend --file training-load-analysis-echarts.test.mjs --file training-load-analysis-display-model.test.mjs --file training-load-analysis-display-view.test.mjs --file training-load-analysis.actions.test.mjs --file training-load-calendar.actions.test.mjs --file training-load-dashboards.actions.test.mjs --file training-load-dashboards-editor.actions.test.mjs --file training-load-dashboards-h4.actions.test.mjs --file training-load-dashboards-ux.actions.test.mjs --file production-build.test.mjs --file app-update.test.mjs --log-dir ../owner-focused-final-tests
```

`node scripts/verify-render-build.mjs` also passed again on the current-main
candidate: clean production-style install and actual build, entirely local.
Chrome fixture QA again passed 18 groups at 1440/360/375/390px with zero API
requests and no normal-path browser warning/error entries. No backend/database
or production application was involved in these tests.

## Separate HIGH security assessment

Fresh `npm audit --prefix frontend --json` including development dependencies
again reports **0 vulnerabilities at every severity**. Installed versions remain
Vite 8.3.5, source-map-js 1.2.2, Undici 8.12.3; jsdom 30.0.1 and manifest ranges
are unchanged. Independent security re-review confirms the earlier three HIGH
dependency findings remain resolved. This is bounded dependency/vendor review,
not a claim that the whole application is vulnerability-free.
The clearance applies to the reviewed Dashboard lockfile. Unmodified main still
contains the original tooling lock; no production rollout of these fixes is
claimed because this session has performed no merge or deployment.

## Verified Render deployment behavior

The owner-confirmed workspace is `tea-d8oih13bc2fs73en2ucg` (My Workspace).
Read-only list/get-service/list-deploys responses are summarized in
[dashboard-render-gate.json](dashboard-render-gate.json), excluding credentials
and unrelated connection details.

- **OptiMove-eu**: main, automatic deploy **On Commit**, PR previews off;
  build `npm run build`, start `npm start`.
- **optimove-media-cleanup**: main, automatic deploy **On Commit**, hourly cron.
- Legacy **OptiMove**: main, automatic deploy off; PR previews off.
- Render reports both active services live on fdc2c2e from independent earlier
  `new_commit` deployments. This session triggered neither. Render live status
  is not an independent application-health or migration-state check.

**A main merge would automatically deploy BOTH active services.** Previews off
does not suppress linked-main deployment. The current settings match
[Render's automatic-deploy documentation](https://render.com/docs/deploys).
No automatic deploy settings, cron schedule or service settings were changed.
The listed services do not track these feature branches.

## Merge plan delta and remaining approval

The reverse-consolidation plan in
[dashboard-integration-review.md](dashboard-integration-review.md) is retained.
Deployment-trigger discovery and the owner baseline-debt conditions are now
supported by current-main evidence. These are not merge authorization.

1. With **explicit feature-branch consolidation approval**, merge #236 into
   #235's branch, then #235 into #234, and continue through #230 into #220,
   preserving merge commits/ancestry and pinning each expected head. Do not
   update main or enable automatic merge. Recheck service/PR triggers first.
2. Revalidate the resulting consolidated #220 tree against then-current main.
   Its new head requires fresh explicit approval; approved b7d1127 is not the
   consolidated tree. Recheck tests, audit, drift and deployment state.
3. **Before any main merge**, obtain either explicit approval covering both
   coupled web/cleanup deployments, or separate approval to pause automatic
   deploy on both services and verify both are off. Do not silently pause them
   or use a skip-deploy message to circumvent this gate.
4. Backend start runs migrations. Any approved deployment must therefore use
   the responsible owner's migration-state verification process. Dashboard adds
   no migrations and will not execute Claude's migration/post-check operations.

The full suite is still red and the accepted cases remain open debt. No merge,
deployment, auto-merge enablement, production write or service change occurred.

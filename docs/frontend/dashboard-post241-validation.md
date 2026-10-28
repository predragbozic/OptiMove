# Dashboard #220 — post-PR241 integration review, 2026-10-28

**NO-GO for production: inherited backend HIGH security findings require a scope/remediation decision.** Dashboard regression checks support compatibility with current main. The previous production-readiness conclusion is superseded by this report.

## Exact candidate and integration source

- Runtime-validated Dashboard HEAD: `c10842ea1369094aa5e207179396caa6708e9386`.
- Main: `a07fdd12ff9d45147193709c2c20e029185759f0` (PR244). Its runtime source equals `d96936ce5b2033be0f32a0bb076e3341ac80eda0` (PR242); the intervening delta is four documentation files. Those current files were included in both controls.
- Full Dashboard patch applied cleanly to current-main source. This integration is an isolated source snapshot, not a published merge commit. No main merge/rebase was performed.
- No Dashboard delta under `backend/` or `migrations_v2/`. No Metrics Core/GPEXE/import code, migration or PR was changed.
- PR241 adds source-revision lifecycle routes and v39/v40. It changes no Dashboard routes, query/catalog/widgets or frontend files. Independent static review found no Dashboard response/configuration contract regression; V1/V2 presentation handling is preserved.

## Fresh validation

Node test runner: v24.22.1, Windows. Unit runner unsets DATABASE_URL and ignores backend/.env. Both controls share the **same installed node_modules trees**, rather than merely compatible declared ranges. Pristine main's tracked manifests/locks stay unchanged. Package-tree fingerprints and full error-detail hashes are in [failure/environment evidence](dashboard-post241-failures.json).

| Run | Passed | Unsuccessful | Result |
| --- | ---: | ---: | --- |
| Focused Dashboard/integration, 11 files | 274 | 0 | PASS, including 9 production-build checks |
| Integrated candidate, complete frontend, 149 files | 2140 | 14 | FAILED with accepted baseline debt |
| Pristine current-main source, complete frontend, 146 files | 2052 | 14 | FAILED with the same debt, repeated in detached main worktree |
| Candidate backend unit, 18 files | 339 | 1 | FAILED, identical existing Builder assertion |
| Pristine current-main backend unit, 18 files | 339 | 1 | FAILED, same assertion |

The 14 sequential frontend failures match each other **and the previously accepted14** on file, title, failure type, message and complete assertion-detail hash. Zero new/worse Dashboard failures. Twelve assertion failures and two identical 15-second cancellations remain visible. Five unmarked cases remain OPEN in #239; no skip or allowlist was added. Independent attribution review is recorded in the canonical PR status.

Independent closing reviewer **Ohm** verified all five comparison pairs, both current-main controls,274/274 focused results, the historical14-signature set, source provenance and identical installed dependency trees. All five owner conditions for those14 cases are supported. The archive control matches1,052 tracked files in clean detached main; all41 Dashboard patch results match the integrated snapshot and the other1,041 tracked files remain unchanged. **Leibniz** independently closed the DB/security evidence wording review with no findings. Both reviewers were read-only; neither conclusion supplies production approval. The detached baseline worktree is removed after review; log and fingerprint evidence is retained.

Initial concurrent full runs each had **15** unsuccessful cases (candidate2139 PASS; main2051 PASS): the extra thumbnail test13 failed its early `capturing === true` assertion in a scenario using a40ms deadline. This is consistent with timing sensitivity under load; the exact scheduling cause is an inference. An isolated candidate rerun passed14/14 thumbnail tests; both sequential full runs also passed that file14/14. Those initial failures are retained in the evidence, and are not covered by the owner's14-case debt acceptance. The reproduced timing sensitivity is a follow-up observation, not a silently excluded test.

The backend failure is `builder-tree-batch.test.mjs`, “large copies chunk inserts without losing parent mapping or exercise doses”: `batch must stay below PostgreSQL parameter limits`. It is outside the accepted14 frontend cases and is **not claimed as owner-accepted debt**. No unrelated Builder fix was made.

Clean production-config install/build: PASS via `node scripts/verify-render-build.mjs`; both dist entrypoints exist with dev dependencies deliberately included under production npm settings. The production-build test also verifies ECharts notices. Build subprocesses use the installed npm runtime (Node24.12); test runner uses24.22.1.

No SQL-backed suite or migration was executed under the user's migration restriction. Consequently fresh DB-trigger behavior, actual HTTP Dashboard integration over a database, and cross-workspace database enforcement are not claimed as freshly tested. Static compatibility review and existing production migration evidence have narrower scope.

## Security gate

Fresh audits include development dependencies. [Frontend audit](dashboard-post241-frontend-audit.json): **0**. [Backend audit](dashboard-post241-backend-audit.json): **1 CRITICAL, 2 HIGH, 1 MEDIUM** package findings; backend lock/manifests equal main. The earlier zero finding applied to frontend, not the full application.

- **HIGH body-parser1.20.5:** default `express.json()` at `backend/src/server.js:65` decompresses requests before authentication. The trailing-compressed-bytes process-crash advisory is applicable;1.20.9 fits the existing dependency range. [Advisory](https://github.com/advisories/GHSA-27r3-jxmh-p828).
- **CRITICAL proxy-addr2.0.7:** the particular IPv6 trust-subnet prerequisite is absent in reviewed application source (Express trust proxy stays false). Audit severity is retained; a demonstrated critical exposure is not asserted. Patch2.0.8 fits the existing range. [Advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h).
- **HIGH nodemailer9.0.4:** Gmail transport passes client-derived recipient strings to the parser; practical exposure depends on production provider, which was not read. Clearing all reported ranges requires at least10.1.4, across the declared major boundary. Requires mail compatibility review; no major upgrade was silently made.
- **MEDIUM qs6.15.2:** vulnerable comma/stringify operations were not found in application usage.6.16.1 clears reported ranges but exceeds Express's current tilde dependency; an override or compatible upstream update needs regression review.

Independent security reviewer recommends holding production until body-parser remediation, plus Nodemailer remediation or a separately justified, time-bounded exception based on verified provider. A user scope decision for backend dependency changes was requested. No dependency change or risk acceptance has been assumed.

## Render and migration evidence — read only

- My Workspace `tea-d8oih13bc2fs73en2ucg`, previously confirmed by owner.
- **OptiMove-eu:** LIVE at a07fdd1, deploy `dep-dbgutrqvcj2c73dt0250`; `/api/health` returned `ok:true`, exact a07fdd1 and DB time2026-10-28T12:52:40.349Z. One instance observed; recent HTTP metrics had no5xx samples. This is a bounded health observation, not load or recovery testing.
- **optimove-media-cleanup:** LIVE deployment at a07fdd1, `dep-dbguts2vcj2c73dt03h0`; hourly schedule `0 * * * *`. A refreshed service response reports successful run at2026-10-28T13:02:10Z, after this deploy. Job output/data effects were not independently inspected, and no manual run was triggered.
- Startup log at12:48:18.223Z: v39 “skip (already applied, checksum matches)”; at12:48:18.246Z: v40 same result; at12:48:18.270Z: all migrations up to date. This directly supports recorded migration/checksum state, **not an independent SQL postcheck of trigger enablement or data invariants**. PR242 separately records owner's preflights/postchecks without pasted SQL values.
- Both active services remain autoDeploy=yes, trigger=commit, branch=main; previews OFF. Merging #220 into main would automatically deploy **both**. Build/start commands are unchanged; web start runs the migration runner before the server.
- Legacy service auto-deploy is OFF; it is not flagged suspended. Lack of an open port and auto-deploy OFF alone do not establish full inactivity. No service setting was changed.

## Controlled next-operation plan

1. Resolve the backend security scope decision. Make an approved bounded dependency correction, or record a specific reviewed exception; a blanket frontend-zero claim cannot waive body-parser risk.
2. Re-run affected mail/parser/backend tests, audits, focused Dashboard/build and dependency-aligned comparisons after any dependency correction; obtain independent closing review. Additional backend debt stays separately visible.
3. Recheck exact main and PR HEAD. Any new runtime drift invalidates this gate until evaluated. Publish the final evidence-only HEAD separately from the runtime-tested source SHA.
4. Only after all gates close, request explicit approval covering merge **and both automatic deployments**. No operational action is authorized by this report. An alternative pause of both auto-deploys also needs separate explicit approval.
5. After any separately approved operation, verify merged/deployed SHA, web health, recorded migration state and a successful cleanup run; migration/data/rollback operations require their own approval. Dashboard contributes no migration, and no rollback script is run automatically.

Exact commands: fullfrontend `node scripts/test-runner.mjs --project frontend --log-dir <isolated-log-dir> --json <report>` on each source; backend `node scripts/test-runner.mjs --project backend --kind unit --log-dir <isolated-log-dir>`; audits `node <npm-cli.js> audit --json` in frontend and backend. Focused run uses eleven `--file` options: training-load-analysis-echarts, training-load-analysis-display-model, training-load-analysis-display-view, training-load-analysis.actions, training-load-calendar.actions, training-load-dashboards.actions, training-load-dashboards-editor.actions, training-load-dashboards-h4.actions, training-load-dashboards-ux.actions, production-build, app-update (each ending `.test.mjs`).

No main merge, deploy trigger, Render mutation, migration or production write. #220 remains OPEN/draft. Local status publications are not native CI or a human GitHub approval.

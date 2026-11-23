# P1 Pages — review evidence

This is a RISKY draft-review packet, not a production GO. The frozen head is in the PR header. The server flag `DASHBOARD_PAGES_ENABLED` and the separate database switch both default closed. No production SQL, merge, deploy or activation was performed by this work.

## Completed P1 checks

Environment: Windows; Node 22.22.0; local PostgreSQL 17.11; Chrome 158.0.8127.36. Production is PostgreSQL 17.6, so the owner's PG17 rehearsal remains a separate prerequisite.

| Repository runner file | Passed |
| --- | ---: |
| dashboard-pages-migration.test.mjs | 17 |
| dashboard-pages-writers.test.mjs | 6 |
| dashboard-pages-v91-rollback.test.mjs | 1 |
| dashboard-pages-legacy-server.test.mjs | 16 |
| dashboard-pages-disposable.test.mjs | 12 |
| dashboard-pages-access.test.mjs | 9 |
| dashboard-pages-concurrency.test.mjs | 6 |
| Total real-database P1 tests | 67 |
| e2e/tests/dashboard-pages.test.mjs | 7 |

The migration cases execute the actual SQL and runbooks, including application, guarded rollback, catalog equality and reapplication. Catalog equality includes ownership, ACLs, RLS, policies, constraints, indexes, triggers and function definitions. Optional v88/v89 are exercised absent, individually present, and present in both application orders. The A-only owner command applies no optional migration and refuses an unrecorded prerequisite.

The seven browser cases cover 360/390/1280 px, create/rename/reorder controls, duplicate/empty names, shared period, Simple save, copy, nonempty deletion refusal, empty deletion, remembered selection, late responses after dashboard navigation, coach/admin DOM without technical details, and a browser clock ten minutes ahead. Widget editing waits for the Page reload/save/recovery to finish.

The confirmed previous production binary is **aa6e765c86525f23d4ff970c9fa550b4183bae01**, supplied from `/api/health` at 2026-11-23 08:13:01 UTC. Its unchanged archived source passed the 16 old-server checks. Historical 4301851 evidence remains a dated snapshot only. The rehearsal accepts a fresh owner-confirmed `--old-build` SHA.

Commands (from the repository root; local connection only):

```text
node backend/scripts/dashboard-pages-rehearsal.mjs --host 127.0.0.1 --port 55439 --pg-bin "C:/Program Files/PostgreSQL/17/bin" --old-build aa6e765c86525f23d4ff970c9fa550b4183bae01
node scripts/test-runner.mjs --project backend --file dashboard-pages-migration.test.mjs
node scripts/test-runner.mjs --project backend --file dashboard-pages-legacy-server.test.mjs
node scripts/test-runner.mjs --project e2e --file dashboard-pages.test.mjs
node scripts/test-runner.mjs --project frontend --file training-load-pages-view.test.mjs
node scripts/test-runner.mjs --project frontend --file training-load-analysis.actions.test.mjs
npm --prefix frontend run build
```

Both `.ps1` and `.sh` wrappers rejected a non-loopback host before any connection/password handling. The full PowerShell wrapper also returned `RESULT: PASS` on the local PG17 cluster. The Linux wrapper and production PG17.6 are for the owner's rehearsal.

## Broad gates and baseline comparison

The paired fast gates used clean main **74331c287628f9d1a86ef0bcfd6e0fb4664980d4**, the same Node version and dependency locks. The subsequent aa6e765c main change is backend-only. Exact file-level failure names and counts match between P1 and the clean baseline.

| Command | P1 | Clean main |
| --- | --- | --- |
| `node scripts/test-runner.mjs --preset frontend-fast` | 299 files: 272 pass, 4 known-fail, 23 fail; 4120 passed / 61 failed of 4181 tests | 298 files: 271 pass, 4 known-fail, 23 fail; 4110 passed / 61 failed of 4171 |
| `node scripts/test-runner.mjs --preset backend-fast` | 64 files: 58 pass, 6 fail; 655 passed / 89 failed of 744 tests | 63 files: 57 pass, 6 fail; 653 passed / 89 failed of 742 |
| frontend build | PASS | Not repeated; P1 build passed |

No new known-failure entry was added. The one manifest kind override is the pure rehearsal CLI argument/URL test: it opens no database or socket. All seven database P1 files run as disposable tests.

The overnight broad runs were affected by computer suspension (Windows records resume at 08:40 local on 23 November). Their multi-hour timeout totals are **not GO evidence**. Raw results are retained without calling them green:

| Broad command | Raw P1 result | Raw clean-main result |
| --- | --- | --- |
| `node scripts/test-runner.mjs --project backend --kind disposable` | 190 files: 168 pass, 1 known-fail, 14 fail, 2 timeout, 5 crash; 3334 passed / 17 failed of 3352 reported tests | 183 files: 161 pass, 1 known-fail, 13 fail, 3 timeout, 5 crash; 3260 passed / 17 failed of 3278 reported tests |
| `node scripts/test-runner.mjs --preset e2e` | 76 files: 73 pass, 2 fail, 1 timeout; 390 passed / 2 failed of 392 reported tests | Whole preset not repeated on main |

Follow-up while the system was held awake:

- P1-only differences in `source-metric-mapping-m2`, `source-metric-mapping-transitions-7b` and `tests-module-schedule-management` passed 26/26, 17/17 and 48/48.
- Main-only sleep-affected `training-load-dashboard`, `support-disposable-db` and `team-dashboards-club-variables-o7` passed 154/154, 6/6 and 11/11.
- Three media files first lacked `MEDIA_TEST_DATABASE_URL`. With it explicitly set to a separate local disposable-capable cluster, retention/storage/upload passed 24/24, 14/14 and 31/31.
- E2E `central-calendar-k2c3` passed 4/4 on both main and P1 without an application change.
- The E2E Pages setup failures were fixed and the final Page file passed 7/7.
- `imports-period` was intermittent: main had both 4/4 and 3/4 runs; its mouse-drag failure also appeared on P1. One P1 rerun additionally observed the phone focus assertion. The final P1 reruns passed 4/4, including on the updated main. No GPS file was changed by P1.

The uninterrupted full disposable and E2E sets have **not** been repeated after the final main integration. The reviewer/independent Linux gate on the frozen merge preview is still required.

## Actual mutations

| Mutation | Result |
| --- | --- |
| Remove Page-parent intersection | Killed by access tests |
| Replace manage permission with view permission | Killed by access tests |
| Omit Page identity/defaults from the preview fingerprint | Killed by the token-binding test |
| Remove the independent data-workspace gate | Initially survived because the fixture selected an unavailable workspace; after granting the real club role before switching workspace, killed by the specific workspace test |

Other planned mutations were not executed and are not claimed as covered. Every mutated source file was restored before the final checks.

## Operator boundaries

See the v90/v91 runbooks. A is a separately ordered compatible deployment; B is another order. Normal application startup must not install another pending independent migration under the B order. Every old instance must be drained before activation. Never delete receipts or bypass rollback refusals to make rollback succeed.

Not performed: production preflight/application/postcheck/activation/deploy; owner PG17.6 rehearsal; Linux validation. Broad rewriting of unrelated line endings was not performed. Screenshots below are repository review evidence, not GitHub comment attachments.

## Visual evidence

[360 px screenshot](dashboard-pages-p1-evidence/pages-360.png)

390 px:

![Pages at 390 px](dashboard-pages-p1-evidence/pages-390.png)

1280 px:

![Pages at 1280 px](dashboard-pages-p1-evidence/pages-1280.png)

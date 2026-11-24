# P2 validation evidence — not a freeze notice

Final base: b1b4a8ea36770a990919e3e1522b4ed9657fb032. Final revalidation: 2026-11-24.
The earlier whole-package runs below used main e0417733; this distinction is intentional.
Local environment: Windows, PostgreSQL 17.11, Node 22.22.0, Chrome 158.0.8127.36.
All database writes in this packet use self-created optimove_tests_* databases on
owned loopback PostgreSQL clusters. No production access, migration or deploy.

## Migration and old-server compatibility

Migration: migrations_v2/202611261000_training_load_v94_chart_shapes.sql.
SHA256: 2c018c784ace8edc1cb0c9b729d5e0143166d813477899f678060d6c6ac304cb.

- node backend/scripts/dashboard-chart-shapes-v94-rehearsal.mjs --port 55442 --pg-bin "C:/Program Files/PostgreSQL/17/bin"
- npx --yes --package=node@20 node backend/scripts/dashboard-chart-shapes-v94-rehearsal.mjs --port 55442 --pg-bin "C:/Program Files/PostgreSQL/17/bin"

Both RESULT: PASS: 8 suites, 47 tests (15 + 3 + 2 + 1 + 2 + 6 + 10 + 8).
Actual runtimes: Node 22.22.0 and Node 20.20.2, PostgreSQL 17.11.
The Windows .ps1 wrapper also returns RESULT: PASS with Node 20.20.2 (47/47).
The final eight tests run the previous production build
3cf0f7f92ec82ee75ed470149c9ab688c1fd384b against the migrated schema.
The migration suite executes the actual owner staging CLI, rollback SQL, catalog
equality and reapply, and the changed-body / later-migration / real-use refusals.
Recorded-order staging covers both optional slots. On the final base, actual v93
is present and both Node20 and Node22 rehearsals pass 47/47 again. The v94-only
CLI test also proves it records only v94 when v93 is pending (6/6). v92 is absent;
its future body is not claimed tested.

## Whole frontend comparison

node scripts/test-runner.mjs --preset frontend-fast

Final full run on b1b4a8ea: P2 307 files (280 pass, 4 known-fail, 23 fail),
4204 pass / 61 fail. Clean main: 304 files (277 pass, 4 known-fail, 23 fail),
4181 pass / 61 fail. Same failing tests and messages, normalizing only the
worktree name in a Windows ENOENT path. All latest dashboard tests are included.

## Backend-fast comparison

node scripts/test-runner.mjs --preset backend-fast

P2: 69 files, 63 pass / 6 fail; 678 pass / 89 fail.
Clean main e0417733: 64 files, 58 pass / 6 fail; 655 pass / 89 fail.
The six failures match: gpexe-client (17/2), gpexe-rest-v1-adapter-reads (14/83),
legacy-schema-generator (12/1), participant-session-types-v89-rehearsal-guards (3/1),
permissions-r1 (25/1), session-types-v85-rehearsal-guards (2/1).
No known-failure manifest entry is added or widened by P2.

## Browser and PDF

node scripts/test-runner.mjs --project e2e --file dashboard-gallery.test.mjs

Final targeted browser run: 8/8 pass. Real saved charts, mobile editor at
360/375/390, 1280 px desktop, preview/save, legend actions, explicit period apply,
remembered disclosure, Page navigation, PDF ordering / expanded tables only,
coach and club-admin DOM without identifiers or technical payload, and changing
an existing gallery widget into a table. The existing Pages and Simple browser
files also pass 7/7 and 10/10 in the whole preset.

PDF raster inspection found and fixed two issues: scrolling legends were truncated,
and Chrome dropped a table at an automatic page boundary. PDF now has full static
legends and separate table sheets. The regenerated report contains 12 A4 pages;
all chart/table headings and contents are present. Controls and collapsed data are
excluded. A separate 250-row print probe spans 8 pages: every row is present and
every page repeats Series / Bucket headers (checked with pypdf).

## Mutations

DATABASE_URL=loopback-maintenance-url node backend/scripts/dashboard-gallery-mutations.mjs
(The same environment variable uses normal PowerShell syntax on Windows.)

13 mutations killed; controls pass; none survived:

- duplicate candidate chosen as a winner;
- conflict flag ignored;
- missing component becomes zero;
- ratio component accepted in a stack;
- scatter paired by row position;
- incompatible combined-axis units accepted;
- athlete bound removed;
- collapsed tables printed;
- static legend omitted;
- stale workspace/page/filter period action accepted;
- stored legend toggle ignored;
- installed SQL shape validator always returns true;
- installed SQL combined-axis guard disabled.

The SQL probes change installed bodies inside a disposable database and test
functional refusals; they do not merely trip the stored checksum gate.

## Whole disposable package

node scripts/test-runner.mjs --project backend --kind disposable

197 files: 183 pass, 13 fail, 1 crash. Runner totals: 3537 passed / 21 failed of
3559. No timeout or did-not-exit. Cleanup audit: no leftover databases and no
maintenance-database writes. The dashboard suite runs on v94 and passes 154/154;
Pages migration 18/18, legacy-server 16/16, ratio 17/17, shell filter 9/9.

The long run started before main #743 was merged. Its calendar identity fixture
failed 2/9 before that merge; re-run on the merged final code is 11/11 (also
11/11 on clean main). This is reported as a follow-up, not silently removed from
the original whole-package totals.

All other failing files were run separately on clean e0417733:

| File | Clean-main result | Comparison |
| --- | --- | --- |
| app-error-events-v70 | 9/1 | Same failed test and message. |
| app-error-events-v73 | 5/1 | Same failed test and message. |
| athlete-positions-v87-rehearsal-guards | 3/1 | Same failed test and message. |
| calculated-variables-v79 | 5/1 | Same rollback restored-body-md5 failure; the first reported differing predecessor body varies. This fixture stops at v79, before P2. |
| central-calendar-k2b-1d2 | 10/1 | Same failed test and message. |
| gpexe-pair-suggestions-u3 | 8/1 | Same failed test and message. |
| gpexe-subset-import-j20b | 18/1 | Same failed test and message. |
| manual-values-v88-rehearsal-guards | 3/1 | Same failed test and message. |
| permission-roles-v84-rehearsal-guards | 2/1 | Same failed test and message. |
| source-field-create-g1 | 14/1 | Same failed test and message. |
| source-revision-lifecycle-v39 | 18/1 | Same failed test and message. |
| undo-by-importer-v76 | 17/1 | Same failed test and message. |

Command for every row: node scripts/test-runner.mjs --project backend --file
<the listed name>.test.mjs. Windows shell/line-ending assumptions in existing
runbooks/guard tests are not fixed or suppressed in this P2 PR.

gpexe-backup-verify initially crashed because pg_dump was on PATH but sh was not.
A baseline attempt without PG tools skipped its tool-dependent cases, which was
not an equivalent comparison. Re-ran BOTH worktrees with PG_BIN explicitly set
to the same PostgreSQL17 directory: each reports 16 pass / 7 fail of 26, the same
seven remote-mode test failures. Those cases use local test fixtures; no production
source was contacted. The first crash remains in the raw whole-run count above.

The existing tests-athlete-device-timezone manifest entry XPASSed (26/26).
No P2 manifest entry is added or widened.

## Whole e2e and final-base follow-up

node scripts/test-runner.mjs --preset e2e

Earlier whole run: 78 files, 77 pass / 1 fail; 407 pass / 1 fail of 408.
The single failure is tests-t2, the team-coach 390 px empty Results day waiting
for its Today action. Clean main's isolated file passed 10/10; it is NOT labelled
as a confirmed baseline failure. A first P2 repeat was interrupted by the machine's
long sleep/runtime interruption (7159-second wall time), so that result is unusable.

Final-base command:
node scripts/test-runner.mjs --project e2e --file dashboard-gallery.test.mjs --file dashboard-pages.test.mjs --file dashboard-simple.test.mjs --file tests-t2.test.mjs

All four files PASS, 35/35 (8 + 7 + 10 + 10), including that Results case.
The original whole-run failure is retained; its cause is UNKNOWN/non-reproduced.
It is not silently replaced with an all-green whole-preset claim.

The final base was merged after the overnight interruption. Conflicts were append-only
in .gitattributes and styles.css; both P2 and calendar blocks were kept. Both complete
frontend-fast runs and backend-fast runs were repeated against that exact new base;
PG17 rehearsal on actual Node20 and Node22 passed again. Build PASS (expected existing
bundle-size warning). git diff --check PASS. Migration blob SHA256 matches the manifest
and is LF. v90/v91, trainingLoadDashboardQuery.js, calculatedValues.js and GPS are unchanged.

Not run: whole disposable and whole e2e presets again after the final calendar/main
merge; the earlier complete runs and final-base focused checks are reported separately.
No Linux, production PostgreSQL17.6, persistent migration, activation, merge or deploy.
The owner/reviewers run the full gate on their final merge preview. This Draft is a
review packet, not a production GO. Final head and file list are in PR #742.

## Committed visual evidence

Synthetic local fixtures only. All 12 report pages were raster-inspected; the
250-row report was checked for complete rows and repeated headers. The gallery
fixture uses the existing allowed chart height 8 for a readable full-dashboard
capture; mobile editor screenshots are actual 360/375/390 px viewports.

- [Dashboard at 1280 px](dashboard-gallery-p2-evidence/gallery-1280.png)
- [Editor at 360 px](dashboard-gallery-p2-evidence/gallery-editor-360.png)
- [Editor at 375 px](dashboard-gallery-p2-evidence/gallery-editor-375.png)
- [Editor at 390 px](dashboard-gallery-p2-evidence/gallery-editor-390.png)
- [Current Page PDF, expanded tables only](dashboard-gallery-p2-evidence/gallery.pdf)
- [250-row pagination probe](dashboard-gallery-p2-evidence/gallery-long-table.pdf)
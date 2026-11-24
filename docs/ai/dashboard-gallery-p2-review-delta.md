# #742 conditional-review delta

Reviewed head: b4a68077d047393477b6850009c540285536e8ad. No main rebase/merge or new screen.
The only application change is PDF SVG preparation; the remaining changes are tests,
test tooling and evidence. React/React foundation is untouched.

## v94 stays byte-identical

SHA256: 2c018c784ace8edc1cb0c9b729d5e0143166d813477899f678060d6c6ac304cb.
The migration matches the reviewed Git blob byte for byte. No SQL/runbook/manifest
body changed, so the owner's previous v94 rehearsal remains applicable.

## M-1 and M-2: functional post-apply mutations

Normal dashboard-gallery-v94-disposable: 9/9. Every new refusal uses the sanctioned
update_widget_content_with_presentation write and COMMIT, rather than calling the
assert function directly. Heatmap/boxplot uses sum (refused); mixed scope uses a
scatter to avoid masking by axis validation. Axis-assignment now uses equal units,
so the existing mismatch test no longer doubles as a unit test.

For same-axis units, both series start as min/min on primary. The sanctioned write
passes the existing immediate unit guard; a prepared metric version becomes current
before COMMIT (min/AU). The deferred v94 guard must catch this. It models a metadata
change between immediate validation and deferred validation without disabling any
trigger, legacy guard, or changing session_replication_role.

Each mutant is CREATE OR REPLACE of the installed function AFTER the unmodified
migration has passed its actual apply, postcheck, rollback, catalog comparison and
reapply. That first test must PASS in each mutant run. The mutation run then executes
only the named functional target; unrelated rollback/md5 tests are skipped only in
this explicit mutation mode to avoid an aborted transaction masking the target.
The normal run has no skipped tests. A checksum/fixture error is NOT accepted as KILLED.

| Installed-body mutation | Exact test that killed it | Functional failure |
| --- | --- | --- |
| sql-shape-validation | SQL/JS shape allow-lists agree on every gallery form and invalid unions | shape validation: null |
| sql-axis-assignment | combined axis assignment accepts labelled compatible axes and refuses a false axis claim | Missing expected rejection. |
| sql-measurements | DB write refuses aggregated heatmap and boxplot values | Missing expected rejection. |
| sql-scope | DB write refuses mixed data scope levels | Missing expected rejection. |
| sql-axis-units | DB write refuses different units on the same combined axis | Missing expected rejection. |

All five runs: unmodifiedMigrationTestPassed=true, installedAfterApply=true.
Complete reproducible tool: 16 mutants KILLED, 5 controls PASS, 0 survived.
This replaces the original SQL attribution of the 13-mutation packet; it is not an
additional claim based on editing the migration file. Machine-readable evidence:
[review-mutations.json](dashboard-gallery-p2-review-mutations.json).

## LOW L-1

The test reads and executes the owner's preflight unchanged, without string replacement
or a rewritten activity predicate. quiet_moment is checked against the same preflight's
reported active transactions. False stays false; a concurrent rehearsal does not
pretend to authorize a production deployment. A separate test holds another client
transaction and proves the untouched preflight reports its PID and quiet_moment=false.
All other preflight/postcheck booleans are still required true. Pages suite: 19/19.

## LOW L-2

Live SVG strings never enter same-origin report innerHTML. An inert XML DOMParser
parses them; a strict SVG element/attribute/style allow-list removes scripts,
foreignObject, event handlers, external references and active content BEFORE import
into the popup. Local clip/gradient references, typography and geometry survive.
Malformed XML, doctypes/entities and processing instructions are refused.

Both printSvg and outerHTML paths are tested. The real browser checks no script runs
and no request to the hostile test origin occurs. The report still has 12 pages and
identical extracted text; area/bar and scatter pages were raster-inspected after the
change. No new editor or chart screen was built.

## Commands and actual results (Node22.22.0, PG17.11, Chrome158, Windows)

- node scripts/test-runner.mjs --project backend --file dashboard-gallery-v94-disposable.test.mjs: 9/9.
- node backend/scripts/dashboard-gallery-mutations.mjs (DATABASE_URL local maintenance postgres): 16 KILLED, 5 PASS controls.
- node scripts/test-runner.mjs --project backend --file dashboard-pages-migration.test.mjs: 19/19.
- node backend/scripts/dashboard-chart-shapes-v94-rehearsal.mjs --port 55440 --pg-bin "C:/Program Files/PostgreSQL/17/bin": eight suites, 50/50, RESULT: PASS.
- node scripts/test-runner.mjs --project frontend --file training-load-dashboard-print.test.mjs: 9/9.
- node scripts/test-runner.mjs --project e2e --file dashboard-gallery.test.mjs: 9/9, also repeated for temporary PDF evidence: 9/9.
- node scripts/test-runner.mjs --preset frontend-fast: head 307 files, 280 pass / 4 known-fail / 23 fail; 4207 pass / 61 fail. Clean reviewed main b1b4a8ea: 304 files, 277 pass / 4 known-fail / 23 fail; 4181 pass / 61 fail. Failure-detail comparison recorded separately below.
- npm --prefix frontend run build: PASS; expected bundle-size warning.

Not rerun for this narrow delta: whole backend disposable, backend-fast, whole e2e,
Node20, Linux or production. Earlier whole-package limits remain in the original
validation document. No production access, persistent migration, merge or deploy.

Frontend comparison: all failed test names/messages match the clean reviewed base,
normalizing only the worktree directory in the known Windows ENOENT path.

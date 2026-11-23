# P2 validation evidence — not a freeze notice

Candidate includes main e0417733fb6be0b1e190deca62b5cdbb6769e7b5. Date: 2026-11-23.
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
The final eight tests run the previous production build
3cf0f7f92ec82ee75ed470149c9ab688c1fd384b against the migrated schema.
The migration suite executes the actual owner staging CLI, rollback SQL, catalog
equality and reapply, and the changed-body / later-migration / real-use refusals.
v92/v93 recorded-order staging is simulated; their actual SQL is not present in
this base, so no claim is made about executing those future migration bodies.

## Whole frontend comparison

node scripts/test-runner.mjs --preset frontend-fast

At the first post-merge candidate: P2 305 files (278 pass, 4 known-fail, 23 fail),
4179 pass / 61 fail. Clean main e0417733: 302 files (275 pass, 4 known-fail,
23 fail), 4162 pass / 61 fail. Failing filenames match exactly. A later guard
for opaque presentation and interaction context requires the final repeat below.

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

Initial six tests pass: real saved charts, mobile editor 360/390, preview/save,
legend actions, explicit period apply, remembered disclosure, Page navigation,
PDF ordering / expanded tables only, coach and club-admin DOM without identifiers
or technical payload. Final suite also adds 375 px and 1280 px evidence.

PDF raster inspection found and fixed two issues: scrolling legends were truncated,
and Chrome dropped a table at an automatic page boundary. PDF now has full static
legends and separate table sheets. The regenerated report contains 12 A4 pages;
all chart/table headings and contents are present. Controls and collapsed data are
excluded. A separate 250-row print probe spans 8 pages: every row is present and
every page repeats Series / Bucket headers (checked with pypdf).

## Mutations

DATABASE_URL=loopback-maintenance-url node backend/scripts/dashboard-gallery-mutations.mjs
(The same environment variable uses normal PowerShell syntax on Windows.)

11 mutations killed; controls pass; none survived:

- duplicate candidate chosen as a winner;
- conflict flag ignored;
- missing component becomes zero;
- ratio component accepted in a stack;
- scatter paired by row position;
- incompatible combined-axis units accepted;
- athlete bound removed;
- collapsed tables printed;
- static legend omitted;
- installed SQL shape validator always returns true;
- installed SQL combined-axis guard disabled.

The SQL probes change installed bodies inside a disposable database and test
functional refusals; they do not merely trip the stored checksum gate.

## Final completion record

Pending: whole disposable and whole e2e packages, final frontend repeat after the
last guards, final artifact refresh and frozen-head PR packet. Until recorded here,
this document is not a claim that those packages are green or that #742 is frozen.
No Linux, production PG17.6 or production activation was run locally.
The owner and both reviewers still control review, migration order and deployment.

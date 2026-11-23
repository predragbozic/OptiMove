# Dashboard gallery v94 — owner-operated deployment and rollback

Level: RISKY. This packet is not a production order. Two reviews and the owner's
order naming `migrations_v2/202611261000_training_load_v94_chart_shapes.sql` are required.

## Scope and compatibility

v94 extends the v71 presentation validator with seven chart shapes. It replaces only
four predecessor functions: dashboard_presentation_valid, dashboard_presentation_assert_compatible,
copy_dashboard_page_widget and save_simple_widget. Each replacement has a predecessor
prosrc md5 gate. It adds nine helpers, a small immutable usage-evidence table and five
triggers. It rewrites no existing widget, series, Page, filter, receipt or revision.
The schema runner owns the transaction. lock_timeout is 5 seconds; statement_timeout
is 30 seconds. Creating triggers takes table locks until commit, so use a quiet moment.
No trigger is disabled and session_replication_role is never used.

Required: the exact deployed v91 checksum 1da5706c418c0f3262d6a88689e8d1355247a97d7d31bad4a82a59d396c52247,
which transitively requires v90. v92 (roles) and v93 (calendar) are unrelated and can
be absent or recorded in either merge order. There is no highest-label prerequisite.
Their SQL files were not present in the initial main used here; their implementations
are not claimed tested by the simulated staging-order tests. The final merge preview
must contain no duplicate migration prefix.

Before the server switch, an older binary cannot author chartShape: its JS schema
rejects the field. Ordinary widgets and old Simple requests keep their behavior and
hashes. New code advertises the gallery only when its database marker exists and the
existing Simple platform-pilot gate serves the caller. No new audience, role check,
route group or permission is introduced. Staff can read a saved chart under unchanged
dashboard/data-workspace rules. Existing shell narrowing, ratio/source/coverage rules
and athlete restrictions are preserved by reusing the existing authorized query.

## Local rehearsal

Use Node 20 or newer and PostgreSQL 17; the probe prints the actual versions and
loopback host/port. No persistent database name or remote host is accepted. Each suite
creates and drops its own uniquely named disposable database. Keep other gates on a
separate PostgreSQL instance so the cleanup audit remains unambiguous.

```powershell
./backend/scripts/dashboard-chart-shapes-v94-rehearsal.ps1 -Port 5432 -PgBin 'C:/Program Files/PostgreSQL/17/bin'
```

```sh
./backend/scripts/dashboard-chart-shapes-v94-rehearsal.sh --port 5432 --pg-bin /path/to/pg17/bin
```

Both wrappers invoke dashboard-chart-shapes-v94-rehearsal.mjs. They do not require
Node major 22. The default previous deployed build is 3cf0f7f92ec82ee75ed470149c9ab688c1fd384b;
use `--old-build <owner-confirmed-full-SHA>` / `-OldBuild` if production changes.
Success is the final RESULT: PASS, after all eight suites. These include real HTTP
preview/save/replay, Page query/copy, cloning, actual runbook rollback/catalog equality,
and previous-server request replay against v94. Browser/PDF QA is an additional gate.

## Preflight, application, postcheck

1. Record the reviewed head and compare the file SHA256 to
   dashboard-chart-shapes-v94-manifest.json. Confirm the current registry with the
   reviewer. Verify the database connection target read-only. Keep existing audience
   and activation settings as ordered; this migration does not turn Pages on.
2. Run dashboard-chart-shapes-v94-preflight.sql read-only. Every boolean must be true.
   Save counts and complete row digests, both overall and per dashboard, privately.
   It checks the four live predecessor bodies. An unexpected body requires a decision;
   do not change the expected md5 to make preflight pass.
3. After the owner's explicit single-file order, run the v94-only artifact:

   `node backend/scripts/dashboard-gallery-stage.mjs --apply 202611261000_training_load_v94_chart_shapes.sql`

   It prints the connected host/port/database, requires the exact already-recorded
   v91, includes checksum-verified recorded files, and admits only v94 as a new file.
   Unrecorded files including v92/v93 are omitted. It never orders those tracks.
4. Run dashboard-chart-shapes-v94-postcheck.sql. All booleans must be true: exactly one
   record/checksum, all thirteen owned function bodies, all five triggers enabled.
   Compare the complete widget/series digests to preflight: they must be unchanged.
5. Deploy the reviewed server/frontend through the owner's normal process. Before
   normal npm start, v94 must not cause an unrelated pending migration to run under
   this order. Review any other pending file under its own order first. Verify health,
   ordinary Home and selected-Page reads, and one pilot preview/save on authorized data.
   The gallery capability is conditional on both the installed schema and the existing
   pilot; no separate automatic widening is included.

## Rollback boundary

Withdraw the new writer binary/entry first. Run dashboard-chart-shapes-v94-rollback.sql
only under a separate owner order. It refuses a changed checksum, any changed owned
function, a later recorded migration, or ANY real gallery use. After domain table locks
it checks the immutable usage evidence, so an in-flight write either commits and blocks
rollback or loses the race to the locks. Widget/dashboard deletion or changing back to
Standard never erases that evidence. Do not delete data, disable guards or purge evidence
to force rollback. After real use, the route is a reviewed forward correction.

With no use, rollback removes only v94 objects, restores all four predecessor bodies
verbatim and verifies their md5s before commit. It deletes exactly the v94 migration
record. Catalog equality and reapplication are tested. Remove the v94 artifact from the
old deployment before restart so a runner does not immediately reinstall it.

The evidence table has one insert per widget ever using a shape, not per request or
preview. It deliberately has no widget FK and no retention purge: it is structural
rollback evidence that must survive deletion, not an expiring request ledger. UPDATE,
DELETE and TRUNCATE are refused. It has no API read path and changes no user rights.

## UI and data contract

Area, horizontal bar, heatmap and box plot are available in the one-metric Simple
flow; combined/scatter/declared stacks use the existing staged Advanced editor. Several
metrics in a Simple table remain a later contract. An Advanced series edit can retain
partial successful changes under its existing recovery contract; the gallery sidecar
is cleared before changed bindings and installed only after current identities are
known. The editor reports retained changes after a failure. Simple and copy stay atomic.

No interpolation, duplicate winner or null-as-zero is used. Scatter pairs exact
athlete/bucket/grain identities. Units on a shared axis must match; combined axes are
explicit. Stack parts are declared, share a known unit, and cannot be ratios/percentages,
duplicated variables, or a calculated total with one of its selected inputs. Heatmap
and box plot use separate returned athlete values (Each measurement); repeated athlete
cells are omitted and counted. A box is a distribution of those returned values, with
(n-1)*p interpolated quartiles and 1.5 IQR whiskers/outliers, not unseen raw samples.

PDF exports only the selected visible Page, in current visual order, and only expanded
value tables. Tables move to a next sheet when needed; long tables repeat headers.
The report includes full static names instead of interactive legend paging, no buttons,
sliders, hidden details, technical JSON or internal ids. Displayed series visibility is
preserved. Personal period changes require the explicit Apply selected period action.
P3 references/target tables/Radar and multi-variable Simple tables are not in this PR.

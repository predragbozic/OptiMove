# ADR-003: Dashboard writes go through sanctioned functions only

**Status:** Active

## Context

The Training Load dashboard subsystem has three nested, revision-guarded tables
(dashboard → widget → series). Raw INSERT/UPDATE/DELETE scattered across the app would
make revision bumping, lock ordering, and archived/template-state checks easy to get
inconsistent between call sites.

## Decision

All dashboard/widget/series mutations go through a fixed set of sanctioned Postgres
functions, each locking rows in a fixed order: **dashboard → widget → series**. There is
exactly one documented, explicit exception: `cloneDashboard()`, which composes a raw
multi-table INSERT inside its own transaction because cloning creates new rows across all
three tables atomically in a shape the per-row sanctioned functions don't cover.

## Exact contracts

Which tables this contract actually covers:

- **Three core hierarchical tables** (`training_load.dashboards` →
  `training_load.dashboard_widgets` → `training_load.dashboard_widget_series`) — every
  application write goes through the sanctioned functions below, with exactly **one**
  documented raw-SQL exception: `cloneDashboard()`.
- **`training_load.dashboard_active_selection`** (the per-user/per-workspace "which
  dashboard is active" pointer — not part of the dashboard/widget/series ownership
  hierarchy) — also written exclusively through sanctioned functions
  (`set_active_dashboard`/`clear_active_dashboard`). A repo-wide grep of
  `backend/src/*.js` for any INSERT/UPDATE/DELETE against this table found none — no
  exception exists here, not even a clone-style one.
- **Not covered by this contract**: `training_load.dashboard_widget_types` and
  `training_load.dashboard_builtin_series` are read-only catalog/lookup tables from the
  application's side — populated once by the
  `migrations_v2/202609101200_training_load_v18_dashboard_catalog_seed.sql` seed
  migration, never written by any backend route or sanctioned function. There is no
  application write path to guard for these two, so "sanctioned writes only" doesn't
  apply to them in the same sense.

Functions (all in
`migrations_v2/202609101100_training_load_v17_dashboard_sanctioned_functions.sql`),
called exclusively from `backend/src/trainingLoadDashboardCatalog.js` and
`backend/src/trainingLoadDashboardWidgets.js`:

`training_load.create_dashboard()`, `training_load.update_dashboard_metadata()`,
`training_load.replace_dashboard_layout()`, `training_load.update_widget_layout()`,
`training_load.create_widget()`, `training_load.update_widget_content()`,
`training_load.delete_widget()`, `training_load.add_series()`,
`training_load.update_series()`, `training_load.resolve_series_binding()`,
`training_load.delete_series()`, `training_load.reorder_series()`,
`training_load.archive_dashboard()`, `training_load.set_active_dashboard()`,
`training_load.clear_active_dashboard()` — 15 public mutation functions — plus the
internal helper `training_load.assert_dashboard_writable(p_dashboard_id uuid)` used by
most of the above (not itself a mutation entry point, a shared guard the others call
into).

- **Lock order proof**: `update_widget_layout` locks dashboard (v17:233) then widget
  (v17:243); `add_series` locks dashboard then widget (v17:436-442); stated explicitly in
  migration comments at
  `migrations_v2/202609101000_training_load_v16_dashboard_widgets_series_selection.sql:178`
  and `:443-447`.
- **The original exception (2026-09-14)**: `cloneDashboard()` —
  `backend/src/trainingLoadDashboardCatalog.js:230-375` — raw
  `insert into training_load.dashboards` (267-269), `dashboard_widgets` (278),
  `dashboard_widget_series` (317-320, 335-338, 360-363), inside `c.query("begin")` /
  commit. Documented as deliberate in both the migration
  (`migrations_v2/202609101100_training_load_v17_dashboard_sanctioned_functions.sql:19-34`,
  "the one documented, explicit composite-transaction exception") and the JS file's own
  comment (254-266).
- No other raw UPDATE/DELETE against any of the four tables above was found in the
  backend source as of the 2026-09-14 verification pass.

## Consequences

- A new mutation on the three hierarchical tables (or `dashboard_active_selection`)
  should be added as a new sanctioned function (or an extension of an existing one), not
  a raw query from a route/service file — unless it's a genuinely new atomic-composite
  case like clone, which then needs the same explicit "documented exception" treatment: a
  comment at both the migration and the call site.
- A `db-reviewer` finding of a raw write against `dashboards`, `dashboard_widgets`,
  `dashboard_widget_series`, or `dashboard_active_selection`, outside `cloneDashboard()` or the sanctioned P1 SQL copy function documented below,
  is a real contract violation, not a false positive. A raw write against
  `dashboard_widget_types`/`dashboard_builtin_series` would be a different, new thing —
  those tables having no current write path doesn't mean one should be added casually.

## Evidence

Verified against
`migrations_v2/202609101000_training_load_v16_dashboard_widgets_series_selection.sql`,
`migrations_v2/202609101100_training_load_v17_dashboard_sanctioned_functions.sql`,
`trainingLoadDashboardCatalog.js`/`trainingLoadDashboardWidgets.js`, and a repo-wide
grep for raw writes against all four tables, in a verification pass on 2026-09-14.

## Supersedes / Superseded by

—

Dashboard Simple uses the sanctioned functions training_load.save_simple_widget,
training_load.create_widget_with_presentation, and
training_load.update_widget_content_with_presentation. The existing cloneDashboard
transaction also copies presentation_config with a raw UPDATE so an opaque sidecar
survives cloning unchanged.

## P1 Pages sanctioned writes

P1 extends the dashboard domain lock order to dashboard → Pages (UUID order) → widget → series. The live actor/session/workspace rights rows are locked before the domain rows. Existing sanctioned writers enter assert_dashboard_writable, which locks the parent and its Pages before touching widgets. The Page revision trigger is not a substitute for these locks; dashboard-pages-concurrency.test.mjs records SQL order and exercises competing writers.

New sanctioned entry points are mutate_dashboard_page, copy_dashboard_page_widget, write_dashboard_page_widget and save_simple_page_widget. The two wrappers reuse existing widget/series and v71 atomic-save functions under a transaction-bound Page context. New retention entry point cleanup_dashboard_page_requests permits bounded expired-receipt deletion only. Receipt UPDATE, young DELETE and TRUNCATE are refused by guard_dashboard_page_requests. Reads and queries never create Pages.

cloneDashboard remains the documented JS raw-write exception; the sanctioned SQL copy function is the second composite INSERT implementation (see below). It locks the source dashboard, Pages, widgets and series before copying; a dashboard INSERT creates Home in ensure_dashboard_home with the exact default_filter. The new clone maps each source Page to a new Page identity and copies widget/series contents and presentation unchanged. The database activation barrier prevents a second Page while the previous binary can serve. Whole-dashboard deletion uses the sanctioned v19 function, Page cascade and exactly one existing deletion-log entry. Direct Home deletion is refused.

P1 copy is the second explicit composite raw-INSERT implementation, alongside cloneDashboard: sanctioned SQL function training_load.copy_dashboard_page_widget inserts dashboard_widgets and dashboard_widget_series inside its atomic transaction, under dashboard -> Pages -> widget -> series locks and all v16/v17/v71 validation triggers. This does not authorize raw INSERTs in Page routes/services. The copy receipt and the inserts commit together.

Simple request locking precedes the domain hierarchy: save_simple_page_widget takes the same dashboard-simple:<actor>:<request> advisory lock as save_simple_widget before dashboard/Page locks; the nested acquisition is reentrant in the transaction.

## P2 chart shapes (v94)

The four replaced sanctioned/validation bodies are dashboard_presentation_valid,
dashboard_presentation_assert_compatible, copy_dashboard_page_widget and
save_simple_widget. Save and copy keep their existing advisory-first and
 dashboard -> Pages -> widget -> series order. They remap only known schemaVersion=1
chartShape series identities after new series are created; deferred validation checks
final references and catalog units. No new route performs a raw write.

cloneDashboard remains the documented JS composite exception: gallery series bindings
are remapped to the new identities after the series batch. Ordinary and opaque future
sidecars still copy inside PostgreSQL, preserving JSON numeric precision. The sanctioned
SQL copy function is the other documented composite INSERT implementation; its additional
presentation UPDATE stays in the same transaction and receipt protocol. The append-only
chart-use evidence survives deletion and blocks v94 rollback after use. No new access
right or athlete/fact source is introduced.

## P3 references (v97)

Reference-table writes use mutate_dashboard_reference, under the existing canonical-variable admin basis. save_dashboard_reference_binding uses the existing dashboard manage/data-workspace checks in the route, rechecks the canonical-variable actor basis in PostgreSQL and calls update_widget_content_with_presentation. It takes the request advisory lock before dashboard -> Page -> widget -> ordered series locks. No reference route performs a raw dashboard write. cleanup_dashboard_reference_requests deletes expired receipts only in bounded batches from the existing retention schedule; receipts cannot be updated or truncated. Table/widget usage evidence survives receipt retention and prevents rollback after use.

The replaced presentation validators and gallery remapper retain the exact v94 bodies as gated helpers. Known reference axes are remapped alongside gallery axes by both sanctioned Page copy and cloneDashboard's documented composite raw-write exception. Published table versions remain pinned; copying never grants permission to their club.

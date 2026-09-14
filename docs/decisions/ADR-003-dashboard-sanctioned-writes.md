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
- **The one exception**: `cloneDashboard()` —
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
  `dashboard_widget_series`, or `dashboard_active_selection`, outside `cloneDashboard()`,
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

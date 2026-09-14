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

Functions (all in `migrations_v2/..._v17_dashboard_sanctioned_functions.sql`), called
exclusively from `backend/src/trainingLoadDashboardCatalog.js` and
`backend/src/trainingLoadDashboardWidgets.js`:

`create_dashboard`, `update_dashboard_metadata`, `replace_dashboard_layout`,
`update_widget_layout`, `create_widget`, `update_widget_content`, `delete_widget`,
`add_series`, `update_series`, `resolve_series_binding`, `delete_series`,
`reorder_series`, `archive_dashboard`, `set_active_dashboard`, `clear_active_dashboard`,
plus the internal helper `assert_dashboard_writable(p_dashboard_id uuid)` used by most of
the above.

- **Lock order proof**: `update_widget_layout` locks dashboard (v17:233) then widget
  (v17:243); `add_series` locks dashboard then widget (v17:436-442); stated explicitly in
  migration comments at `..._v16_...:178` and `:443-447`.
- **The one exception**: `cloneDashboard()` —
  `backend/src/trainingLoadDashboardCatalog.js:230-375` — raw
  `insert into training_load.dashboards` (267-269), `dashboard_widgets` (278),
  `dashboard_widget_series` (317-320, 335-338, 360-363), inside `c.query("begin")` /
  commit. Documented as deliberate in both the migration
  (`..._v17_...:19-34`, "the one documented, explicit composite-transaction exception")
  and the JS file's own comment (254-266).
- No other raw UPDATE/DELETE against these three tables was found in the backend source
  as of the 2026-09-14 verification pass.

## Consequences

- A new mutation on these tables should be added as a new sanctioned function (or an
  extension of an existing one), not a raw query from a route/service file — unless it's
  a genuinely new atomic-composite case like clone, which then needs the same explicit
  "documented exception" treatment: a comment at both the migration and the call site.
- A `db-reviewer` finding of a raw write against one of these six tables, outside
  `cloneDashboard()`, is a real contract violation, not a false positive.

## Evidence

Verified against `migrations_v2/..._v16_...sql`, `..._v17_...sql`, and
`trainingLoadDashboardCatalog.js`/`trainingLoadDashboardWidgets.js`, in a research pass
on 2026-09-14.

## Supersedes / Superseded by

—

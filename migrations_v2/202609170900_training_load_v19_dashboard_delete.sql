-- Training Load dashboard v19: permanent delete.
--
-- The one sanctioned write path this adds: training_load.delete_dashboard().
-- No table/column change - this migration is function-only.
--
-- FK relations to training_load.dashboards(id), verified against v15-v18
-- (the only three that exist):
--   1. dashboard_widgets.dashboard_id       ON DELETE CASCADE  (v16) - the
--      widgets, and via dashboard_widget_series.widget_id (also CASCADE,
--      v16) every series, disappear automatically with the dashboard row.
--      No explicit cleanup needed for either.
--   2. dashboard_active_selection.dashboard_id ON DELETE RESTRICT (v16) -
--      deliberately NOT cascade (see that migration's own comment: a
--      silent cascade here would let an unrelated permanent delete quietly
--      wipe someone's "active dashboard" pointer without ever going
--      through the archive trigger's own explicit clearing logic). This
--      function clears every matching row itself, in the SAME transaction,
--      BEFORE the delete - potentially several rows for a shared club/team
--      dashboard (each viewer's own active-selection row).
--   3. dashboards.cloned_from_dashboard_id ON DELETE RESTRICT (v15,
--      self-referencing) - cloned_from_dashboard_id is immutable after
--      creation (v15's own trigger forbids ever setting it back to null),
--      so a dashboard that has been cloned from CANNOT be permanently
--      deleted without breaking that immutability guarantee or the
--      lineage the RESTRICT protects. Deliberately NOT worked around here:
--      the final DELETE simply fails with a real foreign_key_violation
--      (23503) when clones exist, which the service layer
--      (trainingLoadDashboardCatalog.js) catches and turns into a clean
--      409 "dashboardHasClones" - Archive remains the correct action for
--      a dashboard that must stay available as a clone source.
--
-- Deliberately exempt from assert_dashboard_writable(): deleting an
-- ARCHIVED dashboard must work (arguably the main real use case - Archive
-- is the reversible "soft" action, Delete the irreversible follow-up), and
-- an ACTIVE dashboard can be deleted too (case 2 above handles the active-
-- selection side of that). Ownership authorization (only a manager may
-- delete; system templates may NEVER be deleted, no exception) is an
-- application-layer decision, same convention as every other owner_scope
-- check in this subsystem - not duplicated here.
-- The out-parameter is deliberately PREFIXED (out_dashboard_id), never the
-- bare column name dashboard_id - the same convention set_active_dashboard()
-- documents (v17): a bare `dashboard_id` out-parameter makes the
-- `where dashboard_id = p_dashboard_id` reference below ambiguous between
-- the variable and dashboard_active_selection's own column.
create function training_load.delete_dashboard(p_dashboard_id uuid, p_expected_revision integer)
returns table (out_dashboard_id uuid) as $$
declare
  v_current_revision integer;
begin
  select revision into v_current_revision from training_load.dashboards where id = p_dashboard_id for update;
  if not found then
    -- P0002 (no_data_found), not a bare P0001: the route maps a bare
    -- P0001 to 400 invalidRequest, but a dashboard deleted by a concurrent
    -- request while this one waited on the row lock must read as 404, the
    -- same as any other dashboard that no longer exists.
    raise exception 'delete_dashboard: dashboard % not found', p_dashboard_id using errcode = 'P0002';
  end if;
  if v_current_revision <> p_expected_revision then
    raise exception 'delete_dashboard: stale revision (expected %, dashboard is at %) — reload and retry', p_expected_revision, v_current_revision using errcode = '40001';
  end if;
  delete from training_load.dashboard_active_selection where dashboard_id = p_dashboard_id;
  -- The cascade fires v16's after-delete triggers on each widget/series,
  -- which call bump_dashboard_revision()/bump the parent widget. Their
  -- UPDATE targets a row this same transaction just deleted, so it simply
  -- matches 0 rows - no error, no cross-transaction conflict (db-reviewer).
  delete from training_load.dashboards where id = p_dashboard_id;
  return query select p_dashboard_id;
end;
$$ language plpgsql;

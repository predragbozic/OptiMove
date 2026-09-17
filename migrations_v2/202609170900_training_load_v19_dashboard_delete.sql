-- Training Load dashboard v19: permanent delete + deletion log.
--
-- Adds the one sanctioned write path training_load.delete_dashboard() and
-- the append-only table training_load.dashboard_deletion_log it writes to.
-- No change to any existing table.
--
-- Product decision (2026-09-17, option (c)): anyone who may manage a
-- dashboard - a platform admin included, even for another user's private
-- dashboard - keeps the right to delete it permanently, but EVERY permanent
-- delete is recorded: who deleted it, on what authority, what it was
-- (identity, ownership, workspace, size) and when.
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
-- check in this subsystem. The one database-level backstop is the deletion
-- log's owner_scope CHECK below: a system row reaching delete_dashboard()
-- fails there and the whole delete rolls back.

-- ------------------------------------------------------------
-- Deletion log.
-- ------------------------------------------------------------
-- One row per permanent delete made through delete_dashboard(), written in
-- the SAME transaction as the delete: a delete that is refused or rolls
-- back (stale revision, a clone still pointing at it, a concurrent delete)
-- leaves no row, and every delete that commits through the function has
-- exactly one. Scope of that guarantee (code-reviewer): a raw
-- `delete from training_load.dashboards` outside the sanctioned function is
-- NOT logged - out of contract per ADR-003 (sanctioned write paths only),
-- the same as every other raw write to these tables; and append-only is
-- trigger-enforced, not privilege-enforced (the table owner or a superuser
-- can still disable the triggers, e.g. for a deliberate retention purge).
--
-- deleted_by_user_id references public.users ON DELETE RESTRICT, like the
-- 41 other user references in this schema (the app never hard-deletes a
-- user). Everything describing the DASHBOARD is a snapshot with NO foreign
-- key: the dashboard row is gone by definition, and a historical record
-- must never block (or be erased by) the later lifecycle of a club, team
-- or user it mentions.
--
-- owner_scope excludes 'system': system templates can never be deleted
-- (enforced in the service layer); this CHECK is the database-level
-- backstop - a system row reaching delete_dashboard() fails on the insert
-- and the whole delete rolls back.
create table training_load.dashboard_deletion_log (
  id uuid primary key default gen_random_uuid(),
  deleted_at timestamptz not null default now(),
  deleted_by_user_id uuid not null references public.users(id) on delete restrict,
  -- On what authority the delete was allowed, most specific first (an
  -- admin who is also the owner is recorded as 'owner'); 'platform_admin'
  -- means the platform-admin override was the ONLY basis.
  authorized_via varchar(20) not null check (authorized_via in ('owner', 'club_admin', 'team_coach', 'platform_admin')),
  dashboard_id uuid not null,
  dashboard_name text not null,
  owner_scope varchar(20) not null check (owner_scope in ('user', 'club', 'team')),
  owner_user_id uuid,
  owner_club_id uuid,
  owner_team_id uuid,
  data_workspace_type varchar(20) check (data_workspace_type in ('platform', 'private_coach', 'club', 'team', 'athlete')),
  data_workspace_scope_id uuid,
  is_template boolean not null,
  status varchar(20) not null check (status in ('active', 'archived')),
  revision integer not null,
  widget_count integer not null check (widget_count >= 0),
  series_count integer not null check (series_count >= 0),
  dashboard_created_by_user_id uuid not null,
  dashboard_created_at timestamptz not null,
  -- The same shape rules training_load.dashboards enforces (v15), so a row
  -- written by anything other than delete_dashboard() still cannot be a
  -- malformed accountability record (db-reviewer).
  check (
    (owner_scope = 'user' and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club' and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team' and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  )
);

create index dashboard_deletion_log_deleted_by_idx on training_load.dashboard_deletion_log (deleted_by_user_id, deleted_at desc);
-- UNIQUE: a dashboard id is never reused and can be permanently deleted only
-- once, so a second record for the same id could only be a bug.
create unique index dashboard_deletion_log_dashboard_idx on training_load.dashboard_deletion_log (dashboard_id);
create index dashboard_deletion_log_deleted_at_idx on training_load.dashboard_deletion_log (deleted_at desc);

-- Append-only: a record of a permanent delete is itself never edited or
-- removed through SQL (UPDATE, DELETE and TRUNCATE all raise).
create function training_load.dashboard_deletion_log_append_only() returns trigger as $$
begin
  raise exception 'training_load.dashboard_deletion_log is append-only (% refused)', tg_op;
end;
$$ language plpgsql;

create trigger dashboard_deletion_log_no_update_delete
  before update or delete on training_load.dashboard_deletion_log
  for each row execute function training_load.dashboard_deletion_log_append_only();

create trigger dashboard_deletion_log_no_truncate
  before truncate on training_load.dashboard_deletion_log
  for each statement execute function training_load.dashboard_deletion_log_append_only();

-- ------------------------------------------------------------
-- delete_dashboard().
-- ------------------------------------------------------------
-- p_deleted_by_user_id / p_authorized_via come from the service layer,
-- which has already decided the caller may manage this dashboard
-- (canManageDashboardRow) and on what basis (dashboardManageBasis).
--
-- The out-parameter is deliberately PREFIXED (out_dashboard_id), never the
-- bare column name dashboard_id - the same convention set_active_dashboard()
-- documents (v17): a bare `dashboard_id` out-parameter makes the
-- `where dashboard_id = p_dashboard_id` reference below ambiguous between
-- the variable and dashboard_active_selection's own column.
create function training_load.delete_dashboard(
  p_dashboard_id uuid, p_expected_revision integer,
  p_deleted_by_user_id uuid, p_authorized_via varchar
) returns table (out_dashboard_id uuid, out_log_id uuid) as $$
declare
  -- %rowtype is resolved at call time: renaming/dropping one of the
  -- dashboards columns read below breaks this function on its next call,
  -- not when that later migration is applied (db-reviewer) - grep for
  -- dashboards%rowtype before changing those columns.
  v_row training_load.dashboards%rowtype;
  v_widget_count integer;
  v_series_count integer;
  v_log_id uuid;
begin
  select * into v_row from training_load.dashboards where id = p_dashboard_id for update;
  if not found then
    -- P0002 (no_data_found), not a bare P0001: the route maps a bare
    -- P0001 to 400 invalidRequest, but a dashboard deleted by a concurrent
    -- request while this one waited on the row lock must read as 404, the
    -- same as any other dashboard that no longer exists.
    raise exception 'delete_dashboard: dashboard % not found', p_dashboard_id using errcode = 'P0002';
  end if;
  if v_row.revision <> p_expected_revision then
    raise exception 'delete_dashboard: stale revision (expected %, dashboard is at %) — reload and retry', p_expected_revision, v_row.revision using errcode = '40001';
  end if;
  -- Read under the dashboard lock: every widget/series write locks the
  -- dashboard row first (ADR-003), so these counts cannot move before the
  -- delete below.
  select count(*) into v_widget_count from training_load.dashboard_widgets w where w.dashboard_id = p_dashboard_id;
  select count(*) into v_series_count from training_load.dashboard_widget_series s
    join training_load.dashboard_widgets w on w.id = s.widget_id where w.dashboard_id = p_dashboard_id;
  -- Logged BEFORE the delete, in the same transaction: if the delete
  -- below fails (e.g. 23503, a clone still references this dashboard) the
  -- log row rolls back with it.
  insert into training_load.dashboard_deletion_log (
    deleted_by_user_id, authorized_via, dashboard_id, dashboard_name, owner_scope,
    owner_user_id, owner_club_id, owner_team_id, data_workspace_type, data_workspace_scope_id,
    is_template, status, revision, widget_count, series_count,
    dashboard_created_by_user_id, dashboard_created_at
  ) values (
    p_deleted_by_user_id, p_authorized_via, v_row.id, v_row.name, v_row.owner_scope,
    v_row.owner_user_id, v_row.owner_club_id, v_row.owner_team_id, v_row.data_workspace_type, v_row.data_workspace_scope_id,
    v_row.is_template, v_row.status, v_row.revision, v_widget_count, v_series_count,
    v_row.created_by_user_id, v_row.created_at
  ) returning id into v_log_id;
  delete from training_load.dashboard_active_selection where dashboard_id = p_dashboard_id;
  -- The cascade fires v16's after-delete triggers on each widget/series,
  -- which call bump_dashboard_revision()/bump the parent widget. Their
  -- UPDATE targets a row this same transaction just deleted, so it simply
  -- matches 0 rows - no error, no cross-transaction conflict (db-reviewer).
  delete from training_load.dashboards where id = p_dashboard_id;
  return query select p_dashboard_id, v_log_id;
end;
$$ language plpgsql;

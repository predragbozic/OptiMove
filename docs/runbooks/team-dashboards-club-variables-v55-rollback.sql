-- Rollback of migration v55 (a team's dashboards may chart the variables of the team's own club; O7):
-- migrations_v2/202611041300_training_load_v55_team_dashboards_club_variables.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases
-- (backend/tests/team-dashboards-club-variables-o7.test.mjs). Before it is run anywhere real: a fresh
-- restore-verified backup exists; the deployed commit no longer contains the v55 migration file; and the owner
-- approved this database specifically (.claude/rules/database-safety.md).
--
-- It restores v16's body byte for byte and removes the v55 record. It refuses, changing nothing, when the migrator is
-- running (advisory lock 822026), v55 is not recorded, a later migrations_v2 migration is recorded, the body in force
-- is not v55's (md5), or a dashboard series already uses a club variable on a TEAM data workspace (the way forward
-- is then a new migration, never this script: restoring v16's rule would leave a series v16 would refuse).
-- One transaction: psql -v ON_ERROR_STOP=1 -f team-dashboards-club-variables-v55-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v55 rollback refused: the migrator is running';
  end if;
end $$;

-- No series is written while this script decides and restores: a series insert would otherwise slip in between the
-- refusal check below and the CREATE OR REPLACE (the lock_timeout above bounds the wait).
lock table training_load.dashboard_widget_series in share row exclusive mode;

do $$
declare
  v55 constant text := 'migrations_v2/202611041300_training_load_v55_team_dashboards_club_variables.sql';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v55) then
    raise exception 'v55 rollback refused: v55 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v55) then
    raise exception 'v55 rollback refused: later migrations are applied';
  end if;
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'dashboard_widget_series_validate_metric_visibility')
     is distinct from '4f3638000788230fc2be7dc2667ed963' then
    raise exception 'v55 rollback refused: the body in force of training_load.dashboard_widget_series_validate_metric_visibility is not v55''s';
  end if;
  if exists (select 1 from training_load.dashboard_widget_series s
               join training_load.dashboard_widgets w on w.id = s.widget_id
               join training_load.dashboards d on d.id = w.dashboard_id
               join training_load.metric_definitions md on md.id = s.metric_definition_id
              where d.data_workspace_type = 'team' and md.owner_scope = 'club') then
    raise exception 'v55 rollback refused: a team dashboard series already uses a club variable';
  end if;
end $$;

create or replace function training_load.dashboard_widget_series_validate_metric_visibility() returns trigger as $$
declare
  v_data_type varchar; v_data_scope uuid; v_dash_owner_scope varchar; v_dash_owner_user uuid;
  v_def_scope varchar; v_def_user uuid; v_def_club uuid; v_def_team uuid;
begin
  if new.metric_definition_id is null then
    return new;
  end if;
  select d.data_workspace_type, d.data_workspace_scope_id, d.owner_scope, d.owner_user_id
    into v_data_type, v_data_scope, v_dash_owner_scope, v_dash_owner_user
    from training_load.dashboard_widgets w join training_load.dashboards d on d.id = w.dashboard_id
    where w.id = new.widget_id;
  -- FOR SHARE closes "series insert vs. a concurrent ownership/current_
  -- version change on this metric_definition" — a concurrent UPDATE
  -- (ownership or a legitimate current_version_id bump) holds an implicit
  -- row lock that conflicts with this share lock, so our visibility check
  -- below is guaranteed to run against either the fully-pre-update or
  -- fully-post-update row, never a value caught mid-flight.
  select owner_scope, owner_user_id, owner_club_id, owner_team_id
    into v_def_scope, v_def_user, v_def_club, v_def_team
    from training_load.metric_definitions where id = new.metric_definition_id for share;

  if v_def_scope = 'system' then
    return new;
  end if;
  -- The dashboard owner's OWN private catalog is always visible to their
  -- own dashboards, independent of which data workspace it is bound to
  -- (a coach's personal metrics travel with them across workspaces).
  if v_dash_owner_scope = 'user' and v_def_scope = 'user' and v_def_user = v_dash_owner_user then
    return new;
  end if;
  if v_def_scope = 'club' and v_data_type = 'club' and v_def_club = v_data_scope then
    return new;
  end if;
  if v_def_scope = 'team' and v_data_type = 'team' and v_def_team = v_data_scope then
    return new;
  end if;
  raise exception 'dashboard_widget_series: metric_definition % (owner_scope=%/%/%/%) is not visible to this dashboard''s data workspace %/%',
    new.metric_definition_id, v_def_scope, v_def_club, v_def_team, v_def_user, v_data_type, v_data_scope;
end;
$$ language plpgsql;

do $$
begin
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'dashboard_widget_series_validate_metric_visibility')
     is distinct from 'f44c88a4bc05d6241cbb70a06e575475' then
    raise exception 'v55 rollback failed: the body is not v16''s after the restore';
  end if;
end $$;

delete from public.schema_migrations where migration_name = 'migrations_v2/202611041300_training_load_v55_team_dashboards_club_variables.sql';
commit;

-- v55: a team's dashboards may chart the variables of the team's own club (O7, J15 section 12; the
-- Rukovodilac's plan GO 2026-11-04).
--
-- Why: v16's trigger training_load.dashboard_widget_series_validate_metric_visibility admits a club definition
-- only on a club data workspace. After a team moves to its club's copy of an OptiMove variable, its charts of
-- OptiMove's variable get no new points and the copy cannot be charted. This adds one branch to that one function:
-- a club definition is visible to a dashboard whose data workspace is a team of that club (active team, active club).
--
-- What it changes: one function body, CREATE OR REPLACE; no table, column, trigger, index or row. Every other branch
-- and the final exception (errcode and message) are byte for byte the ones in force. Lock order: the definition FOR SHARE
-- (as before), then the team, then its club, each FOR SHARE and in separate statements.
--
-- Before anything changes it checks that the body in force is v16's (md5 of pg_proc.prosrc); after, that the body is the
-- one v55 writes. Rollback: docs/runbooks/team-dashboards-club-variables-v55-rollback.sql.

do $$
begin
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'dashboard_widget_series_validate_metric_visibility')
     is distinct from 'f44c88a4bc05d6241cbb70a06e575475' then
    raise exception 'v55 refused: the body in force of training_load.dashboard_widget_series_validate_metric_visibility is not v16''s' using errcode = '23514';
  end if;
end;
$$;

create or replace function training_load.dashboard_widget_series_validate_metric_visibility() returns trigger as $$
declare
  v_data_type varchar; v_data_scope uuid; v_dash_owner_scope varchar; v_dash_owner_user uuid;
  v_def_scope varchar; v_def_user uuid; v_def_club uuid; v_def_team uuid;
  v_team_club uuid;
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
  -- v55 (O7): a team's dashboards may use the variables of the team's own club. The team (active), then
  -- its club (active), each FOR SHARE, after the definition above: dashboard -> widget -> series, then
  -- definition -> team -> club. An archived team or club, or another club's variable, is refused by the
  -- same exception below as every other invisible definition.
  if v_def_scope = 'club' and v_data_type = 'team' then
    select t.club_id into v_team_club from public.teams t where t.id = v_data_scope and coalesce(t.is_active, true) for share;
    if found and v_team_club = v_def_club then
      perform 1 from public.clubs c where c.id = v_def_club and coalesce(c.is_active, true) for share;
      if found then
        return new;
      end if;
    end if;
  end if;
  raise exception 'dashboard_widget_series: metric_definition % (owner_scope=%/%/%/%) is not visible to this dashboard''s data workspace %/%',
    new.metric_definition_id, v_def_scope, v_def_club, v_def_team, v_def_user, v_data_type, v_data_scope;
end;
$$ language plpgsql;

do $$
begin
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'dashboard_widget_series_validate_metric_visibility')
     is distinct from '4f3638000788230fc2be7dc2667ed963' then
    raise exception 'v55 failed: the body of training_load.dashboard_widget_series_validate_metric_visibility is not the one v55 writes' using errcode = '23514';
  end if;
end;
$$;

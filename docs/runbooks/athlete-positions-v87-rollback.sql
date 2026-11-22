-- Rollback of migration v87 (athlete positions; migrations_v2/202611221200_athletes_v87_positions.sql).
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/athlete-positions-v87-migration.test.mjs
-- and backend/scripts/athlete-positions-v87-rehearsal.mjs: apply -> rollback -> the catalog identical to before -> apply again).
-- Before it is run anywhere real: the deployed commit no longer contains the v87 file (otherwise the migrator applies v87 again at
-- the next start), and the database is named in its own approval (.claude/rules/database-safety.md).
--
-- It drops the two v87 tables, every v87 trigger and function, the v87 constraints, indexes and columns of
-- public.sport_positions, deletes the six seeded positions and the sport 'Football', puts back v42's unique (sport_id, name),
-- v69's method CHECK and estimate_basis_ok and v64's validate_metric_value_estimate (bodies verbatim), and deletes the v87
-- record. It changes no other row. It refuses (23514, fixed message), changing nothing, once any of these holds - from then on
-- v87 is forward-only:
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v87 is not recorded, or any migration was applied after it (by applied_at, not by prefix);
--   * a position was changed in the app (a change row exists, or a club position exists), or a seeded position differs;
--   * an athlete's position was ever set (a row of public.athlete_positions exists);
--   * an estimate with the method position_average exists;
--   * anything else references the sport 'Football' (the delete then fails and the transaction ends with nothing changed).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f athlete-positions-v87-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v87 rollback refused: the migrator is running' using errcode = '23514';
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611221200_athletes_v87_positions.sql') then
    raise exception 'v87 rollback refused: v87 is not recorded on this database' using errcode = '23514';
  end if;
  if exists (select 1 from public.schema_migrations m where m.migration_name <> 'migrations_v2/202611221200_athletes_v87_positions.sql'
              and m.applied_at >= (select applied_at from public.schema_migrations where migration_name = 'migrations_v2/202611221200_athletes_v87_positions.sql')) then
    raise exception 'v87 rollback refused: later migrations are applied' using errcode = '23514';
  end if;
  if exists (select 1 from public.sport_position_changes) or exists (select 1 from public.sport_positions where owner_scope <> 'system') then
    raise exception 'v87 rollback refused: positions were changed in the app' using errcode = '23514';
  end if;
  if (select string_agg(p.name || ':' || p.sort_order || ':' || (p.archived_at is null)::text, ',' order by p.sort_order)
        from public.sport_positions p)
     is distinct from 'Goalkeeper:10:true,Centre back:20:true,Full back:30:true,Midfielder:40:true,Winger:50:true,Forward:60:true' then
    raise exception 'v87 rollback refused: the positions differ from the v87 seed' using errcode = '23514';
  end if;
  if exists (select 1 from public.athlete_positions) then
    raise exception 'v87 rollback refused: an athlete''s position was set' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.metric_value_estimates where method = 'position_average') then
    raise exception 'v87 rollback refused: a position average estimate exists' using errcode = '23514';
  end if;
end $$;

-- The estimate method: v69's CHECK and basis, v64's provenance guard (verbatim).
alter table training_load.metric_value_estimates drop constraint metric_value_estimates_method_check;
alter table training_load.metric_value_estimates add constraint metric_value_estimates_method_check
  check (method in ('proportional', 'copy_athlete', 'team_average', 'scale_recording'));

create or replace function training_load.estimate_basis_ok(p_method text, p_basis jsonb) returns boolean as $$
  select case p_method
    when 'proportional' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['minutes', 'ratePerMinute', 'sessions']
      and jsonb_typeof(p_basis -> 'minutes') = 'number' and (p_basis ->> 'minutes')::numeric > 0 and (p_basis ->> 'minutes')::numeric <= 1440
      and jsonb_typeof(p_basis -> 'ratePerMinute') = 'number' and (p_basis ->> 'ratePerMinute')::numeric >= 0
      and jsonb_typeof(p_basis -> 'sessions') = 'number' and (p_basis ->> 'sessions') ~ '^[0-9]{1,3}$' and (p_basis ->> 'sessions')::int between 3 and 5
    when 'copy_athlete' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['sourceAthleteId']
      and jsonb_typeof(p_basis -> 'sourceAthleteId') = 'string'
      and (p_basis ->> 'sourceAthleteId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    when 'team_average' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['athletes']
      and jsonb_typeof(p_basis -> 'athletes') = 'number' and (p_basis ->> 'athletes') ~ '^[0-9]{1,4}$' and (p_basis ->> 'athletes')::int >= 3
    when 'scale_recording' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['measured', 'recordedMinutes', 'targetMinutes']
      and jsonb_typeof(p_basis -> 'measured') = 'number' and (p_basis ->> 'measured')::numeric >= 0
      and jsonb_typeof(p_basis -> 'recordedMinutes') = 'number' and jsonb_typeof(p_basis -> 'targetMinutes') = 'number'
      and (p_basis ->> 'recordedMinutes')::numeric > 0
      and (p_basis ->> 'recordedMinutes')::numeric < (p_basis ->> 'targetMinutes')::numeric
      and (p_basis ->> 'targetMinutes')::numeric <= 600
    else false
  end;
$$ language sql immutable;

create or replace function training_load.validate_metric_value_estimate() returns trigger as $$
declare
  v_val record;
begin
  select v.occasion_id, o.entry_method, o.recorded_by_user_id, dv.daily_aggregation_method
    into v_val
    from training_load.metric_values v
    join training_load.metric_measurement_occasions o on o.id = v.occasion_id
    join training_load.metric_definition_versions dv on dv.id = v.metric_definition_version_id
   where v.id = new.metric_value_id;
  if not found or v_val.entry_method is distinct from 'estimate' or v_val.occasion_id is distinct from new.occasion_id then
    raise exception 'estimate: the provenance row belongs to an estimated value of its occasion' using errcode = '23514';
  end if;
  if new.estimated_by_user_id is distinct from v_val.recorded_by_user_id
     or new.estimated_by_user_id is distinct from training_load.estimate_context_actor() then
    raise exception 'estimate: the author must be the acting user' using errcode = '42501';
  end if;
  if not (v_val.daily_aggregation_method = 'sum'
          or (v_val.daily_aggregation_method = 'avg' and new.method in ('copy_athlete', 'team_average'))) then
    raise exception 'estimate: this method is not allowed for this variable' using errcode = '23514';
  end if;
  -- v64: one request key names one request. The (author, key) lock serialises two saves of one key (two teams' sessions
  -- at once, where the team lock does not serialise them); the check below then reads in a new snapshot.
  perform pg_advisory_xact_lock(hashtextextended('estimate-request:' || new.estimated_by_user_id::text || ':' || new.request_key::text, 64));
  if exists (select 1 from training_load.metric_value_estimates e
              where e.estimated_by_user_id = new.estimated_by_user_id and e.request_key = new.request_key
                and e.request_hash is distinct from new.request_hash) then
    raise exception 'estimate: a request key names one request' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

-- An athlete's position.
drop trigger athlete_positions_no_truncate on public.athlete_positions;
drop trigger athlete_positions_no_update on public.athlete_positions;
drop trigger athlete_positions_before_insert on public.athlete_positions;
drop table public.athlete_positions;
drop function public.athlete_positions_before_insert();
drop function public.athlete_position_in_force(uuid, uuid);

-- The list's log.
drop trigger sport_position_changes_no_truncate on public.sport_position_changes;
drop trigger sport_position_changes_no_update on public.sport_position_changes;
drop trigger sport_position_changes_before_insert on public.sport_position_changes;
drop table public.sport_position_changes;
drop function public.sport_position_changes_before_insert();
drop function public.position_history_append_only();

-- The registry's guards, then its rows and columns.
drop trigger sport_positions_change_logged on public.sport_positions;
drop trigger sport_positions_no_truncate on public.sport_positions;
drop trigger sport_positions_before_write on public.sport_positions;
drop function public.sport_positions_change_logged();
drop function public.sport_positions_no_truncate();
drop function public.sport_positions_before_write();
drop function public.sport_position_offered(uuid, uuid, boolean);
drop function public.athlete_position_right(uuid, uuid, uuid, text, uuid);
drop function public.sport_position_basis(uuid, text, uuid);
drop function public.position_actor();

drop index public.sport_positions_owner_club_idx;
drop index public.sport_positions_owner_name_live_key;
alter table public.sport_positions
  drop constraint sport_positions_sort_order_check,
  drop constraint sport_positions_archived_by_shape,
  drop constraint sport_positions_name_check,
  drop constraint sport_positions_owner_shape,
  drop constraint sport_positions_owner_scope_check;

delete from public.sport_positions;
delete from public.sports where name = 'Football';

alter table public.sport_positions
  drop column updated_at,
  drop column sort_order,
  drop column archived_by_user_id,
  drop column archived_at,
  drop column created_by_user_id,
  drop column owner_club_id,
  drop column owner_scope;
alter table public.sport_positions add constraint sport_positions_sport_id_name_key unique (sport_id, name);

delete from public.schema_migrations where migration_name = 'migrations_v2/202611221200_athletes_v87_positions.sql';
commit;

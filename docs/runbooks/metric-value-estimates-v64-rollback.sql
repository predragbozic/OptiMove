-- Rollback of migration v64 (the request key of an estimate save, an estimate participant's time zone, phase 5b 6b-B):
-- migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/metric-estimates-6b-b.test.mjs:
-- apply -> rollback -> the v63 catalog exactly -> re-apply, and the refusals below). Before it is run anywhere real: a fresh
-- restore-verified backup exists; the deployed commit no longer contains the v64 migration file (otherwise the migrator applies
-- it again at the next start) and no longer writes estimates (ESTIMATES_ENABLED off); the owner approved this database
-- specifically (.claude/rules/database-safety.md).
--
-- It restores v12's protect_participant_identity_once_measured, v63's validate_metric_value_estimate and v1's
-- training.protect_participant_identity_once_linked (by md5 of v64's in force), drops the request index and columns, and removes the v64 record. It changes no other row. It refuses, changing
-- nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v64 is not recorded, or any later migrations_v2 migration is;
--   * any provenance row exists (its request key would be lost);
--   * the three bodies in force are not v64's.
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f metric-value-estimates-v64-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v64 rollback refused: the migrator is running';
  end if;
end $$;

-- Nothing may be written between the checks below and the changes.
lock table training_load.metric_value_estimates, training_load.metric_event_participants, training.activity_participants in share row exclusive mode;

do $$
declare
  v64 constant text := 'migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v64) then
    raise exception 'v64 rollback refused: v64 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v64) then
    raise exception 'v64 rollback refused: later migrations are applied';
  end if;
  if exists (select 1 from training_load.metric_value_estimates) then
    raise exception 'v64 rollback refused: an estimate exists';
  end if;
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'validate_metric_value_estimate') is distinct from 'd4fdb1a813a4560651493af644632ea3'
     or (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'protect_participant_identity_once_measured') is distinct from '2064f10c42b0754659e29b7855fe36df'
     or (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training' and p.proname = 'protect_participant_identity_once_linked') is distinct from 'a652f66a20e48789dfe608fa7d36b2d2' then
    raise exception 'v64 rollback refused: the bodies in force are not v64''s';
  end if;
end $$;

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
  return new;
end;
$$ language plpgsql;

create or replace function training_load.protect_participant_identity_once_measured() returns trigger as $$
declare
  has_measurements boolean;
begin
  if new.event_id is not distinct from old.event_id
     and new.athlete_id is not distinct from old.athlete_id
     and new.athlete_timezone_snapshot is not distinct from old.athlete_timezone_snapshot
     and new.logical_session_id is not distinct from old.logical_session_id
     and new.external_assignment_id is not distinct from old.external_assignment_id
     and new.linked_session_name_snapshot is not distinct from old.linked_session_name_snapshot
     and new.linked_plan_name_snapshot is not distinct from old.linked_plan_name_snapshot then
    return new;
  end if;
  select exists (select 1 from training_load.metric_measurement_occasions where event_participant_id = old.id) into has_measurements;
  if has_measurements then
    raise exception 'metric_event_participants (id=%) has dependent measurements: identity/snapshot fields are immutable', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function training.protect_participant_identity_once_linked() returns trigger as $$
declare
  is_load_bearing boolean;
begin
  if new.athlete_id is not distinct from old.athlete_id
     and new.timezone_snapshot is not distinct from old.timezone_snapshot
     and new.local_date is not distinct from old.local_date then
    -- fall through to the merge-status/activity_id write-once checks below
    null;
  else
    select
      exists (select 1 from training.activity_participant_session_links where activity_participant_id = old.id)
      or exists (select 1 from training.activity_participant_metric_participant_links where activity_participant_id = old.id)
      or exists (select 1 from training.activity_participant_components where activity_participant_id = old.id)
      or old.merge_status = 'superseded'
      or exists (select 1 from training.activity_participants where superseded_by_participant_id = old.id)
      into is_load_bearing;
    if is_load_bearing then
      raise exception 'training.activity_participants (id=%): athlete_id/timezone_snapshot/local_date are immutable once load-bearing (linked, itself an alias, or the target of an incoming alias) — reparent the ACTIVITY instead, never the athlete identity', old.id;
    end if;
  end if;

  -- activity_id may only be changed by reparent_activity_participant()
  -- (v4), gated behind the same session-local GUC every other
  -- sanctioned-function-only field in this schema uses.
  if new.activity_id is distinct from old.activity_id
     and current_setting('training.allow_reparent_write', true) is distinct from 'on' then
    raise exception 'training.activity_participants (id=%): activity_id may only be changed by reparent_activity_participant()', old.id;
  end if;

  if old.superseded_by_participant_id is not null and new.superseded_by_participant_id is distinct from old.superseded_by_participant_id then
    raise exception 'training.activity_participants (id=%): superseded_by_participant_id is write-once', old.id;
  end if;
  if new.superseded_by_participant_id is not null and old.superseded_by_participant_id is null
     and current_setting('training.allow_participant_merge_write', true) is distinct from 'on' then
    raise exception 'training.activity_participants (id=%): superseded_by_participant_id may only be set by merge_activity_participants()', old.id;
  end if;
  if new.merge_status is distinct from old.merge_status
     and current_setting('training.allow_participant_merge_write', true) is distinct from 'on' then
    raise exception 'training.activity_participants (id=%): merge_status may only be changed by merge_activity_participants()', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

drop index training_load.metric_value_estimates_request_idx;
alter table training_load.metric_value_estimates drop column request_hash, drop column request_key;

delete from public.schema_migrations where migration_name = 'migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql';

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'metric_value_estimates'
              and column_name in ('request_key', 'request_hash')) then
    raise exception 'v64 rollback failed: a v64 column is still there';
  end if;
  -- v12's and v63's bodies, exactly (a CRLF checkout of this file would change them).
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'validate_metric_value_estimate') is distinct from 'fa6e027caca7ea8dfc28f624d81b0e96'
     or (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'protect_participant_identity_once_measured') is distinct from '8c56c9950666a874f1fb5c464aa47e58'
     or (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training' and p.proname = 'protect_participant_identity_once_linked') is distinct from '4a77025e17227d8efd1408676e461400' then
    raise exception 'v64 rollback failed: the restored bodies are not v1''s, v12''s and v63''s';
  end if;
end $$;

commit;

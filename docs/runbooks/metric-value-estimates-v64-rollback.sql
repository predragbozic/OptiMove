-- Rollback of migration v64 (the request key of an estimate save, an estimate participant's time zone, phase 5b 6b-B):
-- migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/metric-estimates-6b-b.test.mjs:
-- apply -> rollback -> the v63 catalog exactly -> re-apply, and the refusals below). Before it is run anywhere real: a fresh
-- restore-verified backup exists; the deployed commit no longer contains the v64 migration file (otherwise the migrator applies
-- it again at the next start) and no longer writes estimates (ESTIMATES_ENABLED off); the owner approved this database
-- specifically (.claude/rules/database-safety.md).
--
-- It restores v12's protect_participant_identity_once_measured and v63's validate_metric_value_estimate (by md5 of v64's in
-- force), drops the request index and columns, and removes the v64 record. It changes no other row. It refuses, changing
-- nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v64 is not recorded, or any later migrations_v2 migration is;
--   * any provenance row exists (its request key would be lost);
--   * the two bodies in force are not v64's.
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
lock table training_load.metric_value_estimates, training_load.metric_event_participants in share row exclusive mode;

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
       where n.nspname = 'training_load' and p.proname = 'validate_metric_value_estimate') is distinct from 'a774e02c6c33a3a80c468108334ee322'
     or (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'protect_participant_identity_once_measured') is distinct from '2064f10c42b0754659e29b7855fe36df' then
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
       where n.nspname = 'training_load' and p.proname = 'protect_participant_identity_once_measured') is distinct from '8c56c9950666a874f1fb5c464aa47e58' then
    raise exception 'v64 rollback failed: the restored bodies are not v12''s and v63''s';
  end if;
end $$;

commit;

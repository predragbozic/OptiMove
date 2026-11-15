-- Rollback of migration v69 (the scaled estimate, MT-D part 2):
-- migrations_v2/202611131310_training_load_v69_scale_recording_estimates.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/scale-recording-mt-d.test.mjs).
-- Before it is run anywhere real: a fresh restore-verified backup exists; the deployed commit no longer contains v69's file and
-- no longer saves a scaled estimate (MT-D's code); the owner approved this database specifically (.claude/rules/database-safety.md).
--
-- It restores v63's method CHECK and estimate_basis_ok and removes the v69 record. It refuses, changing nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v69 is not recorded, or any later migrations_v2 migration is;
--   * a scale_recording estimate exists.
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f scale-recording-v69-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v69 rollback refused: the migrator is running';
  end if;
end $$;

lock table training_load.metric_value_estimates in access exclusive mode;

do $$
declare
  v69 constant text := 'migrations_v2/202611131310_training_load_v69_scale_recording_estimates.sql';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v69) then
    raise exception 'v69 rollback refused: v69 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v69) then
    raise exception 'v69 rollback refused: later migrations are applied';
  end if;
  if exists (select 1 from training_load.metric_value_estimates where method = 'scale_recording') then
    raise exception 'v69 rollback refused: a scaled estimate exists';
  end if;
end $$;

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
    else false
  end;
$$ language sql immutable;

alter table training_load.metric_value_estimates drop constraint metric_value_estimates_method_check;
alter table training_load.metric_value_estimates add constraint metric_value_estimates_method_check
  check (method in ('proportional', 'copy_athlete', 'team_average'));

delete from public.schema_migrations where migration_name = 'migrations_v2/202611131310_training_load_v69_scale_recording_estimates.sql';

commit;

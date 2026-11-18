-- Rollback of migration v77 (calculated variables, step 1): migrations_v2/202611181000_training_load_v77_calculated_variables.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/calculated-variables-v77.test.mjs:
-- apply -> rollback -> the catalog before v77 exactly -> re-apply, and every refusal below). Before it is run anywhere real: a
-- fresh restore-verified backup exists; the deployed commit no longer contains the v77 migration file (otherwise the migrator
-- applies v77 again at the next start); and the owner approved this database specifically (.claude/rules/database-safety.md).
--
-- It drops v77's four triggers, its six functions, the CHECK and the column metric_definition_versions.calculation, and removes
-- the v77 record. It changes no other row. It refuses, changing nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v77 is not recorded, or any later migrations_v2 migration is;
--   * a variable version carries a calculation, or a value names a formula version (the way back is forward-only once a
--     calculated variable exists).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f calculated-variables-v77-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v77 rollback refused: the migrator is running';
  end if;
end $$;

-- Nothing may write a version or a value between the checks below and the drop.
lock table training_load.metric_definition_versions in access exclusive mode;
lock table training_load.metric_values in share mode;

do $$
declare
  v77 constant text := 'migrations_v2/202611181000_training_load_v77_calculated_variables.sql';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v77) then
    raise exception 'v77 rollback refused: v77 is not recorded';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v77) then
    raise exception 'v77 rollback refused: a later migration is recorded';
  end if;
  if exists (select 1 from training_load.metric_definition_versions where calculation is not null) then
    raise exception 'v77 rollback refused: a calculated variable exists';
  end if;
  if exists (select 1 from training_load.metric_values
              where computed_by_ref is not null and jsonb_typeof(computed_by_ref) = 'object' and computed_by_ref ? 'formulaVersionId') then
    raise exception 'v77 rollback refused: a value names a formula version';
  end if;
end $$;

drop trigger metric_values_calculation_guard on training_load.metric_values;
drop trigger source_metric_mapping_versions_calculation_guard on training_load.source_metric_mapping_versions;
drop trigger metric_definition_scope_capabilities_calculation_guard on training_load.metric_definition_scope_capabilities;
drop trigger metric_definition_versions_calculation_guard on training_load.metric_definition_versions;
drop function training_load.metric_calculation_value_guard();
drop function training_load.metric_calculation_mapping_guard();
drop function training_load.metric_calculation_level_guard();
drop function training_load.metric_calculation_version_guard();
alter table training_load.metric_definition_versions drop constraint metric_definition_versions_calculation_shape;
alter table training_load.metric_definition_versions drop column calculation;
drop function training_load.metric_calculation_inputs(jsonb);
drop function training_load.metric_calculation_shape_ok(jsonb);

delete from public.schema_migrations where migration_name = 'migrations_v2/202611181000_training_load_v77_calculated_variables.sql';

commit;

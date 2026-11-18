-- Read-only PREFLIGHT for migration v77 (migrations_v2/202611181000_training_load_v77_calculated_variables.sql); run before the
-- deploy that applies it (the Rukovodilac, Supabase SQL Editor, each block in a read-only transaction). Changes nothing. Every
-- block returns ok = true (or the stated facts).

-- 1. v76 is recorded and v77 is not; no migrations_v2 migration sorts after v77.
select exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611171000_training_load_v76_undo_by_importer.sql') as v76_recorded,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611181000_training_load_v77_calculated_variables.sql') as v77_absent,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611181000_training_load_v77_calculated_variables.sql') as nothing_later;

-- 2. No v77 object yet: the column, the CHECK, the six functions and the four triggers are absent.
select not exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'metric_definition_versions'
                    and column_name = 'calculation') as no_column,
       not exists (select 1 from pg_constraint where conname = 'metric_definition_versions_calculation_shape') as no_check,
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'training_load' and p.proname in ('metric_calculation_shape_ok', 'metric_calculation_inputs',
                      'metric_calculation_version_guard', 'metric_calculation_level_guard', 'metric_calculation_mapping_guard',
                      'metric_calculation_value_guard')) as no_functions,
       not exists (select 1 from pg_trigger where tgname in ('metric_definition_versions_calculation_guard',
                      'metric_definition_scope_capabilities_calculation_guard', 'source_metric_mapping_versions_calculation_guard',
                      'metric_values_calculation_guard')) as no_triggers;

-- 3. No value names a formula version today (the value guard refuses a formula reference on an ordinary version).
select not exists (select 1 from training_load.metric_values
                    where computed_by_ref is not null and jsonb_typeof(computed_by_ref) = 'object' and computed_by_ref ? 'formulaVersionId') as ok,
       (select count(*) from training_load.metric_values where aggregation_role = 'derived_rollup') as derived_rollup_values;

-- 4. A quiet moment: no idle transaction and no lock wait (the migration takes metric_definition_versions' ACCESS EXCLUSIVE lock
--    with a 5 s lock_timeout).
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

-- 5. The role you run this as owns (or is a member of the owner of) the four tables v77 puts a trigger on.
select bool_and(pg_has_role(current_user, c.relowner, 'USAGE')) as owns_tables
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'training_load' and c.relname in ('metric_definition_versions', 'metric_definition_scope_capabilities',
       'source_metric_mapping_versions', 'metric_values');

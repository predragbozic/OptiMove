-- Read-only POST-CHECK for migration v77 (migrations_v2/202611181000_training_load_v77_calculated_variables.sql); run after the
-- deploy that applied it. Changes nothing. Every block returns ok = true.

-- 1. v77 recorded once, and the last migrations_v2 migration.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611181000_training_load_v77_calculated_variables.sql') = 1 as recorded_once,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611181000_training_load_v77_calculated_variables.sql') as last;

-- 2. The column (jsonb, nullable) and its CHECK.
select exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'metric_definition_versions'
                and column_name = 'calculation' and data_type = 'jsonb' and is_nullable = 'YES') as column_ok,
       exists (select 1 from pg_constraint where conrelid = 'training_load.metric_definition_versions'::regclass
                and conname = 'metric_definition_versions_calculation_shape' and contype = 'c' and convalidated) as check_ok;

-- 3. The six functions (md5 of prosrc).
select e.f as fn, md5(p.prosrc) as actual_md5, md5(p.prosrc) = e.m as ok
  from (values ('metric_calculation_shape_ok', '2d2a17ae713005d116fc1ab96b783b9d'),
               ('metric_calculation_inputs', '9ab77d5eb11f05a09408f478311dd58b'),
               ('metric_calculation_version_guard', 'a4d8225e2c3b70e618c58c18eb712dcc'),
               ('metric_calculation_level_guard', '4476523461e60244d0a2aadbcaf25914'),
               ('metric_calculation_mapping_guard', '942b8196a4e8356585044cc308840ca7'),
               ('metric_calculation_value_guard', '22e88230de37aba4646d49cc49986f6f')) e(f, m)
  join pg_namespace n on n.nspname = 'training_load' join pg_proc p on p.pronamespace = n.oid and p.proname = e.f
 order by 1;

-- 4. The four triggers, enabled, on their tables.
select count(*) = 4 as ok
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'training_load' and t.tgenabled = 'O'
   and (c.relname, t.tgname) in (('metric_definition_versions', 'metric_definition_versions_calculation_guard'),
                                 ('metric_definition_scope_capabilities', 'metric_definition_scope_capabilities_calculation_guard'),
                                 ('source_metric_mapping_versions', 'source_metric_mapping_versions_calculation_guard'),
                                 ('metric_values', 'metric_values_calculation_guard'));

-- 5. Nothing is calculated yet: no version carries a calculation and no value names a formula.
select not exists (select 1 from training_load.metric_definition_versions where calculation is not null) as no_calculated_version,
       not exists (select 1 from training_load.metric_values
                    where computed_by_ref is not null and jsonb_typeof(computed_by_ref) = 'object' and computed_by_ref ? 'formulaVersionId') as no_formula_value;

-- 6. Nothing else moved: no idle transaction and no lock wait.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

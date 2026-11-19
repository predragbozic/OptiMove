-- Read-only POST-CHECK for migration v79 (migrations_v2/202611191200_training_load_v79_calculated_ratio_difference.sql); run
-- after its deploy (the Rukovodilac, Supabase SQL Editor, each block in a read-only transaction). Changes nothing. Every block
-- returns ok = true, or the stated counts.

-- 1. v79 is recorded once (compare checksum with the file's sha256). Later migrations of other tracks may be recorded.
select count(*) = 1 as v79_once,
       max(checksum) as checksum
  from public.schema_migrations where migration_name = 'migrations_v2/202611191200_training_load_v79_calculated_ratio_difference.sql';

-- 2. The four bodies are v79's.
select bool_and(case p.proname
         when 'metric_calculation_shape_ok' then md5(p.prosrc) = 'a48b6fa7166f0c46e10cc8a98f3c3ae2'
         when 'metric_calculation_version_guard' then md5(p.prosrc) = '97949aad715f1532054edbf3f81ab4ca'
         when 'metric_calculation_value_guard' then md5(p.prosrc) = 'c4ff25e511abccebc4a07f6ccd7478d8'
         when 'dashboard_widget_series_validate_aggregation_type_compat' then md5(p.prosrc) = '259f15ee79a08434b0439ebd0a3daff4'
       end) as bodies_v79,
       count(*) = 4 as four_bodies
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'training_load'
   and p.proname in ('metric_calculation_shape_ok', 'metric_calculation_version_guard', 'metric_calculation_value_guard',
                     'dashboard_widget_series_validate_aggregation_type_compat');

-- 3. The two CHECKs take 'ratio', and the guard triggers v79 relies on are enabled.
select pg_get_constraintdef((select oid from pg_constraint where conname = 'metric_definition_versions_daily_aggregation_method_check')) like '%''ratio''%' as day_rule_takes_ratio,
       pg_get_constraintdef((select oid from pg_constraint where conname = 'dashboard_widget_series_analytical_aggregation_check')) like '%''ratio''%' as series_takes_ratio,
       (select count(*) from pg_trigger where tgenabled = 'O' and tgname in
          ('metric_definition_versions_calculation_guard', 'metric_values_calculation_guard', 'dashboard_widget_series_validate_aggregation_type_compat')) = 3 as triggers_enabled;

-- 4. Nothing of the new kinds yet (the API creates them later): every count 0.
select (select count(*) from training_load.metric_definition_versions where calculation ->> 'kind' in ('ratio', 'difference')) as ratio_or_difference_versions,
       (select count(*) from training_load.metric_definition_versions where daily_aggregation_method = 'ratio') as ratio_day_rules,
       (select count(*) from training_load.dashboard_widget_series where analytical_aggregation = 'ratio') as ratio_series;

-- 5. No idle transaction and no lock wait left behind.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

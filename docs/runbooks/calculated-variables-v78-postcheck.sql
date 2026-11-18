-- Read-only POST-CHECK for migration v78 (migrations_v2/202611181100_training_load_v78_calculated_variables_additive.sql); run
-- after its deploy (the Rukovodilac, Supabase SQL Editor, each block in a read-only transaction). Changes nothing. Every block
-- returns ok = true, or the stated counts.

-- 1. v78 is recorded once, as the last migrations_v2 migration (compare checksum with the file's sha256).
select count(*) = 1 as v78_once,
       max(checksum) as checksum,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611181100_training_load_v78_calculated_variables_additive.sql') as v78_last
  from public.schema_migrations where migration_name = 'migrations_v2/202611181100_training_load_v78_calculated_variables_additive.sql';

-- 2. The two bodies are v78's and the state guard's trigger is enabled.
select (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'metric_calculation_version_guard') = 'eae4cc9d519a498ca7f4acf0bedbdcbd' as version_guard_v78,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'metric_calculation_state_guard') = '1954b245cfd2c147540c3daf3bb95a92' as state_guard_v78,
       exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                where t.tgname = 'metric_definitions_calculation_state_guard' and c.relname = 'metric_definitions' and t.tgenabled = 'O') as trigger_enabled;

-- 3. No stored row breaks a v78 rule (the migration refuses otherwise): every count 0.
select (select count(*) from training_load.metric_definition_versions where calculation is not null and daily_aggregation_method <> 'sum') as calculated_not_summed,
       (select count(*) from training_load.metric_definitions cd
          join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
          join training_load.metric_definitions i on i.id = any (training_load.metric_calculation_inputs(cv.calculation))
          join training_load.metric_definition_versions iv on iv.id = i.current_version_id and iv.metric_definition_id = i.id
         where cv.calculation is not null and iv.daily_aggregation_method <> 'sum') as inputs_not_summed,
       (select count(*) from training_load.metric_definitions cd
          join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
          join training_load.metric_definitions i on i.id = any (training_load.metric_calculation_inputs(cv.calculation))
         where cd.state = 'active' and cv.calculation is not null and i.state <> 'active') as active_over_inactive,
       (select count(*) from training_load.metric_definition_versions where calculation is not null) as calculated_versions;

-- 4. No idle transaction and no lock wait left behind.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

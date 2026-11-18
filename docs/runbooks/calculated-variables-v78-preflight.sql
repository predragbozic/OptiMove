-- Read-only PREFLIGHT for migration v78 (migrations_v2/202611181100_training_load_v78_calculated_variables_additive.sql); run
-- before the deploy that applies it (the Rukovodilac, Supabase SQL Editor, each block in a read-only transaction). Changes
-- nothing. Every block returns ok = true, or the stated counts.

-- 1. v77 is recorded and v78 is not; no migrations_v2 migration sorts after v78.
select exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611181000_training_load_v77_calculated_variables.sql') as v77_recorded,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611181100_training_load_v78_calculated_variables_additive.sql') as v78_absent,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611181100_training_load_v78_calculated_variables_additive.sql') as nothing_later;

-- 2. The version guard in force is v77's, and v78's state guard does not exist yet.
select (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'metric_calculation_version_guard') = 'a4d8225e2c3b70e618c58c18eb712dcc' as v77_body,
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'training_load' and p.proname = 'metric_calculation_state_guard') as no_state_guard,
       not exists (select 1 from pg_trigger where tgname = 'metric_definitions_calculation_state_guard') as no_trigger;

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

-- 4. A quiet moment: no idle transaction and no lock wait (the migration takes metric_definitions' SHARE ROW EXCLUSIVE lock for
--    the trigger with a 5 s lock_timeout).
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

-- 5. The role you run this as owns (or is a member of the owner of) metric_definitions, which v78 puts a trigger on.
select pg_has_role(current_user, c.relowner, 'USAGE') as owns_table
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'training_load' and c.relname = 'metric_definitions';

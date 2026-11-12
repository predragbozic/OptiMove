-- Read-only POST-CHECK for migration v63 (migrations_v2/202611121000_training_load_v63_metric_value_estimates.sql); run after the
-- deploy that applied it (the Rukovodilac, each block in a read-only transaction). Changes nothing. Every block returns ok = true.

-- 1. v63 is recorded once and is the last migration.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611121000_training_load_v63_metric_value_estimates.sql') = 1 as recorded_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%')
         = 'migrations_v2/202611121000_training_load_v63_metric_value_estimates.sql' as last;

-- 2. The session undo bodies are v63's.
select (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'session_undo_scope') = '4d33a3379faaf918243b8db11de12c81' as scope_is_v63,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'undo_imported_session') = 'cf208f99e3e4db738670dec2567dc8fc' as undo_is_v63;

-- 3. The table and its guards, every trigger enabled.
select to_regclass('training_load.metric_value_estimates') is not null as table_ok,
       (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where not t.tgisinternal and t.tgenabled = 'O' and t.tgname in (
           'metric_measurement_occasions_estimate_guard', 'metric_values_estimate_guard', 'metric_values_estimate_provenance',
           'metric_values_supersede_estimate', 'metric_value_estimates_validate', 'metric_value_estimates_protect',
           'metric_value_estimates_no_truncate', 'metric_measurement_occasions_estimate_revision',
           'metric_measurement_occasions_estimate_value')) = 9 as triggers_ok,
       (select count(*) from pg_trigger t
         where not t.tgisinternal and t.tgdeferrable and t.tginitdeferred and t.tgname in (
           'metric_values_estimate_provenance', 'metric_measurement_occasions_estimate_value')) = 2 as deferred_ok;

-- 4. The two widened CHECKs.
select pg_get_constraintdef((select oid from pg_constraint where conname = 'metric_measurement_occasions_entry_method_check'
         and conrelid = 'training_load.metric_measurement_occasions'::regclass)) like '%estimate%' as entry_method_ok,
       pg_get_constraintdef((select oid from pg_constraint where conname = 'dashboard_widget_series_source_policy_check'
         and conrelid = 'training_load.dashboard_widget_series'::regclass)) like '%estimate%' as source_policy_ok;

-- 5. No estimate exists yet (the save stays behind ESTIMATES_ENABLED, off).
select not exists (select 1 from training_load.metric_value_estimates) as no_provenance,
       not exists (select 1 from training_load.metric_measurement_occasions where entry_method = 'estimate') as no_estimate_occasion,
       not exists (select 1 from training_load.dashboard_widget_series where source_policy = 'estimate') as no_estimate_series;

-- 6. No idle transaction or lock wait after the deploy.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

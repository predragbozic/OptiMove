-- Read-only PREFLIGHT for migration v64 (migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql); run before the deploy that applies it (the Rukovodilac, Supabase SQL Editor,
-- each block in a read-only transaction). Changes nothing. Every boolean column of every block must be true.

-- 1. v63 is the last applied migration and v64 is not recorded.
select (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%')
         = 'migrations_v2/202611121000_training_load_v63_metric_value_estimates.sql' as ok,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql') as v64_absent;

-- 2. The table is empty (v64 adds NOT NULL columns without a default) and has no request column yet.
select to_regclass('training_load.metric_value_estimates') is not null as v63_table,
       not exists (select 1 from training_load.metric_value_estimates) as table_empty,
       not exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'metric_value_estimates'
                    and column_name in ('request_key', 'request_hash')) as no_request_columns;

-- 3. The two bodies in force are v12's and v63's (v64 replaces them under this md5 gate).
select (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'protect_participant_identity_once_measured') = '8c56c9950666a874f1fb5c464aa47e58' as protect_is_v12,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'validate_metric_value_estimate') = 'fa6e027caca7ea8dfc28f624d81b0e96' as guard_is_v63,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname in ('protect_participant_identity_once_measured', 'validate_metric_value_estimate')) = 2 as each_once;

-- 4. A quiet moment: no idle transaction, no lock wait, no running check.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from training_load.gpexe_import_checks where status = 'running') as no_running_check;

-- 5. The role you run this as may create in the schema.
select has_schema_privilege(current_user, 'training_load', 'CREATE') as may_create;

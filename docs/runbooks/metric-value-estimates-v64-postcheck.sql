-- Read-only POST-CHECK for migration v64 (migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql); run after the deploy that applied it (the Rukovodilac, each block in a
-- read-only transaction). Changes nothing. Every block returns ok = true.

-- 1. v64 is recorded once and is the last migration.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql') = 1 as recorded_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql' as last;

-- 2. The two bodies are v64's.
select (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'protect_participant_identity_once_measured') = '2064f10c42b0754659e29b7855fe36df' as protect_is_v64,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'validate_metric_value_estimate') = 'a774e02c6c33a3a80c468108334ee322' as guard_is_v64;

-- 3. The request columns (NOT NULL), the hash shape CHECK and the index.
select (select count(*) from information_schema.columns where table_schema = 'training_load' and table_name = 'metric_value_estimates'
         and column_name in ('request_key', 'request_hash') and is_nullable = 'NO') = 2 as columns_ok,
       exists (select 1 from pg_constraint where conname = 'metric_value_estimates_request_hash_shape'
                and conrelid = 'training_load.metric_value_estimates'::regclass) as hash_check_ok,
       to_regclass('training_load.metric_value_estimates_request_idx') is not null as index_ok;

-- 4. The triggers that run these bodies are enabled.
select (select count(*) from pg_trigger t where not t.tgisinternal and t.tgenabled = 'O'
         and t.tgname in ('metric_event_participants_protect_identity', 'metric_value_estimates_validate')) = 2 as triggers_ok;

-- 5. No estimate yet (ESTIMATES_ENABLED stays off until 6b-D), no idle transaction.
select not exists (select 1 from training_load.metric_value_estimates) as no_estimate,
       not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx;

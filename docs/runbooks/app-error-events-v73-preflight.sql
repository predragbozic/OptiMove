-- Read-only PREFLIGHT for migration v73 (migrations_v2/202611151500_app_error_events_v73_request_and_restart.sql); run before the deploy that applies it
-- (the Rukovodilac, one block at a time). Changes nothing. Blocks 1, 2 and 4 return true values (the last migration
-- and the two owners are for reading); block 3 is read.

-- 1. v70 is recorded, v73 is not, and no migration with a later file name is recorded.
select exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql') as v70_recorded,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611151500_app_error_events_v73_request_and_restart.sql') as v73_absent,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611151500_app_error_events_v73_request_and_restart.sql') as nothing_later,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 2. The update guard is v70's body (the one v73 replaces) and no v73 column exists.
select (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'app_error_events_guard_update') = '13009f97dbedc04be84380baa037ce88' as guard_is_v70,
       not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'app_error_events'
                    and column_name in ('request_method', 'request_route', 'server_uptime', 'page_behind_server', 'delivered_late')) as no_v73_column,
       (select pg_get_userbyid(relowner) from pg_class where oid = 'public.app_error_events'::regclass) as table_owner,
       (select pg_get_userbyid(p.proowner) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'app_error_events_guard_update') as guard_owner;

-- 3. For reading: how many rows the new CHECKs are validated over (at most 30 days; the lock is held for that long).
select count(*) as rows_total, pg_size_pretty(pg_total_relation_size('public.app_error_events')) as size from public.app_error_events;

-- 4. A quiet moment: no idle transaction, no lock wait.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

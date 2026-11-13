-- Read-only PREFLIGHT for migration v70 (migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql); run before the deploy that applies it
-- (the Rukovodilac, Supabase SQL Editor, one block at a time). Changes nothing. Blocks 1, 2 and 4 return true values; block 3 is read.

-- 1. v58 is recorded, v70 is not, and no migration with a later file name is recorded (last_migration is for reading).
select exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611091000_app_error_events.sql') as v58_recorded,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql') as v70_absent,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql') as nothing_later,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 2. The update guard is v58's body (the one v70 replaces) and no v70 object exists.
select (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'app_error_events_guard_update') = '1737e2dd01bcdb74f02a006a65cb5389' as guard_is_v58,
       not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'app_error_events'
                    and column_name in ('device_class', 'os_family', 'browser_family', 'browser_major', 'viewport_bucket', 'touch', 'user_hash_version')) as no_v70_column,
       to_regclass('public.app_error_person_lookups') is null as no_lookups_table,
       has_schema_privilege(current_user, 'public', 'CREATE') as can_create_in_public;

-- 3. For reading: how many rows the new CHECKs are validated over (the table holds at most 30 days; the lock is held for that long).
select count(*) as rows_total, pg_size_pretty(pg_total_relation_size('public.app_error_events')) as size from public.app_error_events;

-- 4. A quiet moment: no idle transaction, no lock wait.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

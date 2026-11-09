-- Read-only POST-CHECK for migration v58 (migrations_v2/202611091000_app_error_events.sql); run after the deploy. Changes nothing. Every block returns rows with ok = true.

-- 1. v58 is recorded once and is the last migration.
select count(*) = 1 as recorded_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611091000_app_error_events.sql' as is_last
  from public.schema_migrations where migration_name = 'migrations_v2/202611091000_app_error_events.sql';

-- 2. The table, its 14 CHECKs, 3 indexes besides the primary key, and the 3 guard triggers (enabled).
select to_regclass('public.app_error_events') is not null as table_exists,
       (select count(*) from pg_constraint where conrelid = 'public.app_error_events'::regclass and contype = 'c') = 14 as fourteen_checks,
       (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'app_error_events' and indexname <> 'app_error_events_pkey') = 3 as three_indexes,
       (select count(*) from pg_trigger where tgrelid = 'public.app_error_events'::regclass and not tgisinternal and tgenabled = 'O'
          and tgname in ('app_error_events_guard_insert', 'app_error_events_guard_update', 'app_error_events_refuse_truncate')) = 3 as three_guards_enabled;

-- 3. No stored text breaks a closed shape (the CHECKs make this 0 by construction; a non-zero value means a CHECK was dropped or not validated).
select count(*) = 0 as ok
  from public.app_error_events
 where error_code !~ '^[a-z0-9_.-]{1,60}$' or fingerprint !~ '^[0-9a-f]{64}$' or (user_hash is not null and user_hash !~ '^[0-9a-f]{12}$');

-- 4. Row counts, for the owner to read (the first rows appear once the browser reports; nothing is expected at the deploy).
select count(*) as rows_total, coalesce(sum(repeat_count), 0) as occurrences, min(first_seen_at) as oldest, max(last_seen_at) as newest from public.app_error_events;

-- 5. Nobody but the application's own role can read the table through a data API (v58 revokes anon and authenticated).
select not exists (select 1 from pg_roles r where r.rolname in ('anon', 'authenticated') and has_table_privilege(r.rolname, 'public.app_error_events', 'SELECT')) as ok;

-- 6. Nothing is stuck.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx;

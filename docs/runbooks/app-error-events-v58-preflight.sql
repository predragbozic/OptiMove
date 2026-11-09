-- Read-only PREFLIGHT for migration v58 (migrations_v2/202611091000_app_error_events.sql); run before the deploy that applies it (the Rukovodilac, Supabase SQL Editor,
-- one block at a time). Changes nothing. Blocks 1 to 4 return rows with ok = true (or true values); block 5 is for the owner to read.

-- 1. The last applied migration is v57 and v58 is not recorded.
select (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611051000_training_load_v57_session_undo.sql' as ok,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611091000_app_error_events.sql') as v58_absent;

-- 2. None of the v58 objects exists yet.
select to_regclass('public.app_error_events') is null as no_table,
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('app_error_events_guard_insert', 'app_error_events_guard_update', 'app_error_events_refuse_truncate')) as no_functions;

-- 3. The role you run this as may create objects in the public schema.
select has_schema_privilege(current_user, 'public', 'CREATE') as can_create_in_public;

-- 4. A quiet moment: no idle transaction, no lock wait.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

-- 5. For the owner to read: the roles the Supabase Data API uses (v58 revokes every privilege on its table from anon and authenticated, whatever is exposed).
select coalesce((select array_to_string(setconfig, ',') from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'authenticator' limit 1), '') as authenticator_settings;

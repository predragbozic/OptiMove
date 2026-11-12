-- Read-only POST-CHECK for migration v62 (migrations_v2/202611111200_training_load_v62_team_session_timezone.sql); run after the deploy that applied it. Changes nothing. Every block returns
-- rows with ok = true (or the stated facts).

-- 1. v62 is recorded once and is the last migration.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611111200_training_load_v62_team_session_timezone.sql') = 1 as recorded_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611111200_training_load_v62_team_session_timezone.sql' as last;

-- 2. The two tables and the four functions exist.
select to_regclass('training_load.gpexe_team_session_timezones') is not null as table_ok,
       to_regclass('training_load.gpexe_team_session_timezone_history') is not null as history_ok,
       to_regprocedure('training_load.guard_gpexe_team_session_timezone()') is not null as guard_ok,
       to_regprocedure('training_load.record_gpexe_team_session_timezone()') is not null as record_ok,
       to_regprocedure('training_load.refuse_gpexe_team_session_timezone_delete()') is not null as refuse_delete_ok,
       to_regprocedure('training_load.gpexe_team_session_timezone_history_append_only()') is not null as append_only_ok;

-- 3. The six triggers are enabled.
select count(*) = 6 as triggers_ok
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'training_load' and not t.tgisinternal and t.tgenabled = 'O'
   and c.relname in ('gpexe_team_session_timezones', 'gpexe_team_session_timezone_history');

-- 4. No zone is set yet (the first one is a platform admin's write through Settings > Data sources).
select (select count(*) from training_load.gpexe_team_session_timezones) = 0 as no_zone_rows,
       (select count(*) from training_load.gpexe_team_session_timezone_history) = 0 as no_history_rows;

-- 5. No idle transaction or lock wait left behind.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

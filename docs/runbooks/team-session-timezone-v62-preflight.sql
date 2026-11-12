-- Read-only PREFLIGHT for migration v62 (migrations_v2/202611111200_training_load_v62_team_session_timezone.sql); run before the deploy that applies it (the Rukovodilac, Supabase SQL Editor,
-- each block in a read-only transaction). Changes nothing. Every block returns rows with ok = true (or the stated facts).

-- 1. v61 is the last applied migration and v62 is not recorded. (If another migration took the number first, this file is
--    re-issued with the renumbered name.)
select (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%')
         = 'migrations_v2/202611101200_training_load_v61_import_states_approval.sql' as ok,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611111200_training_load_v62_team_session_timezone.sql') as v62_absent;

-- 2. No v62 object exists yet; the two v24 / v22 functions v62 calls are there.
select to_regclass('training_load.gpexe_team_session_timezones') is null as no_table,
       to_regclass('training_load.gpexe_team_session_timezone_history') is null as no_history,
       to_regprocedure('training_load.guard_gpexe_team_session_timezone()') is null as no_guard,
       to_regprocedure('training_load.hold_gpexe_team_lock(uuid,text)') is not null as team_lock_fn,
       to_regprocedure('training_load.gpexe_history_no_truncate()') is not null as no_truncate_fn;

-- 3. PostgreSQL knows the zone the owner chose for First team (the application checks it again on the write).
select exists (select 1 from pg_catalog.pg_timezone_names where name = 'Europe/Sarajevo') as sarajevo_known;

-- 4. A quiet moment: no check running, no idle transaction, no lock wait.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from training_load.gpexe_import_checks where status = 'running') as no_running_check;

-- 5. The role you run this as may create in the schema.
select has_schema_privilege(current_user, 'training_load', 'CREATE') as may_create;

-- 6. Facts to read: how many candidates are blocked by mixed time zones today (a later search of their dates, once the
--    team's zone is set, previews them through it).
select count(*) as mixed_timezone_candidates
  from training_load.gpexe_import_candidates c
 where c.status in ('pending', 'blocked') and c.preview -> 'blocked' ->> 'code' = 'mixed_timezones';

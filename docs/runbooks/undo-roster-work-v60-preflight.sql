-- Read-only PREFLIGHT for migration v60 (migrations_v2/202611101000_training_load_v60_undo_roster_work.sql); run before the deploy
-- that applies it (the Rukovodilac, Supabase SQL Editor, each block in a read-only transaction). Changes nothing. Every block
-- returns rows with ok = true (or the stated facts).

-- 1. v59 is the last applied migration and v60 is not recorded.
select (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%')
         = 'migrations_v2/202611091100_training_load_v59_import_approval_subset.sql' as ok,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611101000_training_load_v60_undo_roster_work.sql') as v60_absent;

-- 2. The bodies v60 replaces or copies are the ones it expects (md5 of prosrc); the migration refuses to run otherwise.
select n.nspname || '.' || p.proname as fn, md5(p.prosrc) as actual_md5, md5(p.prosrc) = e.m as ok
  from (values ('training_load', 'undo_imported_session', 'ae5aa129708a03a602b9cdc596e1e11a'),
               ('training_load', 'session_undo_scope', 'f605cb502a36a4d8e372373fe1e2207a'),
               ('training_load', 'session_undo_marker_ok', '393c18c8b7228793fd47a0122d63cf02'),
               ('training_load', 'validate_import_deletion_log', 'ccd1157ee00901c66d3bf4c031763bf7'),
               ('training', 'protect_activity_roster_request', 'd653da02d80b0e844105c606017917c4'),
               ('training', 'check_activity_athlete_decision', 'd911a55ffeb641ab296488f7faa2569f'),
               ('training', 'protect_activity_completion', '4ad9534602ec7cae22d2e4560b9bdeed'),
               ('training', 'protect_activity_completion_log', '2cd36fa02adf8af1c41436225459d0ad')) e(s, f, m)
  join pg_namespace n on n.nspname = e.s join pg_proc p on p.pronamespace = n.oid and p.proname = e.f
 order by 1;

-- 3. undo_imported_session exists once, with v57's six arguments; no v60 object exists yet.
select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'undo_imported_session') = 1 as one_undo,
       to_regprocedure('training_load.undo_imported_session(uuid,uuid,uuid,uuid,text,uuid)') is not null as six_arguments,
       to_regprocedure('training_load.session_undo_roster_work(uuid[])') is null as no_roster_work_fn,
       not exists (select 1 from information_schema.columns where table_schema = 'training' and table_name = 'activity_roster_requests' and column_name = 'origin') as no_origin_column,
       not exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'import_deletion_log' and column_name = 'roster_work_removed') as no_log_column;

-- 4. The five triggers v60 re-points exist, are enabled and point at their originals.
select (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
         where not t.tgisinternal and t.tgenabled = 'O'
           and (t.tgname, p.proname) in (('activity_roster_requests_protect', 'protect_activity_roster_request'),
                                         ('activity_athlete_decisions_check', 'check_activity_athlete_decision'),
                                         ('activity_completions_protect', 'protect_activity_completion'),
                                         ('activity_completion_log_protect', 'protect_activity_completion_log'),
                                         ('import_deletion_log_validate', 'validate_import_deletion_log'))) = 5 as ok;

-- 5. A quiet moment: no undo, roster command or check in flight (ALTER TABLE takes a short lock on the requests and the log).
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from training_load.gpexe_import_checks where status = 'running') as no_running_check;

-- 6. The role you run this as is, or is a member of, the owner of the two altered tables.
select pg_has_role(current_user, (select relowner from pg_class where oid = 'training.activity_roster_requests'::regclass), 'USAGE') as owns_requests,
       pg_has_role(current_user, (select relowner from pg_class where oid = 'training_load.import_deletion_log'::regclass), 'USAGE') as owns_log;

-- 7. Facts to read: every existing roster request becomes 'roster' (DEFAULT, no rewrite); the existing log rows carry no roster work.
select (select count(*) from training.activity_roster_requests) as roster_requests,
       (select count(*) from training_load.import_deletion_log) as deletion_log_rows,
       (select count(*) from training_load.gpexe_session_undo_requests) as undo_requests;

-- Read-only POST-CHECK for migration v60 (migrations_v2/202611101000_training_load_v60_undo_roster_work.sql); run after the deploy.
-- Changes nothing. Every block returns rows with ok = true (or the stated counts).

-- 1. v60 is recorded once and is the last migration.
select count(*) = 1 as recorded_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611101000_training_load_v60_undo_roster_work.sql' as is_last
  from public.schema_migrations where migration_name = 'migrations_v2/202611101000_training_load_v60_undo_roster_work.sql';

-- 2. The v60 bodies are in force (md5 of prosrc).
select n.nspname || '.' || p.proname as fn, md5(p.prosrc) as actual_md5, md5(p.prosrc) = e.m as ok
  from (values ('training_load', 'undo_imported_session', '3d78cc86dfa3be3c25d2cb0dc0a858e0'),
               ('training_load', 'session_undo_scope', 'b6f34358816e7ae382f1385b650b95f0'),
               ('training_load', 'session_undo_roster_work', 'db79c567aaa930460878d000a8211eb3'),
               ('training_load', 'session_undo_roster_log_ok', '6d2426bb475d341aa545ffdb8d25fa8d'),
               ('training_load', 'validate_import_deletion_log_v60', '1c949a5f6a8383724ec1836b0ed3dddd'),
               ('training', 'protect_activity_roster_request_v60', 'b80d37661ee1b9dc021b6d08b8e74993'),
               ('training', 'check_activity_athlete_decision_v60', 'cb038617f44d1e6028825d73f5048c64'),
               ('training', 'protect_activity_completion_v60', '1bd5b84c90536e4a7802e2ed2c3e7229'),
               ('training', 'protect_activity_completion_log_v60', '310479ead5bac4ba0ada834a6c20543c')) e(s, f, m)
  join pg_namespace n on n.nspname = e.s join pg_proc p on p.pronamespace = n.oid and p.proname = e.f
 order by 1;

-- 3. The undo exists once, with seven arguments; v57's six-argument signature is gone.
select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'undo_imported_session') = 1 as one_undo,
       to_regprocedure('training_load.undo_imported_session(uuid,uuid,uuid,uuid,text,uuid,text)') is not null as seven_arguments,
       to_regprocedure('training_load.undo_imported_session(uuid,uuid,uuid,uuid,text,uuid)') is null as six_arguments_gone;

-- 4. The five triggers point at the v60 functions and are enabled; the TRUNCATE and append-only triggers are unchanged.
select (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
         where not t.tgisinternal and t.tgenabled = 'O'
           and (t.tgname, p.proname) in (('activity_roster_requests_protect', 'protect_activity_roster_request_v60'),
                                         ('activity_athlete_decisions_check', 'check_activity_athlete_decision_v60'),
                                         ('activity_completions_protect', 'protect_activity_completion_v60'),
                                         ('activity_completion_log_protect', 'protect_activity_completion_log_v60'),
                                         ('import_deletion_log_validate', 'validate_import_deletion_log_v60'))) = 5 as ok,
       (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
         where not t.tgisinternal and t.tgenabled = 'O'
           and (t.tgname, p.proname) in (('activity_roster_requests_no_truncate', 'roster_history_no_truncate'),
                                         ('activity_athlete_decisions_no_truncate', 'roster_history_no_truncate'),
                                         ('activity_completions_no_truncate', 'roster_history_no_truncate'),
                                         ('activity_completion_log_no_truncate', 'roster_history_no_truncate'),
                                         ('import_deletion_log_no_truncate', 'import_deletion_log_append_only'),
                                         ('import_deletion_log_no_update_delete', 'import_deletion_log_append_only'))) = 6 as history_guards_ok;

-- 5. The two columns: origin NOT NULL DEFAULT 'roster' with its CHECK; roster_work_removed nullable.
select (select is_nullable = 'NO' and column_default like '''roster''%' from information_schema.columns
         where table_schema = 'training' and table_name = 'activity_roster_requests' and column_name = 'origin') as origin_ok,
       exists (select 1 from pg_constraint where conname = 'activity_roster_requests_origin_check'
                and conrelid = 'training.activity_roster_requests'::regclass) as origin_check_ok,
       (select is_nullable = 'YES' and data_type = 'jsonb' from information_schema.columns
         where table_schema = 'training_load' and table_name = 'import_deletion_log' and column_name = 'roster_work_removed') as log_column_ok;

-- 6. The deploy wrote nothing new: every existing request is 'roster', no log row carries roster work.
select count(*) filter (where origin = 'roster') as roster_requests,
       count(*) filter (where origin = 'import') = 0 as no_import_requests,
       (select count(*) from training_load.import_deletion_log where roster_work_removed is not null) = 0 as no_roster_log_rows
  from training.activity_roster_requests;

-- 7. Nothing is stuck.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx;

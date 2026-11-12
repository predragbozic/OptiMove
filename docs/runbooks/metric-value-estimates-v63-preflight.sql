-- Read-only PREFLIGHT for migration v63 (migrations_v2/202611121000_training_load_v63_metric_value_estimates.sql); run before the
-- deploy that applies it (the Rukovodilac, Supabase SQL Editor, each block in a read-only transaction). Changes nothing. Every
-- block returns rows with ok = true.

-- 1. v62 is the last applied migration and v63 is not recorded; v62's table is there (v63 refuses to run without it).
select (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%')
         = 'migrations_v2/202611111200_training_load_v62_team_session_timezone.sql' as ok,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611121000_training_load_v63_metric_value_estimates.sql') as v63_absent,
       to_regclass('training_load.gpexe_team_session_timezones') is not null as v62_table;

-- 2. The two session undo bodies in force are v60's (v63 replaces them under this md5 gate).
select (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'session_undo_scope') = 'b6f34358816e7ae382f1385b650b95f0' as scope_is_v60,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'undo_imported_session') = '3d78cc86dfa3be3c25d2cb0dc0a858e0' as undo_is_v60,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname in ('session_undo_scope', 'undo_imported_session')) = 2 as each_once;

-- 3. Exactly one entry_method CHECK and one source_policy CHECK (v63 replaces each by its definition).
select (select count(*) from pg_constraint where conrelid = 'training_load.metric_measurement_occasions'::regclass
         and contype = 'c' and pg_get_constraintdef(oid) like '%entry_method%') = 1 as one_entry_method_check,
       (select count(*) from pg_constraint where conrelid = 'training_load.dashboard_widget_series'::regclass
         and contype = 'c' and pg_get_constraintdef(oid) like '%source_policy%all_with_conflicts%') = 1 as one_source_policy_check;

-- 4. No v63 object yet; the functions v63 calls are there; PostgreSQL 13 or later (pg_current_xact_id()).
select to_regclass('training_load.metric_value_estimates') is null as no_table,
       to_regprocedure('training_load.estimate_context_actor()') is null as no_actor_fn,
       to_regprocedure('training_load.session_undo_marker_ok()') is not null as marker_fn,
       to_regprocedure('training_load.forbid_update_delete()') is not null as forbid_fn,
       current_setting('server_version_num')::int >= 130000 as pg13_or_later;

-- 5. A quiet moment: no idle transaction, no lock wait, no running check.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from training_load.gpexe_import_checks where status = 'running') as no_running_check;

-- 6. The role you run this as may create in the schema.
select has_schema_privilege(current_user, 'training_load', 'CREATE') as may_create;

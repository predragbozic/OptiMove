-- Read-only PREFLIGHT for migration v57 (migrations_v2/202611051000_training_load_v57_session_undo.sql); run before the deploy that
-- applies it (the Rukovodilac, Supabase SQL Editor, each block in a read-only transaction). Changes nothing. Every block
-- returns rows with ok = true.

-- 1. The last applied migration is v56 (or a later one that is not v57) and v57 is not recorded.
select (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%')
         >= 'migrations_v2/202611041400_training_load_v56_team_import_switch.sql' as ok,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611051000_training_load_v57_session_undo.sql') as v57_absent,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%'
                    and migration_name > 'migrations_v2/202611051000_training_load_v57_session_undo.sql') as nothing_after_v57;

-- 2. The five bodies v57 copies are the ones in force (md5 of prosrc); the migration refuses to run otherwise.
select count(*) over () = 5 as all_five_present, n.nspname || '.' || p.proname as function, md5(p.prosrc) as actual_md5,
       md5(p.prosrc) = case p.proname
         when 'forbid_update_delete' then '2a0b9cc2529c6fd401840b20ec86cf03'
         when 'source_metric_append_only' then 'ce27068e9a81b17f613eb038f58daf91'
         when 'forbid_event_source_binding_delete' then '0831dafc47b1b8c7609ab96d759f1834'
         when 'protect_gpexe_import_candidate' then '7d8a5d443864d8fa05195db752906f29'
         when 'protect_activity_source_observation' then 'b9d2efb9eebb71138286dcc31f46e9c6' end as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname, p.proname) in (('training_load', 'forbid_update_delete'), ('training_load', 'source_metric_append_only'),
                                  ('training_load', 'forbid_event_source_binding_delete'), ('training_load', 'protect_gpexe_import_candidate'),
                                  ('training', 'protect_activity_source_observation'))
 order by 1;

-- 3. None of the v57 objects exists yet; the candidate key is still the full unique constraint; the five triggers point at the originals.
select to_regclass('training_load.gpexe_session_undo_requests') is null as no_request_table,
       to_regprocedure('training_load.undo_imported_session(uuid,uuid,uuid,uuid,text,uuid)') is null as no_function,
       not exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_import_candidates'
                    and column_name in ('import_undone_at', 'import_undone_request_id')) as no_new_columns,
       exists (select 1 from pg_constraint where conname = 'gpexe_import_candidates_owner_team_id_gpexe_team_session_id_key'
                  and conrelid = 'training_load.gpexe_import_candidates'::regclass) as original_unique,
       (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
         where not t.tgisinternal and t.tgenabled = 'O'
           and (t.tgname, p.proname) in (('metric_values_immutable', 'forbid_update_delete'),
                                         ('metric_event_source_bindings_no_delete', 'forbid_event_source_binding_delete'),
                                         ('metric_value_source_provenance_append_only', 'source_metric_append_only'),
                                         ('activity_source_observations_append_only', 'protect_activity_source_observation'),
                                         ('gpexe_import_candidates_protect', 'protect_gpexe_import_candidate'),
                                         ('gpexe_import_candidates_protect_insert', 'protect_gpexe_import_candidate'))) = 6 as six_triggers_original;

-- 4. No import, approval or check is in flight and the moment is quiet (the migration takes short locks on the protected tables).
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from training_load.gpexe_import_checks where status = 'running') as no_running_check;

-- 5. The role you run this as is, or is a member of, the owner of the tables and functions v57 changes.
select pg_has_role(current_user, (select relowner from pg_class where oid = 'training_load.gpexe_import_candidates'::regclass), 'USAGE') as owns_candidates,
       pg_has_role(current_user, (select relowner from pg_class where oid = 'training_load.metric_values'::regclass), 'USAGE') as owns_metric_values,
       pg_has_role(current_user, (select relowner from pg_class where oid = 'training.activity_source_observations'::regclass), 'USAGE') as owns_observations,
       pg_has_role(current_user, (select relowner from pg_class where oid = 'training_load.metric_value_source_provenance'::regclass), 'USAGE') as owns_provenance;

-- 6. Facts to read: how many imported candidates exist, and that no undo has ever run (the deletion log holds the CLI's rows only).
select (select count(*) from training_load.gpexe_import_candidates where status = 'imported') as imported_candidates,
       (select count(*) from training_load.import_deletion_log) as deletion_log_rows,
       (select count(*) from training_load.gpexe_import_candidates c
         where status = 'imported'
           and not exists (select 1 from training_load.gpexe_import_approvals a where a.candidate_id = c.id)) as imported_without_approval_expected_zero;

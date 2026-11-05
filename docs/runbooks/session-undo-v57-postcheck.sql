-- Read-only POST-CHECK for migration v57 (migrations_v2/202611051000_training_load_v57_session_undo.sql); run after the deploy.
-- Changes nothing. Every block returns rows with ok = true (or the stated counts).

-- 1. v57 is recorded once and is the last migration.
select count(*) = 1 as recorded_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611051000_training_load_v57_session_undo.sql' as is_last
  from public.schema_migrations where migration_name = 'migrations_v2/202611051000_training_load_v57_session_undo.sql';

-- 2. The new bodies are in force (md5 of prosrc).
select p.proname as function, md5(p.prosrc) as actual_md5,
       md5(p.prosrc) = case p.proname
         when 'forbid_update_delete_unless_session_undo' then '2ffa110ec96ea1966291c876be457460'
         when 'forbid_event_source_binding_delete_unless_session_undo' then '7d181f998af3d88f7edfed027f421fe6'
         when 'source_metric_append_only_unless_session_undo' then 'f607bfcf8f618b5d394513f066d79d0b'
         when 'protect_activity_source_observation_v57' then 'ea21a2a49f320dc7d6be45becc7743f5'
         when 'protect_gpexe_import_candidate_v57' then '311d7f35e2e2ad4d56afa1f7760f78e0'
         when 'undo_imported_session' then '12da77daf860218ca498523f7f574f27'
         when 'session_undo_scope' then 'db65672ac1590d6a7e0b2e6f35fa367c' end as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('training_load', 'training')
   and p.proname in ('forbid_update_delete_unless_session_undo', 'forbid_event_source_binding_delete_unless_session_undo',
                     'source_metric_append_only_unless_session_undo', 'protect_activity_source_observation_v57',
                     'protect_gpexe_import_candidate_v57', 'undo_imported_session', 'session_undo_scope')
 order by 1;

-- 3. The six triggers point at the v57 functions and are enabled; the originals' functions still exist.
select (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
         where not t.tgisinternal and t.tgenabled = 'O'
           and (t.tgname, p.proname) in (('metric_values_immutable', 'forbid_update_delete_unless_session_undo'),
                                         ('metric_event_source_bindings_no_delete', 'forbid_event_source_binding_delete_unless_session_undo'),
                                         ('metric_value_source_provenance_append_only', 'source_metric_append_only_unless_session_undo'),
                                         ('activity_source_observations_append_only', 'protect_activity_source_observation_v57'),
                                         ('gpexe_import_candidates_protect', 'protect_gpexe_import_candidate_v57'),
                                         ('gpexe_import_candidates_protect_insert', 'protect_gpexe_import_candidate_v57'))) = 6 as six_triggers_v57,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where (n.nspname, p.proname) in (('training_load', 'forbid_update_delete'), ('training_load', 'source_metric_append_only'),
                                          ('training_load', 'forbid_event_source_binding_delete'), ('training_load', 'protect_gpexe_import_candidate'),
                                          ('training', 'protect_activity_source_observation'))) = 5 as five_originals_kept,
       (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'training_load' and c.relname = 'gpexe_session_undo_requests' and not t.tgisinternal and t.tgenabled = 'O') = 2 as request_guards_enabled;

-- 4. The candidate key is the partial unique index; the undone columns, their constraints and the request table exist.
select exists (select 1 from pg_indexes where schemaname = 'training_load' and indexname = 'gpexe_import_candidates_live_content_key'
                  and indexdef like '%WHERE (import_undone_at IS NULL)%') as partial_key,
       not exists (select 1 from pg_constraint where conname = 'gpexe_import_candidates_owner_team_id_gpexe_team_session_id_key') as old_unique_gone,
       (select count(*) from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_import_candidates'
         and column_name in ('import_undone_at', 'import_undone_request_id')) = 2 as two_columns,
       (select count(*) from pg_constraint where conrelid = 'training_load.gpexe_import_candidates'::regclass
         and conname in ('gpexe_import_candidates_import_undone_request_fkey', 'gpexe_import_candidates_import_undone_together',
                         'gpexe_import_candidates_import_undone_imported')) = 3 as three_constraints,
       to_regclass('training_load.gpexe_session_undo_requests') is not null as request_table;

-- 5. Nothing was undone by the deploy: no request row, no undone candidate (until the owner-run first undo).
select (select count(*) from training_load.gpexe_session_undo_requests) as request_rows,
       (select count(*) from training_load.gpexe_import_candidates where import_undone_at is not null) as undone_candidates;

-- 6. No marker leaked and nothing is stuck.
select coalesce(current_setting('optimove.session_undo_tx', true), '') = '' as no_marker,
       not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx;

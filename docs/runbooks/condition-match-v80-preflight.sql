-- Read-only PREFLIGHT for migration v80 (migrations_v2/202611201100_training_load_v80_condition_match.sql); run before the
-- deploy that applies it (the Rukovodilac, Supabase SQL Editor, each block in a read-only transaction). Changes nothing. Every
-- block returns ok = true, or the stated counts.

-- 1. v79 (the last Metrics Core migration before it) is recorded and v80 is not. Other migrations (the calendar's v81) may be
--    recorded or not; the list is for the reader only.
select exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611191200_training_load_v79_calculated_ratio_difference.sql') as v79_recorded,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611201100_training_load_v80_condition_match.sql') as v80_absent,
       (select string_agg(migration_name, ', ' order by migration_name) from public.schema_migrations
         where migration_name > 'migrations_v2/202611191200_training_load_v79_calculated_ratio_difference.sql') as recorded_after_v79;

-- 2. Nothing v80 adds exists yet (no column, function, trigger or table of that name).
select not exists (select 1 from information_schema.columns where table_schema = 'training_load'
                    and ((table_name = 'source_metric_mapping_versions' and column_name = 'condition_rule')
                      or (table_name = 'source_metric_mapping_activations' and column_name in ('matched_condition', 'matched_source_range', 'matched_threshold_set_id', 'matched_at')))) as no_columns,
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load'
                    and p.proname in ('condition_rule_shape_ok', 'condition_rule_fits', 'source_metric_mapping_versions_condition_guard',
                                      'source_metric_mapping_activations_match_guard', 'source_metric_event_setting_confirmations_guard')) as no_functions,
       to_regclass('training_load.source_metric_event_setting_confirmations') is null as no_table;

-- 3. v80's own refusal: no mapping version without parameters already targets a variable version with a condition (the
--    service never wrote one). Count 0.
select count(*) as kind_none_on_conditioned
  from training_load.source_metric_mapping_versions mv
  join training_load.metric_definition_versions dv on dv.id = mv.metric_definition_version_id
 where mv.parameter_kind = 'none' and dv.condition_description is not null;

-- 4. The functions v80's guard calls exist (v35's acting user and basis).
select count(*) = 2 as actor_functions
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'training_load' and p.proname in ('source_metric_context_actor', 'source_metric_actor_basis');

-- 5. A quiet moment: no idle transaction and no lock wait (the migration takes the mapping versions' and activations'
--    ACCESS EXCLUSIVE lock for a catalog-only ADD COLUMN, with a 5 s lock_timeout).
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

-- 6. The role you run this as owns (or is a member of the owner of) the two tables v80 alters.
select bool_and(pg_has_role(current_user, c.relowner, 'USAGE')) as owns_tables
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'training_load' and c.relname in ('source_metric_mapping_versions', 'source_metric_mapping_activations');

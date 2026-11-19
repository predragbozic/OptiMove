-- Read-only POST-CHECK for migration v80 (migrations_v2/202611201100_training_load_v80_condition_match.sql); run after its
-- deploy (the Rukovodilac, Supabase SQL Editor, each block in a read-only transaction). Changes nothing. Every block returns
-- ok = true, or the stated counts.

-- 1. v80 is recorded once (compare checksum with the file's sha256). Later migrations of other tracks may be recorded.
select count(*) = 1 as v80_once,
       max(checksum) as checksum
  from public.schema_migrations where migration_name = 'migrations_v2/202611201100_training_load_v80_condition_match.sql';

-- 2. The five columns, the confirmations table and its index exist.
select (select count(*) from information_schema.columns where table_schema = 'training_load'
          and ((table_name = 'source_metric_mapping_versions' and column_name = 'condition_rule')
            or (table_name = 'source_metric_mapping_activations' and column_name in ('matched_condition', 'matched_source_range', 'matched_threshold_set_id', 'matched_at')))) = 5 as five_columns,
       to_regclass('training_load.source_metric_event_setting_confirmations') is not null as confirmations_table,
       to_regclass('training_load.source_metric_event_setting_confirmations_version_idx') is not null as confirmations_index;

-- 3. The four guard triggers are enabled.
select count(*) = 4 as triggers_enabled
  from pg_trigger
 where tgenabled = 'O' and tgname in ('source_metric_mapping_versions_condition_guard', 'source_metric_mapping_activations_match_guard',
                                       'source_metric_event_setting_confirmations_guard', 'source_metric_event_setting_confirmations_no_truncate');

-- 4. Nothing matched yet (step C, the screen, and the owner's confirmations come later): every count 0.
select (select count(*) from training_load.source_metric_mapping_versions where condition_rule is not null) as versions_with_rule,
       (select count(*) from training_load.source_metric_mapping_activations where matched_condition is not null) as matched_activations,
       (select count(*) from training_load.source_metric_event_setting_confirmations) as event_setting_confirmations;

-- 5. No idle transaction and no lock wait left behind.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

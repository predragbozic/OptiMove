-- Read-only POST-CHECK for migration v88 (a session type per athlete, ST-3;
-- migrations_v2/202611221300_training_load_v88_participant_session_types.sql). Run it right after the deploy
-- (docs/runbooks/participant-session-types-v88.md). Changes nothing: run each block as
--   begin transaction read only; <block>; rollback;
-- Every block returns ok columns that must all be true.

-- 1. v88 recorded once with a shaped checksum.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611221300_training_load_v88_participant_session_types.sql') = 1 as v88_recorded_once,
       (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611221300_training_load_v88_participant_session_types.sql') ~ '^[0-9a-f]{64}$' as checksum_shaped,
       (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611221300_training_load_v88_participant_session_types.sql') as checksum_for_the_reader;

-- 2. The objects: the two tables, the functions, the triggers (every one enabled), the one-live-row index.
select to_regclass('training.participant_activity_types') is not null as exception_table,
       to_regclass('training.activity_type_requests') is not null as request_table,
       to_regclass('training.participant_activity_types_one_live') is not null as one_live_index,
       (select count(*) from pg_proc where pronamespace = 'training'::regnamespace
         and proname in ('effective_activity_type', 'session_type_team_decider', 'participant_activity_types_before_write',
                         'participant_activity_types_no_truncate', 'activity_type_requests_before_write',
                         'activity_field_correction_log_no_delete')) = 6 as functions,
       (select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and tgname in (
          'participant_activity_types_before_write', 'participant_activity_types_no_truncate', 'activity_type_requests_before_write',
          'activity_type_requests_no_truncate', 'activity_field_correction_log_no_delete', 'activity_field_correction_log_no_truncate')) = 6 as triggers_enabled;

-- 3. The two replaced bodies are v88's; the correction log's key cascades.
select (select md5(prosrc) from pg_proc where pronamespace = 'training'::regnamespace and proname = 'merge_activity_participants') = 'f6fa45c13fcd11765b9d2eac5b2cd80e' as merge_body_is_v88,
       (select md5(prosrc) from pg_proc where pronamespace = 'training'::regnamespace and proname = 'reparent_activity_participant') = '0b3f25f34d823af811c8cb824861e4bf' as reparent_body_is_v88,
       (select confdeltype from pg_constraint where conname = 'activity_field_correction_log_activity_id_fkey'
          and conrelid = 'training.activity_field_correction_log'::regclass) = 'c' as correction_log_key_cascades,
       (select convalidated from pg_constraint where conname = 'activity_field_correction_log_activity_id_fkey'
          and conrelid = 'training.activity_field_correction_log'::regclass) as correction_log_key_valid;

-- 4. Nothing written by a user yet (right after the deploy): no exception, no request row.
select not exists (select 1 from training.participant_activity_types) as no_exception_rows,
       not exists (select 1 from training.activity_type_requests) as no_request_rows;

-- 5. No idle transaction, no lock wait.
select not exists (select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction') as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

-- Read-only PREFLIGHT for migration v88 (a session type per athlete, ST-3;
-- migrations_v2/202611221300_training_load_v88_participant_session_types.sql). Run it right before the merge, at the quiet
-- moment chosen for it (docs/runbooks/participant-session-types-v88.md). Changes nothing: run each block as
--   begin transaction read only; <block>; rollback;
-- Every block returns ok columns that must all be true; block 3 is also for the reader.

-- 1. The server, the last recorded migration (for the reader), v88 not recorded, v85 recorded, the checksums shaped.
select current_setting('server_version_num')::int >= 150000 as server_15_or_later,
       current_setting('server_version') as server_version,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611221300_training_load_v88_participant_session_types.sql') as v88_not_recorded,
       exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611201500_training_load_v85_session_types.sql') as v85_recorded,
       not exists (select 1 from public.schema_migrations where checksum is null or checksum !~ '^[0-9a-f]{64}$') as checksums_shaped;

-- 2. Nothing v88 adds exists; what it builds on does; the two bodies it replaces are v4's; the correction log's key is v1's.
select to_regclass('training.participant_activity_types') is null as no_exception_table,
       to_regclass('training.activity_type_requests') is null as no_request_table,
       not exists (select 1 from pg_proc where pronamespace = 'training'::regnamespace
                    and proname in ('effective_activity_type', 'session_type_team_decider', 'participant_activity_types_before_write',
                                    'participant_activity_types_no_truncate', 'activity_type_requests_before_write',
                                    'activity_field_correction_log_no_delete')) as no_functions,
       to_regprocedure('training.session_type_offered(text, uuid, boolean)') is not null as v85_offered,
       to_regprocedure('training.lock_activity_decider(uuid, uuid, character varying)') is not null as v54_decider,
       to_regprocedure('training_load.session_undo_marker_ok()') is not null as v57_marker,
       (select md5(prosrc) from pg_proc where pronamespace = 'training'::regnamespace and proname = 'merge_activity_participants') = 'c3c16b64fe37f1511e42a7db50d68063' as merge_body_is_v4,
       (select md5(prosrc) from pg_proc where pronamespace = 'training'::regnamespace and proname = 'reparent_activity_participant') = 'be3b50ce3e52750fb80e09e31b9bc4e8' as reparent_body_is_v4,
       (select confdeltype from pg_constraint where conname = 'activity_field_correction_log_activity_id_fkey'
          and conrelid = 'training.activity_field_correction_log'::regclass) = 'a' as correction_log_key_is_v1;

-- 3. For the reader: the correction log's size (v88 rebuilds its foreign key, which checks every row once) and the activities.
select (select count(*) from training.activity_field_correction_log) as correction_log_rows,
       (select count(*) from training.activities) as activities,
       (select count(*) from training.activity_field_correction_log) < 100000 as correction_log_small;

-- 4. A quiet moment: no idle transaction, no lock wait, no long transaction on the tables v88 locks.
select not exists (select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction') as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
                    where l.relation in ('training.activities'::regclass, 'training.activity_participants'::regclass,
                                         'training.activity_field_correction_log'::regclass, 'training.activity_types'::regclass)
                      and a.xact_start < now() - interval '30 seconds' and a.pid <> pg_backend_pid()) as no_long_tx_on_activity_tables;

-- 5. (In git, not SQL) the 12-digit prefix is unique on the merge tree (.claude/rules/migrations.md):
--   git ls-tree --name-only $(git merge-tree --write-tree origin/main <head>) migrations_v2/ | sed 's#.*/##' | grep -E '^[0-9]{12}_' | cut -c1-12 | sort | uniq -d
--   must print nothing.

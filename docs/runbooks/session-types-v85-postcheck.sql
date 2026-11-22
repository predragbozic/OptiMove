-- Read-only POST-CHECK for migration v85 (session types, ST-1; migrations_v2/202611201500_training_load_v85_session_types.sql).
-- Run it right after the deploy (docs/runbooks/session-types-v85.md). Changes nothing: run each block as
--   begin transaction read only; <block>; rollback;
-- Every block returns ok columns that must all be true; block 6 is also compared with preflight block 3a by the reader.

-- 1. v85 recorded once with a shaped checksum.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611201500_training_load_v85_session_types.sql') = 1 as v85_recorded_once,
       (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611201500_training_load_v85_session_types.sql') ~ '^[0-9a-f]{64}$' as checksum_shaped,
       (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611201500_training_load_v85_session_types.sql') as checksum_for_the_reader;

-- 2. The seed: the six active system types with the owner's labels, testing and recovery archived without a user.
select (select string_agg(key || '=' || label, ', ' order by sort_order, key) from training.activity_types where is_active and owner_scope = 'system')
         = 'training_session=Full training, match=Game, friendly_match=Friendly game, exercise_session=Exercise, compensation_session=Compensation, rtp_session=RTP' as six_active,
       (select count(*) from training.activity_types where key in ('testing_session', 'recovery_session') and not is_active and archived_at is not null and archived_by_user_id is null) = 2 as two_archived,
       not exists (select 1 from training.activity_types where owner_scope = 'club') as no_club_type_yet;

-- 3. The objects: the change log, the source map, the functions and the triggers, every trigger enabled.
select to_regclass('training.activity_type_changes') is not null as change_log,
       to_regclass('training_load.source_session_types') is not null as source_map,
       (select count(*) from pg_proc where pronamespace = 'training'::regnamespace
         and proname in ('session_type_actor', 'session_type_basis', 'session_type_offered', 'activity_types_before_write', 'activity_types_no_truncate',
                         'activity_types_change_logged', 'activity_type_changes_before_insert', 'activity_type_changes_append_only',
                         'activities_session_type_guard')) = 9 as training_functions,
       (select count(*) from pg_proc where pronamespace = 'training_load'::regnamespace and proname = 'source_session_types_before_write') = 1 as map_function,
       (select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and tgname in (
          'activity_types_before_write', 'activity_types_no_truncate', 'activity_types_change_logged', 'activity_type_changes_before_insert',
          'activity_type_changes_no_update', 'activity_type_changes_no_truncate', 'activities_session_type_guard',
          'source_session_types_before_write', 'source_session_types_no_truncate')) = 9 as triggers_enabled,
       (select tgdeferrable and tginitdeferred from pg_trigger where tgname = 'activity_types_change_logged') as change_logged_deferred;

-- 4. Nothing written by a user yet: no change row, the source map holds the seed only.
select not exists (select 1 from training.activity_type_changes) as no_change_rows,
       not exists (select 1 from training_load.source_session_types where not seeded) as source_map_seed_only,
       (select count(*) from training_load.source_session_types)
         = (select count(distinct team_id) from training_load.source_team_bindings where source_system = 'gpexe' and state = 'active') as one_seed_per_bound_team;

-- 5. Every activity holds a type its owner is offered (system types today).
select not exists (select 1 from training.activities a join training.activity_types t on t.key = a.activity_type_key
                    where t.owner_scope = 'club') as no_club_type_on_activities;

-- 6. For the reader, compared with preflight block 3a: the activities per type (unchanged: v85 writes no activity).
select (select string_agg(coalesce(activity_type_key, '(none)') || '=' || n, ', ' order by activity_type_key)
          from (select activity_type_key, count(*) as n from training.activities group by activity_type_key) s) as activities_per_type;

-- 7. No idle transaction, no lock wait.
select not exists (select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction') as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

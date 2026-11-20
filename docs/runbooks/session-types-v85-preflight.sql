-- Read-only PREFLIGHT for migration v85 (session types, ST-1; migrations_v2/202611201500_training_load_v85_session_types.sql).
-- Run it right before the merge, at the quiet moment chosen for it (docs/runbooks/session-types-v85.md). Changes nothing:
-- run each block as
--   begin transaction read only; <block>; rollback;
-- Every block returns ok columns that must all be true; block 3a is also for the reader (post-check block 6 compares it).

-- 1. The server, the last recorded migration (for the reader), v85 not recorded, the checksums shaped.
select current_setting('server_version_num')::int >= 150000 as server_15_or_later,
       current_setting('server_version') as server_version,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611201500_training_load_v85_session_types.sql') as v85_not_recorded,
       not exists (select 1 from public.schema_migrations where checksum is null or checksum !~ '^[0-9a-f]{64}$') as checksums_shaped;

-- 2. training.activity_types is the v1 shape (key, label, is_active, created_at) and holds the four v1 types; the keys
--    v85 seeds are free; nothing v85 adds exists.
select (select count(*) from information_schema.columns where table_schema = 'training' and table_name = 'activity_types') = 4 as v1_shape,
       (select count(*) from training.activity_types where key in ('training_session', 'match', 'testing_session', 'recovery_session')) = 4 as v1_types_present,
       not exists (select 1 from training.activity_types where key in ('friendly_match', 'exercise_session', 'compensation_session', 'rtp_session')) as new_keys_free,
       to_regclass('training.activity_type_changes') is null as no_change_log,
       to_regclass('training_load.source_session_types') is null as no_source_map,
       not exists (select 1 from pg_proc where pronamespace = 'training'::regnamespace
                    and proname in ('session_type_actor', 'session_type_basis', 'session_type_offered', 'activity_types_before_write',
                                    'activity_types_change_logged', 'activities_session_type_guard')) as no_functions;

-- 3. Every type's label passes the label check v85 adds (otherwise its ALTER fails), and every live label is unique per
--    owner (all are system types today).
select not exists (select 1 from training.activity_types where not training_load.source_metric_text_ok(label, 60)) as labels_ok,
       not exists (select lower(label) from training.activity_types where is_active group by lower(label) having count(*) > 1) as live_labels_unique,
       not exists (select 1 from training.activity_types where key !~ '^[a-z][a-z0-9_]{1,40}$') as system_keys_shaped;

-- 3a. For the reader (and post-check block 6): the types, how many activities hold each, and the active gpexe bindings
--     (the teams v85 seeds a suggestion for).
select (select string_agg(key || '=' || label || ':' || is_active::text, ', ' order by key) from training.activity_types) as types,
       (select string_agg(coalesce(activity_type_key, '(none)') || '=' || n, ', ' order by activity_type_key)
          from (select activity_type_key, count(*) as n from training.activities group by activity_type_key) s) as activities_per_type,
       (select count(distinct team_id) from training_load.source_team_bindings where source_system = 'gpexe' and state = 'active') as gpexe_bound_teams;

-- 4. No activity holds a type the owner guard would refuse later (all are system types today, so this is 0).
select not exists (select 1 from training.activities where activity_type_key is not null
                    and activity_type_key not in (select key from training.activity_types)) as ok;

-- 5. A quiet moment: no idle transaction, no lock wait, no long transaction on the activity tables.
select not exists (select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction') as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
                    where l.relation in ('training.activity_types'::regclass, 'training.activities'::regclass)
                      and a.xact_start < now() - interval '30 seconds' and a.pid <> pg_backend_pid()) as no_long_tx_on_activity_tables,
       coalesce(current_setting('optimove.session_type_actor', true), '') = '' as no_actor_setting;

-- 6. (In git, not SQL) the 12-digit prefix is unique on the merge tree (.claude/rules/migrations.md):
--   git ls-tree --name-only $(git merge-tree --write-tree origin/main <head>) migrations_v2/ | sed 's#.*/##' | grep -E '^[0-9]{12}_' | cut -c1-12 | sort | uniq -d
--   must print nothing.

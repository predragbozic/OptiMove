-- Read-only PREFLIGHT for migration v87 (athlete positions; migrations_v2/202611221200_athletes_v87_positions.sql).
-- Run it right before the merge, at the quiet moment chosen for it (docs/runbooks/athlete-positions-v87.md). Changes nothing:
-- run each block as
--   begin transaction read only; <block>; rollback;
-- Every block returns ok columns that must all be true; block 4 is for the reader (post-check block 6 compares it).

-- 1. The server, the last recorded migration (for the reader), v87 not recorded, the checksums shaped.
select current_setting('server_version_num')::int >= 150000 as server_15_or_later,
       current_setting('server_version') as server_version,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611221200_athletes_v87_positions.sql') as v87_not_recorded,
       not exists (select 1 from public.schema_migrations where checksum is null or checksum !~ '^[0-9a-f]{64}$') as checksums_shaped;

-- 2. The registry is v42's shape and empty; no sport named Football; nothing v87 adds exists.
select (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
          where table_schema = 'public' and table_name = 'sport_positions') = 'id,sport_id,name,created_at' as v42_shape,
       not exists (select 1 from public.sport_positions) as positions_empty,
       not exists (select 1 from public.sports where lower(name) = 'football') as football_free,
       exists (select 1 from pg_constraint where conrelid = 'public.sport_positions'::regclass and conname = 'sport_positions_sport_id_name_key') as v42_unique,
       to_regclass('public.athlete_positions') is null as no_assignment_table,
       to_regclass('public.sport_position_changes') is null as no_change_log,
       to_regclass('public.club_position_overrides') is null as no_override_table,
       not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                    and proname in ('position_actor', 'sport_position_basis', 'athlete_position_right', 'sport_position_offered',
                                    'athlete_position_in_force', 'sport_positions_before_write')) as no_functions;

-- 3. The estimate guards are the bodies v87 replaces (v69's estimate_basis_ok, v64's validate_metric_value_estimate) and v69's
--    method CHECK; no estimate holds a method v87 adds.
select (select md5(prosrc) from pg_proc where pronamespace = 'training_load'::regnamespace and proname = 'estimate_basis_ok') = '1ee471360a969f6895e1e697fa1facc6' as basis_body_v69,
       (select md5(prosrc) from pg_proc where pronamespace = 'training_load'::regnamespace and proname = 'validate_metric_value_estimate') = 'd4fdb1a813a4560651493af644632ea3' as guard_body_v64,
       (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'training_load.metric_value_estimates'::regclass and conname = 'metric_value_estimates_method_check')
         = 'CHECK (((method)::text = ANY ((ARRAY[''proportional''::character varying, ''copy_athlete''::character varying, ''team_average''::character varying, ''scale_recording''::character varying])::text[])))' as method_check_v69,
       not exists (select 1 from training_load.metric_value_estimates where method = 'position_average') as no_position_average;

-- 4. For the reader (and post-check block 6): the sports, the estimates per method.
select (select string_agg(name, ', ' order by name) from public.sports) as sports,
       (select string_agg(method || '=' || n, ', ' order by method)
          from (select method, count(*) as n from training_load.metric_value_estimates group by method) s) as estimates_per_method;

-- 5. A quiet moment: no idle transaction, no lock wait, no long transaction on the tables v87 alters.
select not exists (select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction') as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
                    where l.relation in ('public.sport_positions'::regclass, 'training_load.metric_value_estimates'::regclass)
                      and a.xact_start < now() - interval '30 seconds' and a.pid <> pg_backend_pid()) as no_long_tx_on_altered_tables,
       coalesce(current_setting('optimove.position_actor', true), '') = '' as no_actor_setting;

-- 6. (In git, not SQL) the 12-digit prefix is unique on the merge tree (.claude/rules/migrations.md):
--   git ls-tree --name-only $(git merge-tree --write-tree origin/main <head>) migrations_v2/ | sed 's#.*/##' | grep -E '^[0-9]{12}_' | cut -c1-12 | sort | uniq -d
--   must print nothing.

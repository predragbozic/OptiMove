-- Read-only POST-CHECK for migration v87 (athlete positions; migrations_v2/202611221200_athletes_v87_positions.sql).
-- Run it right after the deploy (docs/runbooks/athlete-positions-v87.md). Changes nothing: run each block as
--   begin transaction read only; <block>; rollback;
-- Every block returns ok columns that must all be true; block 6 is also compared with preflight block 4 by the reader.

-- 1. v87 recorded once with a shaped checksum.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611221200_athletes_v87_positions.sql') = 1 as v87_recorded_once,
       (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611221200_athletes_v87_positions.sql') ~ '^[0-9a-f]{64}$' as checksum_shaped,
       (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611221200_athletes_v87_positions.sql') as checksum_for_the_reader;

-- 2. The seed: Football and its six active system positions in order.
select (select string_agg(p.name, ', ' order by p.sort_order) from public.sport_positions p join public.sports s on s.id = p.sport_id
          where s.name = 'Football' and p.owner_scope = 'system' and p.archived_at is null)
         = 'Goalkeeper, Centre back, Full back, Midfielder, Winger, Forward' as six_positions,
       (select count(*) from public.sport_positions) = 6 as nothing_else,
       not exists (select 1 from pg_constraint where conrelid = 'public.sport_positions'::regclass and conname = 'sport_positions_sport_id_name_key') as v42_unique_replaced;

-- 3. The objects: both tables, the functions and the triggers, every trigger enabled.
select to_regclass('public.athlete_positions') is not null as assignment_table,
       to_regclass('public.sport_position_changes') is not null as change_log,
       to_regclass('public.club_position_overrides') is not null as override_table,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
         and proname in ('position_actor', 'sport_position_basis', 'athlete_position_right', 'sport_position_offered', 'athlete_position_in_force',
                         'sport_positions_before_write', 'sport_positions_no_truncate', 'sport_positions_change_logged',
                         'sport_position_changes_before_insert', 'position_history_append_only', 'athlete_positions_before_insert',
                         'club_position_overrides_before_write', 'club_position_overrides_no_truncate', 'club_position_overrides_change_logged')) = 14 as functions,
       (select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and tgname in (
          'sport_positions_before_write', 'sport_positions_no_truncate', 'sport_positions_change_logged',
          'sport_position_changes_before_insert', 'sport_position_changes_no_update', 'sport_position_changes_no_truncate',
          'athlete_positions_before_insert', 'athlete_positions_no_update', 'athlete_positions_no_truncate',
          'club_position_overrides_before_write', 'club_position_overrides_no_truncate', 'club_position_overrides_change_logged')) = 12 as triggers_enabled,
       (select tgdeferrable and tginitdeferred from pg_trigger where tgname = 'sport_positions_change_logged') as change_logged_deferred;

-- 4. The estimate guards: the v87 bodies, the method CHECK with position_average.
select (select md5(prosrc) from pg_proc where pronamespace = 'training_load'::regnamespace and proname = 'estimate_basis_ok') = 'aa000fd84278770aa9e2f8276bdbd9bb' as basis_body_v87,
       (select md5(prosrc) from pg_proc where pronamespace = 'training_load'::regnamespace and proname = 'validate_metric_value_estimate') = '0bad4b78c2b976bfecc73380f2f5cdbd' as guard_body_v87,
       (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'training_load.metric_value_estimates'::regclass and conname = 'metric_value_estimates_method_check') like '%position_average%' as method_check_v87;

-- 5. Nothing written by a user yet.
select not exists (select 1 from public.sport_position_changes) as no_change_rows,
       not exists (select 1 from public.athlete_positions) as no_assignment_rows,
       not exists (select 1 from public.club_position_overrides) as no_override_rows;

-- 6. For the reader, compared with preflight block 4: the estimates per method (unchanged: v87 writes no estimate).
select (select string_agg(method || '=' || n, ', ' order by method)
          from (select method, count(*) as n from training_load.metric_value_estimates group by method) s) as estimates_per_method;

-- 7. No idle transaction, no lock wait.
select not exists (select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction') as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

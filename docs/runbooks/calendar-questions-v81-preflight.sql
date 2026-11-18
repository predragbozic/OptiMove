-- v81 production preflight - READ ONLY. For the OptiMove manager (or the owner)
-- to run in the Supabase SQL Editor, as the application's DATABASE_URL role
-- (the one the migrator uses), on the day of the merge and deploy of the
-- K2b-2a-1 pull request (migrations_v2/202611191000_calendar_v81_athlete_questions.sql;
-- plan docs/ai/central-calendar-k2b2-plan.md, section 9.1).
--
-- Run ONE numbered block at a time: the editor shows only the result of the
-- last statement it ran. Every block is a plain SELECT. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value. v81 never assumes it is the last migration
-- (plan 9): blocks 2 and 7 only REPORT what else is recorded.

-- 1. PostgreSQL 15 or later. Expected: pg15_or_later = true.
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 150000 as pg15_or_later;

-- 2. The migrations v81 depends on: each recorded once with the repository's
--    checksum; v81 absent. Expected: every *_ok = true, v81_rows = 0.
select
  (select count(*) = 1 and bool_and(checksum = 'ed1afda69b8ee364a53816965c8561699133637f66fdbd7a37c7dceb683d6539') from public.schema_migrations where migration_name = 'migrations_v2/202610311000_calendar_v49_events.sql') as v49_ok,
  (select count(*) = 1 and bool_and(checksum = 'b727cb0f74bb8bc41ee816c33995f1ab3df721ebac7bf77b861fd9e9b9f38cff') from public.schema_migrations where migration_name = 'migrations_v2/202611011900_calendar_v51_settings.sql') as v51_ok,
  (select count(*) = 1 and bool_and(checksum = '1f244c812e54a0cdfb4a6dbb79403044e10a604ec41beaaad86e152edb49ab48') from public.schema_migrations where migration_name = 'migrations_v2/202608240900_tests_v42_phase1_scheduling_execution.sql') as tests_phase1_ok,
  (select count(*) = 1 and bool_and(checksum = 'cb360a58bb00ea3a8e2f0f989e7b97bc77d00d8855dcc9268c1eea26ab93b46d') from public.schema_migrations where migration_name = 'migrations_v2/202608260900_tests_v42_occurrence_generation_lock_fix.sql') as tests_lock_fix_ok,
  (select count(*) = 1 and bool_and(checksum = 'b5902d3d27b9aed3d9b418afb6cfc45a2a4dc3b16288cc744c3e24ea227da39f') from public.schema_migrations where migration_name = 'migrations_v2/202608300900_tests_v42_phase4_assignment_timezone_window.sql') as tests_phase4_ok,
  (select count(*) = 1 and bool_and(checksum = '14af0f717ed069f2170275e6c91a70a2c8cf3638ad5f1c93520f7c9d26499392') from public.schema_migrations where migration_name = 'migrations_v2/202609011000_training_load_v4_external_scheduling.sql') as tl_v4_ok,
  (select count(*) = 1 and bool_and(checksum = '367d5c6b3e2d2eedb02ffc760e392e2410770beff1f2a35afa2a733a812e8270') from public.schema_migrations where migration_name = 'migrations_v2/202609011100_training_load_v5_unified_result_source.sql') as tl_v5_ok,
  (select count(*) = 1 and bool_and(checksum = '829022d6cb180838689bc42df98c5dcca5175d5105f8cbd42795c7ecdf5c44b8') from public.schema_migrations where migration_name = 'migrations_v2/202609020900_training_load_v7_external_schedule_notification_rules.sql') as tl_v7_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611191000_calendar_v81_athlete_questions.sql') as v81_rows;

-- 3. The bodies v81 replaces or relies on, by md5 (the package names them).
--    Expected: materialize_md5 = 2d961f5acd6c6309baa51de868773ba4,
--    settings_changes_md5 = 75ed99731f6d61d19a8f0c2e473fedd1,
--    lock_event_writer_md5 = 7ebf1bcf39cbb930fb913d89f25fd406 (v54).
select
  (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tests' and p.proname = 'materialize_test_assignments_for_occurrence') as materialize_md5,
  (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'calendar' and p.proname = 'settings_changes_before_insert') as settings_changes_md5,
  (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'calendar' and p.proname = 'lock_event_writer') as lock_event_writer_md5;

-- 4. No v81 object yet. Expected: every column 0.
select
  (select count(*) from pg_tables where schemaname = 'calendar' and tablename in ('club_question_settings', 'event_questions', 'question_postponements', 'question_assignment_skips')) as v81_tables,
  (select count(*) from information_schema.columns where (table_schema, table_name, column_name) in
     (('calendar', 'event_types', 'default_questions'), ('tests', 'test_schedules', 'skip_days_off'), ('calendar', 'settings_changes', 'subject_club_id'))) as v81_columns,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'calendar'
     and p.proname in ('questions_ok', 'owner_club_id', 'event_club_id', 'questions_enabled', 'athlete_reached_on_day', 'event_audience_on_day',
                       'wellness_day_key', 'is_wellness_version', 'question_open_for')) as v81_functions;

-- 5. The Tests schema and WELLNESS (v81 needs both). Expected: every column true.
select to_regclass('tests.test_schedules') is not null as test_schedules,
       to_regclass('tests.test_assignments') is not null as test_assignments,
       to_regclass('training_load.external_schedule_notification_rules') is not null as tl_rules,
       exists (select 1 from tests.test_versions where id = '7a386bd1-d25e-4651-9012-e76d9dc32559' and test_id = '5975d3ba-3578-49e1-9cd3-326df5e21f06' and status = 'active') as wellness_active,
       to_regclass('public.athlete_membership_periods') is not null as membership_periods;

-- 6. A quiet moment: no transaction idle for long, no lock wait on calendar.*
--    or tests.*. Expected: idle_in_transaction = 0, lock_waits = 0.
select
  (select count(*) from pg_stat_activity where state = 'idle in transaction' and now() - state_change > interval '30 seconds') as idle_in_transaction,
  (select count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
     where not l.granted and n.nspname in ('calendar', 'tests')) as lock_waits;

-- 7. Information only (never a stop): the other lines' migrations around v81.
--    v75 (dashboards D2a) and v78-v80 (the mapping line) may or may not be
--    recorded; v81 does not depend on them.
select migration_name from public.schema_migrations
 where migration_name ~ '^migrations_v2/2026111[5-9]' order by migration_name;

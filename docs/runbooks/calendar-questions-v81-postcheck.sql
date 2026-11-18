-- v81 production post-check - READ ONLY. After the deploy that applied
-- migrations_v2/202611191000_calendar_v81_athlete_questions.sql (K2b-2a-1;
-- plan docs/ai/central-calendar-k2b2-plan.md, 9.1). Run ONE numbered block at a
-- time; every block is a plain SELECT. Any other value than the expected one:
-- stop, change nothing, report the block, the column and the value. v81 is not
-- assumed to be the last migration.

-- 1. v81 recorded once with the file's sha256 (the pull request names it).
--    Expected: v81_rows = 1, v81_checksum = the file's sha256.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611191000_calendar_v81_athlete_questions.sql') as v81_rows,
       (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611191000_calendar_v81_athlete_questions.sql') as v81_checksum;

-- 2. The objects. Expected: v81_tables = 4, v81_columns = 3, v81_functions = 15,
--    v81_triggers = 14 (all enabled: disabled = 0), switch_index = 1.
select
  (select count(*) from pg_tables where schemaname = 'calendar' and tablename in ('club_question_settings', 'event_questions', 'question_postponements', 'question_assignment_skips')) as v81_tables,
  (select count(*) from information_schema.columns where (table_schema, table_name, column_name) in
     (('calendar', 'event_types', 'default_questions'), ('tests', 'test_schedules', 'skip_days_off'), ('calendar', 'settings_changes', 'subject_club_id'))) as v81_columns,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'calendar'
     and p.proname in ('questions_ok', 'owner_club_id', 'event_club_id', 'questions_enabled', 'athlete_reached_on_day', 'event_audience_on_day',
                       'wellness_day_key', 'is_wellness_version', 'question_open_for', 'club_question_settings_guard', 'club_question_settings_need_change',
                       'event_questions_guard', 'event_questions_need_parent', 'question_postponements_guard', 'question_assignment_skips_guard')) as v81_functions,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname = 'calendar' and c.relname in ('club_question_settings', 'event_questions', 'question_postponements', 'question_assignment_skips')) as v81_triggers,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname = 'calendar' and c.relname in ('club_question_settings', 'event_questions', 'question_postponements', 'question_assignment_skips')
       and t.tgenabled = 'D') as disabled,
  (select count(*) from pg_indexes where schemaname = 'calendar' and indexname = 'settings_changes_club_revision_key') as switch_index;

-- 3. The two bodies v81 wrote. Expected: materialize_md5 = 15a79e10b95ef31b30286935f28b7db5,
--    settings_changes_md5 = b4189ddb507e607263ee6cb89760a891.
select
  (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tests' and p.proname = 'materialize_test_assignments_for_occurrence') as materialize_md5,
  (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'calendar' and p.proname = 'settings_changes_before_insert') as settings_changes_md5;

-- 4. Nothing written by the migration; the switch is off everywhere. Expected:
--    every column 0.
select
  (select count(*) from calendar.club_question_settings) as switch_rows,
  (select count(*) from calendar.event_questions) as questions,
  (select count(*) from calendar.question_postponements) as postponements,
  (select count(*) from calendar.question_assignment_skips) as skips,
  (select count(*) from tests.test_schedules where skip_days_off) as skip_days_off_schedules,
  (select count(*) from calendar.event_types where default_questions is not null) as typed_questions;

-- 5. A quiet moment after the deploy. Expected: idle_in_transaction = 0, lock_waits = 0.
select
  (select count(*) from pg_stat_activity where state = 'idle in transaction' and now() - state_change > interval '30 seconds') as idle_in_transaction,
  (select count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
     where not l.granted and n.nspname in ('calendar', 'tests')) as lock_waits;

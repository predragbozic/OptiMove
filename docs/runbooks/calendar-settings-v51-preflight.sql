-- v51 production preflight - READ ONLY. For the owner (or the manager, on the
-- standing order) to run in the Supabase SQL Editor, as the application's
-- DATABASE_URL role (the one the migrator uses), on the day of the merge and
-- deploy of the K2b-1a pull request
-- (migrations_v2/202611011900_calendar_v51_settings.sql; plan
-- docs/ai/central-calendar-k2b-plan.md, sections 2, 3 and 13).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. PostgreSQL 15 or later (v51 uses UNIQUE NULLS NOT DISTINCT and the xid8
--    cast of pg_current_xact_id()).
--    Expected: pg15_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 150000 as pg15_or_later;

-- 2. The migration state: v49 and v50 recorded once with the repository's
--    checksums, v51 absent, nothing recorded at or after its name.
--    Expected: v49_rows = 1, v50_rows = 1, v51_rows = 0, at_or_after_v51 = 0,
--    last_migration = migrations_v2/202610311200_training_load_v50_source_instance_end.sql
--    (or a later migration of another part whose name sorts before v51's).
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610311000_calendar_v49_events.sql') as v49_rows,
  (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202610311000_calendar_v49_events.sql') as v49_checksum,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610311200_training_load_v50_source_instance_end.sql') as v50_rows,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611011900_calendar_v51_settings.sql') as v51_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name >= 'migrations_v2/202611011900_calendar_v51_settings.sql') as at_or_after_v51,
  (select migration_name from public.schema_migrations order by migration_name desc limit 1) as last_migration;
-- v49_checksum is compared with the repository's sha256 of v49's file (the
-- pull request names it).

-- 3. The calendar schema as v49 left it: seven tables, no v51 table, the K2a
--    read-only guard still on the types, every type row exactly the v49 seed
--    (no route could change one before v51).
--    Expected: tables = 7, v51_tables = 0, read_only_guard = 1,
--    non_seed_types = 0, typed_icons = 0.
select
  (select count(*) from pg_tables where schemaname = 'calendar') as tables,
  (select count(*) from pg_tables where schemaname = 'calendar'
    and tablename in ('event_fields', 'event_field_options', 'event_type_fields', 'event_selected_fields', 'event_field_values',
                      'locations', 'team_settings', 'settings_requests', 'settings_changes')) as v51_tables,
  (select count(*) from pg_trigger where tgname = 'event_types_k2a_read_only' and not tgisinternal) as read_only_guard,
  (select count(*) from calendar.event_types where seed_key is null or created_by_user_id is not null or archived_at is not null) as non_seed_types,
  (select count(*) from calendar.event_types where icon_key is not null) as typed_icons;

-- 4. What v51 references exists.
--    Expected: every column true.
select to_regprocedure('training_load.source_metric_text_ok(text, integer)') is not null as text_rule,
       to_regprocedure('training_load.source_metric_unit_token_ok(text)') is not null as unit_rule,
       to_regprocedure('calendar.multiline_text_ok(text, integer)') is not null as multiline_rule,
       to_regprocedure('calendar.details_ok(jsonb)') is not null as details_rule,
       to_regprocedure('calendar.refuse_change()') is not null as refuse_change,
       to_regprocedure('calendar.refuse_delete()') is not null as refuse_delete,
       to_regprocedure('calendar.refuse_truncate()') is not null as refuse_truncate,
       to_regprocedure('calendar.lock_event_writer(uuid, character varying, uuid, character varying)') is not null as writer_lock,
       to_regprocedure('calendar.seed_club_event_types(uuid)') is not null as seed_function;

-- 5. The seed's size: active clubs (ten details, seventeen options and
--    thirteen list entries each) - record the number for the post-check.
select count(*) as active_clubs from public.clubs where coalesce(is_active, true);

-- 6. Nothing v51 alters is in an unexpected state: no event names a place
--    yet (the column does not exist), every request and change of v49 has one
--    of v49's operations.
--    Expected: unknown_operations = 0, unknown_kinds = 0.
select
  (select count(*) from calendar.event_requests where operation not in (
     'create', 'update', 'cancel', 'attach_sessions', 'detach_sessions', 'attach_activity', 'detach_activity', 'set_schedule', 'clear_schedule')) as unknown_operations,
  (select count(*) from calendar.event_changes where kind not in (
     'create', 'update', 'cancel', 'attach_sessions', 'detach_sessions', 'attach_activity', 'detach_activity', 'set_schedule', 'clear_schedule')) as unknown_kinds;

-- 7. A quiet moment: no other migration running, no transaction holding a
--    strong lock on a table v51 alters or references (ADD COLUMN takes ACCESS
--    EXCLUSIVE on calendar.events and calendar.event_types; the new foreign
--    keys take SHARE ROW EXCLUSIVE on users, clubs, teams), no idle
--    transaction. An ordinary row write's RowExclusiveLock does not count.
--    Expected: every count 0.
select
  (select count(*) from pg_stat_activity where state = 'idle in transaction' and pid <> pg_backend_pid()) as idle_in_transaction,
  (select count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
    where ((n.nspname = 'public' and c.relname in ('users', 'clubs', 'teams'))
        or (n.nspname = 'calendar'))
      and l.pid <> pg_backend_pid()
      and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')) as strong_locks,
  (select count(*) from pg_stat_activity where query ilike '%schema_migrations%' and pid <> pg_backend_pid() and state <> 'idle') as other_migrators,
  (select count(*) from pg_locks where locktype = 'advisory' and objid = 822026) as migrator_lock_held;

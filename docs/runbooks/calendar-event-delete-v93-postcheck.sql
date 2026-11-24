-- Read-only POST-CHECK for migration v93 (delete an event that holds nothing;
-- migrations_v2/202611251000_calendar_v93_event_delete.sql). Run it right after the deploy
-- (docs/runbooks/calendar-event-delete-v93.md). Changes nothing: run each block as
--   begin transaction read only; <block>; rollback;
-- Every block returns ok columns that must all be true.

-- 1. v93 recorded once with a shaped checksum.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611251000_calendar_v93_event_delete.sql') = 1 as v93_recorded_once,
       (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611251000_calendar_v93_event_delete.sql') ~ '^[0-9a-f]{64}$' as checksum_shaped,
       (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611251000_calendar_v93_event_delete.sql') as checksum_for_the_reader;

-- 2. The objects: the log table with its two unique keys, the functions, every trigger of the five tables enabled.
select to_regclass('calendar.event_deletion_log') is not null as log_table,
       to_regclass('calendar.event_deleted_request_keys') is not null as spent_keys_table,
       (select count(*) from pg_constraint where conrelid = 'calendar.event_deletion_log'::regclass
         and conname in ('event_deletion_log_one_per_key', 'event_deletion_log_one_per_event')) = 2 as log_unique_keys,
       (select count(*) from pg_proc where pronamespace = 'calendar'::regnamespace
         and proname in ('delete_event', 'event_deletion_pending', 'event_deletion_log_before_insert', 'event_deletion_log_event_gone',
                         'events_before_delete', 'event_history_before_delete', 'event_selected_fields_before_delete',
                         'event_selected_fields_need_parent_after_delete', 'event_deleted_request_keys_before_insert')) = 9 as functions,
       (select count(*) from pg_trigger g join pg_proc p on p.oid = g.tgfoid
         where not g.tgisinternal and g.tgenabled = 'O' and (g.tgrelid, g.tgname, p.proname, g.tgtype) in (
           ('calendar.events'::regclass, 'events_no_delete', 'events_before_delete', 11::int2),
           ('calendar.event_requests'::regclass, 'event_requests_append_only', 'refuse_change', 19::int2),
           ('calendar.event_requests'::regclass, 'event_requests_before_delete', 'event_history_before_delete', 11::int2),
           ('calendar.event_changes'::regclass, 'event_changes_append_only', 'refuse_change', 19::int2),
           ('calendar.event_changes'::regclass, 'event_changes_before_delete', 'event_history_before_delete', 11::int2),
           ('calendar.event_selected_fields'::regclass, 'event_selected_fields_guard', 'event_selected_fields_guard', 23::int2),
           ('calendar.event_selected_fields'::regclass, 'event_selected_fields_before_delete', 'event_selected_fields_before_delete', 11::int2),
           ('calendar.event_selected_fields'::regclass, 'event_selected_fields_need_parent', 'event_selected_fields_need_parent', 21::int2),
           ('calendar.event_selected_fields'::regclass, 'event_selected_fields_need_parent_delete', 'event_selected_fields_need_parent_after_delete', 9::int2),
           ('calendar.event_deletion_log'::regclass, 'event_deletion_log_before_insert', 'event_deletion_log_before_insert', 7::int2),
           ('calendar.event_deletion_log'::regclass, 'event_deletion_log_append_only', 'refuse_change', 27::int2),
           ('calendar.event_deletion_log'::regclass, 'event_deletion_log_no_truncate', 'refuse_truncate', 34::int2),
           ('calendar.event_deletion_log'::regclass, 'event_deletion_log_event_gone', 'event_deletion_log_event_gone', 5::int2),
           ('calendar.event_deleted_request_keys'::regclass, 'event_deleted_request_keys_before_insert', 'event_deleted_request_keys_before_insert', 7::int2),
           ('calendar.event_deleted_request_keys'::regclass, 'event_deleted_request_keys_append_only', 'refuse_change', 27::int2),
           ('calendar.event_deleted_request_keys'::regclass, 'event_deleted_request_keys_no_truncate', 'refuse_truncate', 34::int2))) = 16 as triggers_enabled;

-- 3. The two replaced bodies are v93's (the sanctioned delete first).
select (select md5(prosrc) from pg_proc where pronamespace = 'calendar'::regnamespace and proname = 'event_targets_before_delete') = '4d0401c862000970cb1399b4ae2e11a3' as targets_delete_body_is_v93,
       (select md5(prosrc) from pg_proc where pronamespace = 'calendar'::regnamespace and proname = 'event_targets_need_target_after_delete') = 'b23ab34d2d4d4162c850a0cb63f7a1d1' as need_target_body_is_v93,
       (select md5(prosrc) from pg_proc where pronamespace = 'calendar'::regnamespace and proname = 'event_selected_fields_guard') = 'aedf5e276badb0745a3ae45b8bc9a35c' as selected_guard_body_unchanged;

-- 4. Nothing deleted yet (right after the deploy): the log is empty.
select not exists (select 1 from calendar.event_deletion_log) as no_deletion_rows,
       not exists (select 1 from calendar.event_deleted_request_keys) as no_spent_keys;

-- 5. No idle transaction, no lock wait.
select not exists (select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction') as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

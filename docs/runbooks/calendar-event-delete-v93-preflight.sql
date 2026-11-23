-- Read-only PREFLIGHT for migration v93 (delete an event that holds nothing;
-- migrations_v2/202611251000_calendar_v93_event_delete.sql). Run it right before the merge, at the quiet moment chosen
-- for it (docs/runbooks/calendar-event-delete-v93.md). Changes nothing: run each block as
--   begin transaction read only; <block>; rollback;
-- Every block returns ok columns that must all be true; block 3 is for the reader.

-- 1. The server, the last recorded migration (for the reader), v93 not recorded, the calendar migrations it builds on recorded.
select current_setting('server_version_num')::int >= 150000 as server_15_or_later,
       current_setting('server_version') as server_version,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611251000_calendar_v93_event_delete.sql') as v93_not_recorded,
       (select count(*) from public.schema_migrations where migration_name in (
          'migrations_v2/202610311000_calendar_v49_events.sql', 'migrations_v2/202611011900_calendar_v51_settings.sql',
          'migrations_v2/202611191000_calendar_v81_athlete_questions.sql')) = 3 as calendar_v49_v51_v81_recorded,
       not exists (select 1 from public.schema_migrations where checksum is null or checksum !~ '^[0-9a-f]{64}$') as checksums_shaped;

-- 2. Nothing v93 adds exists; the four bodies and the five triggers it changes are as v49 / v51 left them.
select to_regclass('calendar.event_deletion_log') is null as no_log_table,
       not exists (select 1 from pg_proc where pronamespace = 'calendar'::regnamespace
                    and proname in ('delete_event', 'event_deletion_pending', 'event_deletion_log_before_insert', 'event_deletion_log_event_gone',
                                    'events_before_delete', 'event_history_before_delete', 'event_selected_fields_before_delete',
                                    'event_selected_fields_need_parent_after_delete')) as no_functions,
       (select md5(prosrc) from pg_proc where pronamespace = 'calendar'::regnamespace and proname = 'event_targets_before_delete') = '5552341e9f127259402b9d899d223988' as targets_delete_body_is_v49,
       (select md5(prosrc) from pg_proc where pronamespace = 'calendar'::regnamespace and proname = 'event_targets_need_target_after_delete') = '3771cdaffa6325d74bb8899b8be557f1' as need_target_body_is_v49,
       (select md5(prosrc) from pg_proc where pronamespace = 'calendar'::regnamespace and proname = 'event_selected_fields_guard') = 'aedf5e276badb0745a3ae45b8bc9a35c' as selected_guard_body_is_v51,
       (select md5(prosrc) from pg_proc where pronamespace = 'calendar'::regnamespace and proname = 'event_selected_fields_need_parent') = 'c43a5fae9e4cd90e7517ea058fbdc76b' as selected_parent_body_is_v51,
       (select count(*) from pg_trigger g join pg_proc p on p.oid = g.tgfoid
         where not g.tgisinternal and g.tgenabled = 'O' and (g.tgrelid, g.tgname, p.proname, g.tgtype) in (
           ('calendar.events'::regclass, 'events_no_delete', 'refuse_delete', 11::int2),
           ('calendar.event_requests'::regclass, 'event_requests_append_only', 'refuse_change', 27::int2),
           ('calendar.event_changes'::regclass, 'event_changes_append_only', 'refuse_change', 27::int2),
           ('calendar.event_selected_fields'::regclass, 'event_selected_fields_guard', 'event_selected_fields_guard', 31::int2),
           ('calendar.event_selected_fields'::regclass, 'event_selected_fields_need_parent', 'event_selected_fields_need_parent', 29::int2))) = 5 as triggers_as_v49_v51;

-- 3. For the reader: the events (v93 changes no row; the trigger changes lock the five calendar tables briefly).
select (select count(*) from calendar.events) as events,
       (select count(*) from calendar.events where status = 'cancelled') as cancelled_events;

-- 4. A quiet moment: no idle transaction, no lock wait, no long transaction on the calendar tables v93 locks.
select not exists (select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction') as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
                    where l.relation in ('calendar.events'::regclass, 'calendar.event_requests'::regclass, 'calendar.event_changes'::regclass,
                                         'calendar.event_targets'::regclass, 'calendar.event_selected_fields'::regclass)
                      and a.xact_start < now() - interval '30 seconds' and a.pid <> pg_backend_pid()) as no_long_tx_on_calendar_tables;

-- 5. (In git, not SQL) the 12-digit prefix is unique on the merge tree (.claude/rules/migrations.md):
--   git ls-tree --name-only $(git merge-tree --write-tree origin/main <head>) migrations_v2/ | sed 's#.*/##' | grep -E '^[0-9]{12}_' | cut -c1-12 | sort | uniq -d
--   must print nothing.

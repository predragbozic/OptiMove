-- ROLLBACK of migration v93 (delete an event that holds nothing;
-- migrations_v2/202611251000_calendar_v93_event_delete.sql). One transaction, at a quiet moment, only on its own approval
-- (docs/runbooks/calendar-event-delete-v93.md, "Rollback"). Before running it the deployed commit no longer contains
-- the v93 file and no longer calls calendar.delete_event (the delete route).
--
-- It REFUSES, changing nothing, when: v93 is not recorded; a later migration is recorded; a deletion-log row exists
-- (from then on v93 is forward-only: the log is the only trace of a deleted event); the bodies in force are not v93's.
-- It restores the v49 / v51 triggers and the two v49 bodies verbatim (checked by md5 at the end).

begin;
set local lock_timeout = '5s';

lock table calendar.event_deletion_log, calendar.event_deleted_request_keys, calendar.events, calendar.event_requests, calendar.event_changes,
           calendar.event_targets, calendar.event_selected_fields in share row exclusive mode;

do $$
begin
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611251000_calendar_v93_event_delete.sql') then
    raise exception 'v93 rollback refused: v93 is not recorded' using errcode = '23514';
  end if;
  if exists (select 1 from public.schema_migrations m where m.migration_name <> 'migrations_v2/202611251000_calendar_v93_event_delete.sql'
              and m.applied_at >= (select applied_at from public.schema_migrations where migration_name = 'migrations_v2/202611251000_calendar_v93_event_delete.sql')) then
    raise exception 'v93 rollback refused: a later migration is recorded' using errcode = '23514';
  end if;
  if exists (select 1 from calendar.event_deletion_log) then
    raise exception 'v93 rollback refused: an event was deleted (the deletion log is not empty); v93 is forward-only now' using errcode = '23514';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'calendar'::regnamespace and proname = 'event_targets_before_delete') is distinct from '4d0401c862000970cb1399b4ae2e11a3'
     or (select md5(prosrc) from pg_proc where pronamespace = 'calendar'::regnamespace and proname = 'event_targets_need_target_after_delete') is distinct from 'b23ab34d2d4d4162c850a0cb63f7a1d1' then
    raise exception 'v93 rollback refused: the bodies in force are not v93''s' using errcode = '23514';
  end if;
end;
$$;

-- 1. The triggers, as v49 / v51 created them.
drop trigger events_no_delete on calendar.events;
create trigger events_no_delete
  before delete on calendar.events
  for each row execute function calendar.refuse_delete();
drop trigger event_requests_before_delete on calendar.event_requests;
drop trigger event_requests_append_only on calendar.event_requests;
create trigger event_requests_append_only
  before update or delete on calendar.event_requests
  for each row execute function calendar.refuse_change();
drop trigger event_changes_before_delete on calendar.event_changes;
drop trigger event_changes_append_only on calendar.event_changes;
create trigger event_changes_append_only
  before update or delete on calendar.event_changes
  for each row execute function calendar.refuse_change();
drop trigger event_selected_fields_before_delete on calendar.event_selected_fields;
drop trigger event_selected_fields_guard on calendar.event_selected_fields;
create trigger event_selected_fields_guard
  before insert or update or delete on calendar.event_selected_fields
  for each row execute function calendar.event_selected_fields_guard();
drop trigger event_selected_fields_need_parent_delete on calendar.event_selected_fields;
drop trigger event_selected_fields_need_parent on calendar.event_selected_fields;
create constraint trigger event_selected_fields_need_parent
  after insert or update or delete on calendar.event_selected_fields
  deferrable initially deferred
  for each row execute function calendar.event_selected_fields_need_parent();

-- 2. The two v49 bodies, verbatim.
create or replace function calendar.event_targets_before_delete() returns trigger language plpgsql as $$
begin
  if exists (select 1 from calendar.events e where e.id = old.event_id and e.status <> 'planned') then
    raise exception 'calendar.event_targets: a cancelled event is final' using errcode = '23514';
  end if;
  return old;
end $$;
create or replace function calendar.event_targets_need_target_after_delete() returns trigger language plpgsql as $$
begin
  if not calendar.event_has_target(old.event_id) then
    raise exception 'calendar.events: an event needs at least one target' using errcode = '23514';
  end if;
  return null;
end $$;

-- 3. What v93 added.
drop function calendar.delete_event(uuid, integer, uuid, varchar, uuid, text, jsonb);
drop function calendar.events_before_delete();
drop function calendar.event_history_before_delete();
drop function calendar.event_selected_fields_before_delete();
drop function calendar.event_selected_fields_need_parent_after_delete();
drop table calendar.event_deleted_request_keys;
drop function calendar.event_deleted_request_keys_before_insert();
drop table calendar.event_deletion_log;
drop function calendar.event_deletion_log_before_insert();
drop function calendar.event_deletion_log_event_gone();
drop function calendar.event_deletion_pending(uuid);
delete from public.schema_migrations where migration_name = 'migrations_v2/202611251000_calendar_v93_event_delete.sql';

-- 4. The bodies are v49's again.
do $$
begin
  if (select md5(prosrc) from pg_proc where pronamespace = 'calendar'::regnamespace and proname = 'event_targets_before_delete') <> '5552341e9f127259402b9d899d223988'
     or (select md5(prosrc) from pg_proc where pronamespace = 'calendar'::regnamespace and proname = 'event_targets_need_target_after_delete') <> '3771cdaffa6325d74bb8899b8be557f1' then
    raise exception 'v93 rollback: a restored body is not v49''s' using errcode = '23514';
  end if;
end;
$$;

commit;

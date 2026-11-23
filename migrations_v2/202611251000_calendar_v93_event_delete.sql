-- Central calendar v93: delete an event that holds nothing (the owner's decision, 2026-11-22, relayed by the OptiMove
-- manager; docs/runbooks/calendar-event-delete-v93.md).
--
-- Until v93 an event was never deleted (v49: `events_no_delete`, and every table that names an event refuses a
-- delete or is append-only). v93 lets ONE sanctioned function delete an event, and only when nothing is attached:
--
--   calendar.delete_event(event, expected revision, user, basis, request key, request hash, result)
--     locks the event FOR UPDATE, checks the revision, writes ONE row of calendar.event_deletion_log (its insert
--     guard re-checks the writer's right through calendar.lock_event_writer and that nothing is attached), then
--     deletes the event's own rows - its change log, its request records, its chosen details, its targets - and
--     the event.
--
--   "Nothing attached" (the manager's B2): no session link and no activity link, ended ones included; no question
--   for athletes; no assignment skip (a Day off's); no value of a detail; no RPE or test schedule referenced. A
--   cancelled event is deleted on the same terms (B3).
--
--   The proof that a delete is sanctioned is the deletion-log row of the SAME transaction
--   (calendar.event_deletion_pending: the row's xmin is the current transaction, the transaction-local marker of the
--   v57 pattern, but one only the guarded insert can create). Every guard that refused a delete on these tables
--   lets it through for that event only; any other delete is refused exactly as before. At COMMIT a deferred check
--   makes sure the logged event is really gone (a log row is never written for an event that stays).
--
--   The deletion log (B1): who, when, on which basis, the owner, the title, the day(s), the status and revision of
--   the event, and the request key and hash (the request record of the route: a replay and a lost COMMIT are
--   answered from it). Append-only, no TRUNCATE. It keeps no target, note, detail or athlete.
--
-- Lock order: the writer's rights rows (lock_event_writer: the owner team / club FOR SHARE, the user, the role row),
-- then the event FOR UPDATE - the order of every event command (calendarEventService.js runEventCommand), in the
-- service and in the two functions alike (each reads the owner without a lock, locks the rights, then the event, and
-- compares the owner again), so a concurrent attach or edit either finishes first (and the delete is refused) or
-- waits and finds no event (404).
--
-- The deleted event's request keys are kept in calendar.event_deleted_request_keys (written by delete_event only):
-- the command runner reads them, so a replay of one of the event's old requests - its create after a lost answer -
-- never writes the event again.
--
-- Bodies replaced (md5-gated below): calendar.event_targets_before_delete and
-- calendar.event_targets_need_target_after_delete (v49). Triggers split so their DELETE branch has its own function:
-- events_no_delete, event_requests_append_only and event_changes_append_only (v49), event_selected_fields_guard and
-- event_selected_fields_need_parent (v51). The shared refuse_change / refuse_delete functions are not changed.
-- The rollback is docs/runbooks/calendar-event-delete-v93-rollback.sql; it refuses once a deletion-log row exists.

set local lock_timeout = '5s';

-- 0. The bodies this migration replaces must be the ones in force (v49), and the triggers it splits must be as
--    v49 / v51 left them.
do $$
declare
  expected constant text[][] := array[
    ['event_targets_before_delete', '5552341e9f127259402b9d899d223988'],
    ['event_targets_need_target_after_delete', '3771cdaffa6325d74bb8899b8be557f1'],
    ['event_selected_fields_guard', 'aedf5e276badb0745a3ae45b8bc9a35c'],
    ['event_selected_fields_need_parent', 'c43a5fae9e4cd90e7517ea058fbdc76b']];
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'calendar'::regnamespace and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v93 refused: the body in force of calendar.% is not the expected one', expected[i][1] using errcode = '23514';
    end if;
  end loop;
  if (select count(*) from pg_trigger g join pg_proc p on p.oid = g.tgfoid
       where not g.tgisinternal and (g.tgrelid, g.tgname, p.proname, g.tgtype) in (
         ('calendar.events'::regclass, 'events_no_delete', 'refuse_delete', 11::int2),
         ('calendar.event_requests'::regclass, 'event_requests_append_only', 'refuse_change', 27::int2),
         ('calendar.event_changes'::regclass, 'event_changes_append_only', 'refuse_change', 27::int2),
         ('calendar.event_selected_fields'::regclass, 'event_selected_fields_guard', 'event_selected_fields_guard', 31::int2),
         ('calendar.event_selected_fields'::regclass, 'event_selected_fields_need_parent', 'event_selected_fields_need_parent', 29::int2))) <> 5 then
    raise exception 'v93 refused: the calendar triggers it splits are not as v49 / v51 left them' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The deletion log (the route's request record)
-- ---------------------------------------------------------------------------
create table calendar.event_deletion_log (
  id                    uuid primary key default gen_random_uuid(),
  request_key           uuid not null,
  request_hash          text not null
                        constraint event_deletion_log_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  performed_by_user_id  uuid not null references public.users(id) on delete restrict,
  basis                 varchar(20) not null
                        constraint event_deletion_log_basis_check check (basis in ('platform_admin', 'club_admin', 'team_coach', 'private_coach')),
  -- The deleted event's id: no foreign key, the event is gone.
  event_id              uuid not null,
  owner_scope           varchar(20) not null
                        constraint event_deletion_log_owner_scope_check check (owner_scope in ('club', 'team', 'user')),
  owner_user_id         uuid references public.users(id) on delete restrict,
  owner_club_id         uuid references public.clubs(id) on delete restrict,
  owner_team_id         uuid references public.teams(id) on delete restrict,
  event_kind            varchar(20) not null,
  title                 text not null,
  day                   date not null,
  end_day               date,
  event_status          varchar(10) not null
                        constraint event_deletion_log_status_check check (event_status in ('planned', 'cancelled')),
  event_revision        integer not null
                        constraint event_deletion_log_revision_check check (event_revision >= 1),
  -- The answer of the request (ids and counts only, never a name): what a replay answers.
  result                jsonb not null
                        constraint event_deletion_log_result_check check (jsonb_typeof(result) = 'object'),
  deleted_at            timestamptz not null default now(),
  constraint event_deletion_log_owner_shape check (
    (owner_scope = 'user' and owner_user_id is not null and owner_club_id is null     and owner_team_id is null) or
    (owner_scope = 'club' and owner_club_id is not null and owner_user_id is null     and owner_team_id is null) or
    (owner_scope = 'team' and owner_team_id is not null and owner_user_id is null     and owner_club_id is null)),
  constraint event_deletion_log_one_per_key unique (performed_by_user_id, request_key),
  constraint event_deletion_log_one_per_event unique (event_id)
);

-- Is the event being deleted by a sanctioned delete of THIS transaction?
create function calendar.event_deletion_pending(p_event_id uuid) returns boolean
  language sql volatile as $$
    select exists (select 1 from calendar.event_deletion_log l
                    where l.event_id = p_event_id and calendar.written_in_this_transaction(l.xmin))
  $$;

-- The insert guard: the event exists and is locked, the row repeats its facts, the writer holds the right of the
-- basis it names (lock_event_writer, 42501 otherwise), and nothing is attached. Each refusal names its class in the
-- constraint, so the service answers a stable code and never the text.
create function calendar.event_deletion_log_before_insert() returns trigger language plpgsql as $$
declare
  v_event record;
  v_owner record;
begin
  -- The writer's rights before the event's lock (the order of every event command): the owner read without a lock,
  -- the rights locked, then the event locked and its owner compared again.
  select e.owner_scope, coalesce(e.owner_club_id, e.owner_team_id, e.owner_user_id) as owner_id into v_owner
    from calendar.events e where e.id = new.event_id;
  if not found then
    raise exception 'calendar.event_deletion_log: event_id names no event' using errcode = '23514', constraint = 'event_delete_no_event';
  end if;
  perform calendar.lock_event_writer(new.performed_by_user_id, v_owner.owner_scope, v_owner.owner_id, new.basis);
  select e.*, et.kind as type_kind into v_event
    from calendar.events e join calendar.event_types et on et.id = e.event_type_id
   where e.id = new.event_id
     for update of e;
  if not found then
    raise exception 'calendar.event_deletion_log: event_id names no event' using errcode = '23514', constraint = 'event_delete_no_event';
  end if;
  if new.owner_scope is distinct from v_event.owner_scope or new.owner_user_id is distinct from v_event.owner_user_id
     or new.owner_club_id is distinct from v_event.owner_club_id or new.owner_team_id is distinct from v_event.owner_team_id
     or new.title is distinct from v_event.title or new.day is distinct from v_event.day or new.end_day is distinct from v_event.end_day
     or new.event_status is distinct from v_event.status or new.event_revision is distinct from v_event.revision
     or new.event_kind is distinct from v_event.type_kind
     or v_owner.owner_scope is distinct from v_event.owner_scope
     or v_owner.owner_id is distinct from coalesce(v_event.owner_club_id, v_event.owner_team_id, v_event.owner_user_id) then
    raise exception 'calendar.event_deletion_log: the row does not repeat the event''s facts' using errcode = '23514', constraint = 'event_delete_facts';
  end if;
  if v_event.external_schedule_id is not null or v_event.test_schedule_id is not null then
    raise exception 'calendar.event_deletion_log: the event refers to a schedule' using errcode = '23514', constraint = 'event_delete_has_schedule';
  end if;
  if exists (select 1 from calendar.event_session_links l where l.event_id = new.event_id) then
    raise exception 'calendar.event_deletion_log: the event has linked trainings' using errcode = '23514', constraint = 'event_delete_has_trainings';
  end if;
  if exists (select 1 from calendar.event_activity_links l where l.event_id = new.event_id) then
    raise exception 'calendar.event_deletion_log: the event has linked activities' using errcode = '23514', constraint = 'event_delete_has_activities';
  end if;
  if exists (select 1 from calendar.event_questions q where q.event_id = new.event_id) then
    raise exception 'calendar.event_deletion_log: the event has questions for athletes' using errcode = '23514', constraint = 'event_delete_has_questions';
  end if;
  if exists (select 1 from calendar.question_assignment_skips s where s.event_id = new.event_id) then
    raise exception 'calendar.event_deletion_log: the event has skipped assignments' using errcode = '23514', constraint = 'event_delete_has_assignments';
  end if;
  if exists (select 1 from calendar.event_field_values v where v.event_id = new.event_id) then
    raise exception 'calendar.event_deletion_log: the event has detail values' using errcode = '23514', constraint = 'event_delete_has_details';
  end if;
  return new;
end $$;
create trigger event_deletion_log_before_insert
  before insert on calendar.event_deletion_log
  for each row execute function calendar.event_deletion_log_before_insert();
create trigger event_deletion_log_append_only
  before update or delete on calendar.event_deletion_log
  for each row execute function calendar.refuse_change();
create trigger event_deletion_log_no_truncate
  before truncate on calendar.event_deletion_log
  for each statement execute function calendar.refuse_truncate();

-- At COMMIT the logged event is gone: a log row is never left for an event that stays.
create function calendar.event_deletion_log_event_gone() returns trigger language plpgsql as $$
begin
  if exists (select 1 from calendar.events e where e.id = new.event_id) then
    raise exception 'calendar.event_deletion_log: a log row is written with the delete of its event' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger event_deletion_log_event_gone
  after insert on calendar.event_deletion_log
  deferrable initially deferred
  for each row execute function calendar.event_deletion_log_event_gone();

-- The deleted event's request keys stay spent (the command runner reads them): a replay of an old request of the
-- event - its create above all, after a lost answer - is refused and never writes again. Only a sanctioned delete of
-- the event writes them; append-only, no TRUNCATE.
create table calendar.event_deleted_request_keys (
  performed_by_user_id  uuid not null references public.users(id) on delete restrict,
  request_key           uuid not null,
  request_hash          text not null
                        constraint event_deleted_request_keys_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  operation             varchar(20) not null,
  event_id              uuid not null,
  deleted_at            timestamptz not null default now(),
  constraint event_deleted_request_keys_pkey primary key (performed_by_user_id, request_key)
);
create function calendar.event_deleted_request_keys_before_insert() returns trigger language plpgsql as $$
begin
  if not calendar.event_deletion_pending(new.event_id) then
    raise exception 'calendar.event_deleted_request_keys: written only by the sanctioned delete of its event' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger event_deleted_request_keys_before_insert
  before insert on calendar.event_deleted_request_keys
  for each row execute function calendar.event_deleted_request_keys_before_insert();
create trigger event_deleted_request_keys_append_only
  before update or delete on calendar.event_deleted_request_keys
  for each row execute function calendar.refuse_change();
create trigger event_deleted_request_keys_no_truncate
  before truncate on calendar.event_deleted_request_keys
  for each statement execute function calendar.refuse_truncate();

-- ---------------------------------------------------------------------------
-- 2. The guards that refused a delete: through for a sanctioned delete only
-- ---------------------------------------------------------------------------
create function calendar.events_before_delete() returns trigger language plpgsql as $$
begin
  if calendar.event_deletion_pending(old.id) then
    return old;
  end if;
  raise exception 'calendar.%: rows are never deleted (an event is cancelled, a link is ended)', tg_table_name using errcode = '23514';
end $$;
drop trigger events_no_delete on calendar.events;
create trigger events_no_delete
  before delete on calendar.events
  for each row execute function calendar.events_before_delete();

-- The request records and the change log of the deleted event go with it; any other change stays refused.
create function calendar.event_history_before_delete() returns trigger language plpgsql as $$
begin
  if calendar.event_deletion_pending(old.event_id) then
    return old;
  end if;
  raise exception 'calendar.%: % is refused, the table is append-only', tg_table_name, tg_op using errcode = '23514';
end $$;
drop trigger event_requests_append_only on calendar.event_requests;
create trigger event_requests_append_only
  before update on calendar.event_requests
  for each row execute function calendar.refuse_change();
create trigger event_requests_before_delete
  before delete on calendar.event_requests
  for each row execute function calendar.event_history_before_delete();
drop trigger event_changes_append_only on calendar.event_changes;
create trigger event_changes_append_only
  before update on calendar.event_changes
  for each row execute function calendar.refuse_change();
create trigger event_changes_before_delete
  before delete on calendar.event_changes
  for each row execute function calendar.event_history_before_delete();

-- The targets (v49 bodies, each with the sanctioned delete as its first case).
create or replace function calendar.event_targets_before_delete() returns trigger language plpgsql as $$
begin
  if calendar.event_deletion_pending(old.event_id) then
    return old;
  end if;
  if exists (select 1 from calendar.events e where e.id = old.event_id and e.status <> 'planned') then
    raise exception 'calendar.event_targets: a cancelled event is final' using errcode = '23514';
  end if;
  return old;
end $$;
create or replace function calendar.event_targets_need_target_after_delete() returns trigger language plpgsql as $$
begin
  if calendar.event_deletion_pending(old.event_id) then
    return null;
  end if;
  if not calendar.event_has_target(old.event_id) then
    raise exception 'calendar.events: an event needs at least one target' using errcode = '23514';
  end if;
  return null;
end $$;

-- The chosen details (v51): the guard and the parent check keep INSERT and UPDATE; their DELETE branch is its own
-- function, the same rule with the sanctioned delete first.
create function calendar.event_selected_fields_before_delete() returns trigger language plpgsql as $$
declare
  v_status varchar;
begin
  if calendar.event_deletion_pending(old.event_id) then
    return old;
  end if;
  select e.status into v_status from calendar.events e where e.id = old.event_id for update;
  if not found or v_status <> 'planned' then
    raise exception 'calendar.event_selected_fields: a cancelled event is final' using errcode = '23514';
  end if;
  return old;
end $$;
create function calendar.event_selected_fields_need_parent_after_delete() returns trigger language plpgsql as $$
begin
  if calendar.event_deletion_pending(old.event_id) then
    return null;
  end if;
  if not exists (select 1 from calendar.events e where e.id = old.event_id and calendar.written_in_this_transaction(e.xmin)) then
    raise exception 'calendar.event_selected_fields: a selection is written with its event' using errcode = '23514';
  end if;
  return null;
end $$;
drop trigger event_selected_fields_guard on calendar.event_selected_fields;
create trigger event_selected_fields_guard
  before insert or update on calendar.event_selected_fields
  for each row execute function calendar.event_selected_fields_guard();
create trigger event_selected_fields_before_delete
  before delete on calendar.event_selected_fields
  for each row execute function calendar.event_selected_fields_before_delete();
drop trigger event_selected_fields_need_parent on calendar.event_selected_fields;
create constraint trigger event_selected_fields_need_parent
  after insert or update on calendar.event_selected_fields
  deferrable initially deferred
  for each row execute function calendar.event_selected_fields_need_parent();
create constraint trigger event_selected_fields_need_parent_delete
  after delete on calendar.event_selected_fields
  deferrable initially deferred
  for each row execute function calendar.event_selected_fields_need_parent_after_delete();

-- ---------------------------------------------------------------------------
-- 3. The sanctioned delete
-- ---------------------------------------------------------------------------
-- The caller (calendarEventService.js deleteEvent) has taken the writer lock and the event's lock and checked the
-- right; this function takes them again (a raw call is checked the same way: the log row's guard) and returns the
-- log row's id. A wrong revision is 23514 event_delete_revision.
create function calendar.delete_event(p_event_id uuid, p_expected_revision integer, p_user_id uuid, p_basis varchar,
                                      p_request_key uuid, p_request_hash text, p_result jsonb)
returns uuid language plpgsql as $$
declare
  v_event record;
  v_owner record;
  v_log_id uuid;
begin
  -- Rights first, then the event (as the log row's guard and every event command).
  select e.owner_scope, coalesce(e.owner_club_id, e.owner_team_id, e.owner_user_id) as owner_id into v_owner
    from calendar.events e where e.id = p_event_id;
  if not found then
    raise exception 'calendar.delete_event: no such event' using errcode = '23514', constraint = 'event_delete_no_event';
  end if;
  perform calendar.lock_event_writer(p_user_id, v_owner.owner_scope, v_owner.owner_id, p_basis);
  select e.*, et.kind as type_kind into v_event
    from calendar.events e join calendar.event_types et on et.id = e.event_type_id
   where e.id = p_event_id
     for update of e;
  if not found then
    raise exception 'calendar.delete_event: no such event' using errcode = '23514', constraint = 'event_delete_no_event';
  end if;
  if v_event.revision is distinct from p_expected_revision then
    raise exception 'calendar.delete_event: the event was changed meanwhile' using errcode = '23514', constraint = 'event_delete_revision';
  end if;
  insert into calendar.event_deletion_log (request_key, request_hash, performed_by_user_id, basis, event_id, owner_scope,
      owner_user_id, owner_club_id, owner_team_id, event_kind, title, day, end_day, event_status, event_revision, result)
    values (p_request_key, p_request_hash, p_user_id, p_basis, v_event.id, v_event.owner_scope,
      v_event.owner_user_id, v_event.owner_club_id, v_event.owner_team_id, v_event.type_kind, v_event.title, v_event.day,
      v_event.end_day, v_event.status, v_event.revision, p_result)
    returning id into v_log_id;
  -- The event's request keys stay spent; then its own rows: the change log before the request records it names.
  insert into calendar.event_deleted_request_keys (performed_by_user_id, request_key, request_hash, operation, event_id)
    select r.performed_by_user_id, r.request_key, r.request_hash, r.operation, r.event_id
      from calendar.event_requests r where r.event_id = p_event_id;
  delete from calendar.event_changes where event_id = p_event_id;
  delete from calendar.event_requests where event_id = p_event_id;
  delete from calendar.event_selected_fields where event_id = p_event_id;
  delete from calendar.event_targets where event_id = p_event_id;
  delete from calendar.events where id = p_event_id;
  return v_log_id;
end $$;

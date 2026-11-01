-- Rollback of migration v51 (migrations_v2/202611011900_calendar_v51_settings.sql):
-- Settings -> Calendar (K2b-1a). Drops v51's tables, columns, triggers and
-- functions, restores v49's two CHECKs, v49's seed_club_event_types and v49's
-- read-only guard on the types, and deletes v51's migration record, so the
-- migrator applies v51 again on the next start.
--
-- Runs only on an explicit owner order, never automatically, and refuses
-- (nothing dropped) when:
--   - the migrator is running (its advisory lock is held);
--   - v51 is not recorded;
--   - a later migration is recorded (forward-only after that);
--   - any data depends on v51: a settings request or change, a club-made or
--     changed or archived type or detail, a non-seed or hidden option, a
--     place, a team setting, an event's chosen detail or value, an event with
--     a library place, a request or change of kind set_fields or
--     align_sessions (the data would be lost).
-- The tables are locked ACCESS EXCLUSIVE before the row checks, in the
-- writers' order (an event command takes the event, then its type), so a row
-- written between the check and the drop is impossible and a writer in flight
-- waits or fails with its own bounded lock_timeout. Run it only after the
-- previous release serves again (the K2b-1a server stopped): the drops also
-- lock the tables the new foreign keys reference (users, clubs, teams). The seeded rows' updated_at (touched by v51's icon update)
-- is not restored. Rehearsed on a disposable database by
-- backend/tests/central-calendar-k2b-settings.test.mjs (apply -> rollback ->
-- the v50 catalog digest identical -> re-apply; every refusal). The code of
-- the K2b-1a release must not serve after this rollback.

begin;
set local lock_timeout = '10s';

-- The migrator's lock (MIGRATION_LOCK_KEY in backend/src/migrate.js), for this
-- transaction: no deploy can apply or record a migration while v51 is undone.
do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v51 rollback refused: the migrator holds its lock (a migration is running)';
  end if;
end $$;

-- v51 recorded here, before any table of it is touched.
do $$
declare
  v_recorded integer;
begin
  select count(*) into v_recorded from public.schema_migrations where migration_name = 'migrations_v2/202611011900_calendar_v51_settings.sql';
  if v_recorded <> 1 then
    raise exception 'v51 rollback refused: v51 is not recorded (% rows)', v_recorded;
  end if;
end $$;

lock table calendar.events, calendar.event_types, calendar.event_targets, calendar.event_session_links,
           calendar.event_activity_links, calendar.event_requests, calendar.event_changes,
           calendar.event_fields, calendar.event_field_options, calendar.event_type_fields,
           calendar.event_selected_fields, calendar.event_field_values, calendar.locations,
           calendar.team_settings, calendar.settings_requests, calendar.settings_changes in access exclusive mode;

do $$
declare
  v_later integer;
  v_rows integer;
begin
  select count(*) into v_later from public.schema_migrations
   where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611011900_calendar_v51_settings.sql';
  if v_later > 0 then
    raise exception 'v51 rollback refused: % later migration(s) recorded', v_later;
  end if;
  select (select count(*) from calendar.settings_requests) + (select count(*) from calendar.settings_changes)
       + (select count(*) from calendar.event_types where created_by_user_id is not null or revision <> 1 or color_key is not null or archived_at is not null)
       + (select count(*) from calendar.event_fields where created_by_user_id is not null or revision <> 1 or archived_at is not null or seed_key is null)
       + (select count(*) from calendar.event_field_options where seed_key is null or archived_at is not null)
       + (select count(*) from calendar.locations) + (select count(*) from calendar.team_settings)
       + (select count(*) from calendar.event_selected_fields) + (select count(*) from calendar.event_field_values)
       + (select count(*) from calendar.events where location_id is not null)
       + (select count(*) from calendar.event_requests where operation in ('set_fields', 'align_sessions'))
       + (select count(*) from calendar.event_changes where kind in ('set_fields', 'align_sessions'))
    into v_rows;
  if v_rows > 0 then
    raise exception 'v51 rollback refused: % row(s) depend on v51', v_rows;
  end if;
end $$;

-- The events: the place.
drop trigger events_location_guard on calendar.events;
drop function calendar.events_location_guard();
drop index calendar.events_location_idx;
alter table calendar.events drop constraint events_location_one;
alter table calendar.events drop column location_id;

-- The new tables (their triggers and indexes go with them), dependents first.
drop table calendar.settings_changes;
drop table calendar.settings_requests;
drop table calendar.event_field_values;
drop table calendar.event_selected_fields;
drop table calendar.event_type_fields;
drop table calendar.event_field_options;
drop table calendar.team_settings;
drop table calendar.locations;
drop table calendar.event_fields;

-- The types: v51's guards and columns; the icons back to v49's null.
drop trigger event_types_need_change on calendar.event_types;
drop trigger event_types_club_no_delete on calendar.event_types;
drop trigger event_types_k2b_guard on calendar.event_types;
alter table calendar.event_types drop column color_key;
alter table calendar.event_types drop column revision;
update calendar.event_types set icon_key = null where icon_key is not null;

-- v49's two CHECKs, as v49 wrote them.
alter table calendar.event_requests drop constraint event_requests_operation_check;
alter table calendar.event_requests add constraint event_requests_operation_check check (operation in (
  'create', 'update', 'cancel', 'attach_sessions', 'detach_sessions',
  'attach_activity', 'detach_activity', 'set_schedule', 'clear_schedule'));
alter table calendar.event_changes drop constraint event_changes_kind_check;
alter table calendar.event_changes add constraint event_changes_kind_check check (kind in (
  'create', 'update', 'cancel', 'attach_sessions', 'detach_sessions',
  'attach_activity', 'detach_activity', 'set_schedule', 'clear_schedule'));

-- v51's functions (the tables' trigger functions are no longer used).
drop function calendar.event_types_need_change();
drop function calendar.event_types_club_no_delete();
drop function calendar.event_types_k2b_guard();
drop function calendar.event_fields_need_change();
drop function calendar.event_fields_no_delete();
drop function calendar.event_fields_guard();
drop function calendar.event_field_options_need_parent();
drop function calendar.event_field_options_no_delete();
drop function calendar.event_field_options_guard();
drop function calendar.event_type_fields_need_parent();
drop function calendar.event_type_fields_guard();
drop function calendar.event_selected_fields_need_parent();
drop function calendar.event_selected_fields_guard();
drop function calendar.event_field_values_need_parent();
drop function calendar.event_field_values_guard();
drop function calendar.locations_need_change();
drop function calendar.locations_guard();
drop function calendar.team_settings_need_change();
drop function calendar.team_settings_guard();
drop function calendar.settings_changes_before_insert();
drop function calendar.settings_requests_need_change();
drop function calendar.location_usable(uuid, uuid);
drop function calendar.field_has_values(uuid);
drop function calendar.written_in_this_transaction(xid);
drop function calendar.detail_number_ok(numeric);
drop function calendar.color_key_ok(text);

-- v49's seed function, verbatim.
create or replace function calendar.seed_club_event_types(p_club_id uuid) returns integer language plpgsql as $$
declare
  v_count integer;
begin
  insert into calendar.event_types (owner_scope, owner_club_id, kind, key, label, default_expects, sort_order, seed_key)
  select 'club', p_club_id, s.kind, s.key, s.label, s.default_expects, s.sort_order, s.seed_key
    from calendar.event_types s
   where s.owner_scope = 'system' and s.seed_key is not null and s.archived_at is null
     and not exists (select 1 from calendar.event_types x
                      where x.owner_scope = 'club' and x.owner_club_id = p_club_id and x.seed_key = s.seed_key)
   order by s.sort_order;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- v49's read-only guard on the types, verbatim (after the icons above).
create function calendar.event_types_k2a_read_only() returns trigger language plpgsql as $$
begin
  raise exception 'calendar.event_types: % is refused until Settings -> Calendar exists (K2b)', tg_op using errcode = '23514';
end $$;
create trigger event_types_k2a_read_only
  before update on calendar.event_types
  for each row execute function calendar.event_types_k2a_read_only();

delete from public.schema_migrations where migration_name = 'migrations_v2/202611011900_calendar_v51_settings.sql';

commit;

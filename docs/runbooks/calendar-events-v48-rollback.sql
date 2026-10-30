-- Rollback of migration v48 (migrations_v2/202610311000_calendar_v48_events.sql):
-- the central calendar's events. Drops the schema `calendar` and v48's
-- migration record, so the migrator applies v48 again on the next start.
--
-- Runs only on an explicit owner order, never automatically, and refuses
-- (nothing dropped) when:
--   - the migrator is running (its advisory lock is held);
--   - v48 is not recorded;
--   - a later migration is recorded (forward-only after that);
--   - any event, target, session link, activity link, request or change row
--     exists (the data would be lost);
--   - the catalog holds a row that is not the seed as v48 wrote it (a K2b edit
--     or an added type).
-- The tables are locked ACCESS EXCLUSIVE before the row checks, in the
-- writers' order (types, events, targets, links, requests, changes — the v47
-- pattern), so a row written between the check and the drop is impossible and
-- a writer in flight waits or fails with its own bounded lock_timeout.
-- Rehearsed on a disposable database by backend/tests/central-calendar-k2a-events.test.mjs
-- (test 1b: apply -> rollback -> the v47 catalog digest identical -> re-apply;
-- every refusal). The code of the K2a-1a release must not serve after this
-- rollback.

begin;
set local lock_timeout = '10s';

-- The migrator's lock (MIGRATION_LOCK_KEY in backend/src/migrate.js), for this
-- transaction: no deploy can apply or record a migration while v48 is undone.
do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v48 rollback refused: the migrator holds its lock (a migration is running)';
  end if;
end $$;

-- v48 recorded here, before any table of it is touched (a database without
-- v48 gets this sentence, not a missing relation).
do $$
declare
  v_recorded integer;
begin
  select count(*) into v_recorded from public.schema_migrations where migration_name = 'migrations_v2/202610311000_calendar_v48_events.sql';
  if v_recorded <> 1 then
    raise exception 'v48 rollback refused: v48 is not recorded (% rows)', v_recorded;
  end if;
end $$;

lock table calendar.event_types, calendar.events, calendar.event_targets, calendar.event_session_links,
           calendar.event_activity_links, calendar.event_requests, calendar.event_changes in access exclusive mode;

do $$
declare
  v_later integer;
  v_rows integer;
  v_non_seed integer;
begin
  select count(*) into v_later from public.schema_migrations
   where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202610311000_calendar_v48_events.sql';
  if v_later > 0 then
    raise exception 'v48 rollback refused: % later migration(s) recorded', v_later;
  end if;
  select (select count(*) from calendar.events) + (select count(*) from calendar.event_targets)
       + (select count(*) from calendar.event_session_links) + (select count(*) from calendar.event_activity_links)
       + (select count(*) from calendar.event_requests) + (select count(*) from calendar.event_changes)
    into v_rows;
  if v_rows > 0 then
    raise exception 'v48 rollback refused: % event, target, link, request or change row(s) exist', v_rows;
  end if;
  select count(*) into v_non_seed
    from calendar.event_types t
   where t.seed_key is null or t.archived_at is not null or t.icon_key is not null or t.created_by_user_id is not null
      or t.owner_scope not in ('system', 'club')
      or (t.owner_scope = 'club' and not exists (select 1 from public.clubs c where c.id = t.owner_club_id));
  if v_non_seed > 0 then
    raise exception 'v48 rollback refused: % catalog row(s) are not the seed as v48 wrote it', v_non_seed;
  end if;
end $$;

drop schema calendar cascade;
delete from public.schema_migrations where migration_name = 'migrations_v2/202610311000_calendar_v48_events.sql';

commit;

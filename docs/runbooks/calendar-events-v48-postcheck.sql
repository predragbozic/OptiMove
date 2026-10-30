-- v48 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor after the deploy of the K2a-1a pull request, one numbered block
-- at a time. Every block is a plain SELECT; nothing is written. The expected
-- values are in the comments; any other value means: stop, change nothing,
-- report the block, the column and the value.

-- 1. v48 recorded once, with the repository's checksum (the sha256 named in
--    the pull request), as the last migration; nothing recorded after it.
--    Expected: v48_rows = 1, later_rows = 0, last_migration =
--    migrations_v2/202610311000_calendar_v48_events.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610311000_calendar_v48_events.sql') as v48_rows,
  (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202610311000_calendar_v48_events.sql') as v48_checksum,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202610311000_calendar_v48_events.sql') as later_rows,
  (select migration_name from public.schema_migrations where migration_name like 'migrations_v2/%' order by migration_name desc limit 1) as last_migration;

-- 2. The objects: seven tables, the functions, the triggers - every trigger
--    enabled.
--    Expected: tables = 7, functions = 22, triggers = 26, disabled_triggers = 0.
select
  (select count(*) from pg_tables where schemaname = 'calendar') as tables,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'calendar') as functions,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'calendar' and not t.tgisinternal) as triggers,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'calendar' and not t.tgisinternal and t.tgenabled = 'D') as disabled_triggers;

-- 3. The seed: exactly seven system types and seven per active club, nothing
--    else; every club copy carries its seed key.
--    Expected: system_types = 7, club_copies = 7 * active_clubs (block 6 of
--    the preflight), other_rows = 0, copies_without_seed_key = 0,
--    clubs_without_seven = 0.
select
  (select count(*) from calendar.event_types where owner_scope = 'system') as system_types,
  (select count(*) from calendar.event_types where owner_scope = 'club') as club_copies,
  (select count(*) from public.clubs where coalesce(is_active, true)) as active_clubs,
  (select count(*) from calendar.event_types where owner_scope not in ('system', 'club')) as other_rows,
  (select count(*) from calendar.event_types where owner_scope = 'club' and seed_key is null) as copies_without_seed_key,
  (select count(*) from public.clubs c where coalesce(c.is_active, true)
      and (select count(*) from calendar.event_types t where t.owner_scope = 'club' and t.owner_club_id = c.id) <> 7) as clubs_without_seven;

-- 4. Nothing was written by the deploy itself.
--    Expected: every count 0 (events are made by coaches, after the deploy).
select
  (select count(*) from calendar.events) as events,
  (select count(*) from calendar.event_targets) as targets,
  (select count(*) from calendar.event_session_links) as session_links,
  (select count(*) from calendar.event_activity_links) as activity_links,
  (select count(*) from calendar.event_requests) as requests,
  (select count(*) from calendar.event_changes) as changes;

-- 5. No lock and no idle transaction on the new tables.
--    Expected: every count 0.
select
  (select count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'calendar' and l.pid <> pg_backend_pid()) as locks_on_calendar,
  (select count(*) from pg_stat_activity where state = 'idle in transaction' and pid <> pg_backend_pid()) as idle_in_transaction;

-- 6. The new schema is reachable only through the backend: the Data API's
--    roles hold no privilege on it (the owner's check of 2026-10-27 covered
--    training_load; the calendar schema holds athlete targets and notes).
--    Expected: anon_usage = false, authenticated_usage = false (or the role
--    missing: null), tables_granted = 0 (every privilege on a calendar table
--    held by anon, authenticated or PUBLIC, read from the tables' own ACLs).
select
  (select has_schema_privilege('anon', 'calendar', 'USAGE') where exists (select 1 from pg_roles where rolname = 'anon')) as anon_usage,
  (select has_schema_privilege('authenticated', 'calendar', 'USAGE') where exists (select 1 from pg_roles where rolname = 'authenticated')) as authenticated_usage,
  (select count(*)
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     left join pg_roles r on r.oid = a.grantee
    where n.nspname = 'calendar' and c.relkind in ('r', 'v')
      and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'))) as tables_granted;

-- 7. Every active club has its seven types. A club created by the OLD server
--    during the deploy window (between the migration and the switch) has
--    none; the repair is the seed function itself, idempotent by seed key —
--    on the owner's order only:
--      select c.id, calendar.seed_club_event_types(c.id) from public.clubs c
--       where coalesce(c.is_active, true)
--         and (select count(*) from calendar.event_types t where t.owner_scope = 'club' and t.owner_club_id = c.id) <> 7;
--    Expected here: clubs_without_seven = 0 (block 3 repeats it).
select count(*) as clubs_without_seven
  from public.clubs c
 where coalesce(c.is_active, true)
   and (select count(*) from calendar.event_types t where t.owner_scope = 'club' and t.owner_club_id = c.id) <> 7;

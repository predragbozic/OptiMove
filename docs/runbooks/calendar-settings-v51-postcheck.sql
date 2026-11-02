-- v51 production post-check - READ ONLY. For the owner (or the manager, on
-- the standing order) to run in the Supabase SQL Editor after the deploy of
-- the K2b-1a pull request, one numbered block at a time. Every block is a
-- plain SELECT; nothing is written. The expected values are in the comments;
-- any other value means: stop, change nothing, report the block, the column
-- and the value.

-- 1. v51 recorded once, with the repository's checksum (the sha256 named in
--    the pull request), as the last migration; nothing recorded after it.
--    Expected: v51_rows = 1, later_rows = 0, last_migration =
--    migrations_v2/202611011900_calendar_v51_settings.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611011900_calendar_v51_settings.sql') as v51_rows,
  (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611011900_calendar_v51_settings.sql') as v51_checksum,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611011900_calendar_v51_settings.sql') as later_rows,
  (select migration_name from public.schema_migrations where migration_name like 'migrations_v2/%' order by migration_name desc limit 1) as last_migration;

-- 2. The objects: sixteen tables, the functions, the triggers - every trigger
--    enabled, K2a's read-only guard on the types gone.
--    Expected: tables = 16, functions = 48, triggers = 61, disabled_triggers = 0,
--    read_only_guard = 0.
select
  (select count(*) from pg_tables where schemaname = 'calendar') as tables,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'calendar') as functions,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'calendar' and not t.tgisinternal) as triggers,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'calendar' and not t.tgisinternal and t.tgenabled = 'D') as disabled_triggers,
  (select count(*) from pg_trigger where tgname = 'event_types_k2a_read_only' and not tgisinternal) as read_only_guard;

-- 3. The seed: ten system details, seventeen options, thirteen list entries;
--    the same for every active club; every type has its icon.
--    Expected: system_fields = 10, system_options = 17, system_lists = 13,
--    clubs_not_complete = 0, types_without_icon = 0, active_clubs = the
--    number of the preflight's block 5 (or more, if a club was created since).
select
  (select count(*) from calendar.event_fields where owner_scope = 'system') as system_fields,
  (select count(*) from calendar.event_field_options o join calendar.event_fields f on f.id = o.field_id where f.owner_scope = 'system') as system_options,
  (select count(*) from calendar.event_type_fields l join calendar.event_types t on t.id = l.event_type_id where t.owner_scope = 'system') as system_lists,
  (select count(*) from public.clubs c
    where coalesce(c.is_active, true)
      and ((select count(*) from calendar.event_fields f where f.owner_scope = 'club' and f.owner_club_id = c.id) <> 10
        or (select count(*) from calendar.event_field_options o join calendar.event_fields f on f.id = o.field_id
             where f.owner_scope = 'club' and f.owner_club_id = c.id) <> 17
        or (select count(*) from calendar.event_type_fields l join calendar.event_types t on t.id = l.event_type_id
             where t.owner_scope = 'club' and t.owner_club_id = c.id) <> 13)) as clubs_not_complete,
  (select count(*) from calendar.event_types where icon_key is null) as types_without_icon,
  (select count(*) from public.clubs where coalesce(is_active, true)) as active_clubs;

-- 4. Nothing was written by the deploy itself.
--    Expected: every count 0.
select
  (select count(*) from calendar.settings_requests) as settings_requests,
  (select count(*) from calendar.settings_changes) as settings_changes,
  (select count(*) from calendar.locations) as locations,
  (select count(*) from calendar.team_settings) as team_settings,
  (select count(*) from calendar.event_selected_fields) as selections,
  (select count(*) from calendar.event_field_values) as field_values,
  (select count(*) from calendar.events where location_id is not null) as events_with_place,
  (select count(*) from calendar.event_types where created_by_user_id is not null or revision <> 1) as changed_types,
  (select count(*) from calendar.event_fields where created_by_user_id is not null or revision <> 1) as changed_fields;

-- 5. No lock and no idle transaction on the calendar tables.
--    Expected: every count 0.
select
  (select count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'calendar' and l.pid <> pg_backend_pid()) as locks_on_calendar,
  (select count(*) from pg_stat_activity where state = 'idle in transaction' and pid <> pg_backend_pid()) as idle_in_transaction;

-- 6. The schema stays reachable only through the backend: the Data API's
--    roles hold no privilege on it (places carry addresses and notes).
--    Expected: anon_usage = false, authenticated_usage = false (or the role
--    missing: null), tables_granted = 0.
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

-- 7. Every active club has its copies. A club created by the OLD server
--    during the deploy window gets them too: the old server calls
--    calendar.seed_club_event_types, which v51 replaced. A club that has none
--    (archived before v49 or v51 and active again by a direct database write)
--    is repaired by the seed function itself, idempotent by seed key — on the
--    owner's order only:
--      select c.id, calendar.seed_club_event_types(c.id) from public.clubs c where c.id = '<club id>';
--    Expected here: clubs_without_details = 0.
select count(*) as clubs_without_details
  from public.clubs c
 where coalesce(c.is_active, true)
   and not exists (select 1 from calendar.event_fields f where f.owner_scope = 'club' and f.owner_club_id = c.id);

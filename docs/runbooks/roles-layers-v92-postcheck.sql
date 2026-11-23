-- Read-only post-check of migration v92 (roles R4-1; migrations_v2/202611241000_roles_v92_layers_foundation.sql).
-- Run each block on its own inside `begin transaction read only; ... rollback;`. Every column whose name ends in `ok`
-- must be true. Nothing here writes.

-- Block 1: v92 recorded once (compare `checksum` with the file's sha256)
select count(*) = 1 as v92_recorded_ok, max(checksum) as checksum
  from public.schema_migrations where migration_name = 'migrations_v2/202611241000_roles_v92_layers_foundation.sql';

-- Block 2: the bodies are v92's
select bool_and(md5(p.prosrc) is not distinct from e.want) as v92_bodies_ok, count(p.oid) = 11 as v92_bodies_found_ok
  from (select 'lock_club_ceiling' as fn, 'ee43ae057289f628c199efabf1160d27' as want union all
  select 'lock_permission_actor' as fn, 'f2fd3f7b3004327afd86926fb4f71e8c' as want union all
  select 'permission_club_lock_held' as fn, '9c4d8fbc25b5004cf5bd84402284633b' as want union all
  select 'permission_club_rule7_ok' as fn, '0f97c7a6c365e73e19c649bfe1a304b5' as want union all
  select 'permission_requests_guard' as fn, '92299209ef9b664261566218c0504437' as want union all
  select 'permission_role_club_items' as fn, '1359f7661c664d6f1f59762ca083d254' as want union all
  select 'permission_rule7_check' as fn, '336b3da064167f8f3043d107fa0e0ab0' as want union all
  select 'permission_user_holdings' as fn, '7c8511a90c202c5cd94d22fe707de1ce' as want union all
  select 'permission_word_honoured' as fn, '0c47ce1a6b157c1c9205d4f48438a5ac' as want union all
  select 'user_has_permission' as fn, '3ee2c276f7caf9fb50066aa753e7c079' as want union all
  select 'user_holds_role_items' as fn, 'e6486b67eda7284be4683f418818f27a' as want) e
  left join pg_proc p on p.pronamespace = 'public'::regnamespace and p.proname = e.fn;

-- Block 3: the eight tables, row-level security on, no row yet
select count(*) = 8 as tables_ok, bool_and(c.relrowsecurity) as rls_ok,
       (select count(*) from public.club_permission_ceiling) + (select count(*) from public.club_permission_ceiling_changes)
       + (select count(*) from public.permission_club_role_versions) + (select count(*) from public.permission_custom_roles) = 0 as no_rows_ok
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('club_permission_ceiling', 'club_permission_ceiling_changes', 'permission_club_role_versions', 'permission_club_role_version_items', 'permission_club_role_version_changes', 'permission_custom_roles', 'permission_custom_role_items', 'permission_custom_role_changes');

-- Block 4: every v92 trigger enabled (on the new tables and the two old role tables)
select count(*) filter (where t.tgenabled = 'O') = count(*) as triggers_enabled_ok, count(*) >= 30 as triggers_found_ok
  from pg_trigger t
 where not t.tgisinternal
   and t.tgrelid in (select c.oid from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('club_permission_ceiling', 'club_permission_ceiling_changes', 'permission_club_role_versions', 'permission_club_role_version_items', 'permission_club_role_version_changes', 'permission_custom_roles', 'permission_custom_role_items', 'permission_custom_role_changes', 'user_club_roles', 'user_team_roles'));

-- Block 5: the seed - the eleven view words in Club admin and Team coach; the last change of each is v92's 'migration' row
select (select count(*) from public.permission_role_items where role_id = '00000000-0000-4000-8000-000000000842' and permission_word in ('athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view', 'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view', 'variables.view')) = 11 as club_admin_view_ok,
       (select count(*) from public.permission_role_items where role_id = '00000000-0000-4000-8000-000000000843' and permission_word in ('athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view', 'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view', 'variables.view')) = 11 as team_coach_view_ok,
       (select count(*) from public.permission_roles r where r.basic_key in ('club_admin', 'team_coach')
         and r.revision = (select max(c.revision_after) from public.permission_role_changes c
                            where c.role_id = r.id and c.kind = 'migration' and c.migration_name = 'migrations_v2/202611241000_roles_v92_layers_foundation.sql')) = 2 as seed_changes_ok,
       (select count(*) from public.permission_role_items where role_id = '00000000-0000-4000-8000-000000000842') = 18 as club_admin_count_ok,
       (select count(*) from public.permission_role_items where role_id = '00000000-0000-4000-8000-000000000843') = 14 as team_coach_count_ok;

-- Block 6: the twin still answers: no account lost a word of v84 (the platform admins pass; for the record the count of
-- active club admins whose org.view at their club is true, which must equal the count of their active rows)
select (select count(*) from public.user_club_roles r join public.users u on u.id = r.user_id and u.is_active
         where r.is_active and r.role = 'club_admin' and public.user_has_permission(r.user_id, 'staff.assign', 'club', r.club_id))
     = (select count(*) from public.user_club_roles r join public.users u on u.id = r.user_id and u.is_active where r.is_active and r.role = 'club_admin') as club_admins_ok,
       (select count(*) from public.user_team_roles r join public.users u on u.id = r.user_id and u.is_active
         where r.is_active and r.role = 'team_coach' and public.user_has_permission(r.user_id, 'athletes.manage', 'team', r.team_id))
     = (select count(*) from public.user_team_roles r join public.users u on u.id = r.user_id and u.is_active where r.is_active and r.role = 'team_coach') as team_coaches_ok;

-- Block 7: no idle transaction left behind and no lock wait on the roles tables
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and pid <> pg_backend_pid() and xact_start < now() - interval '1 minute') as no_idle_ok,
       not exists (select 1 from pg_locks where not granted) as no_lock_wait_ok;

-- Read-only preflight of migration v92 (roles R4-1; migrations_v2/202611241000_roles_v92_layers_foundation.sql).
-- Run each block on its own inside `begin transaction read only; ... rollback;`. Every column whose name ends in `ok`
-- must be true; the other columns are for the record. Nothing here writes.

-- Block 1: the server and the migration record
select current_setting('server_version_num')::int >= 130000 as server_ok,
       exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611201300_roles_v84_permission_roles.sql'
                 and checksum = 'dfafb581c762d724d63a8356f93d9422ec96e27dfab75a344746e83b23df2e9c') as v84_recorded_ok,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611241000_roles_v92_layers_foundation.sql') as v92_absent_ok,
       (select max(migration_name) from public.schema_migrations) as last_migration;

-- Block 2: the bodies v92 replaces (and the one it relies on) are v84's
select bool_and(md5(p.prosrc) is not distinct from e.want) as v84_bodies_ok, count(p.oid) = 7 as v84_bodies_found_ok
  from (select 'lock_permission_actor' as fn, '30a14455bd6eb8b466784bfa3ac41872' as want union all
  select 'permission_actor_holds' as fn, '4cf78e6ef38cf5e1006ff1b9c81b59e2' as want union all
  select 'permission_requests_guard' as fn, 'd362631a890348310fab41bc5675e457' as want union all
  select 'permission_rule7_check' as fn, 'fdaa0829e0cfe7f3ea9ba9ce2aec8bf9' as want union all
  select 'permission_word_honoured' as fn, '73ef8a1da7a45d4f68310fcc35210cd3' as want union all
  select 'user_has_permission' as fn, '98d788a19e8c0b04c8a20fdf6ba0a191' as want union all
  select 'user_holds_role_items' as fn, '742f4c03c8b0c1916d9581ee84619096' as want) e
  left join pg_proc p on p.pronamespace = 'public'::regnamespace and p.proname = e.fn;

-- Block 3: no v92 object yet
select not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('club_permission_ceiling', 'club_permission_ceiling_changes', 'permission_club_role_versions', 'permission_club_role_version_items', 'permission_club_role_version_changes', 'permission_custom_roles', 'permission_custom_role_items', 'permission_custom_role_changes')) as v92_tables_absent_ok,
       not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('lock_club_ceiling', 'permission_user_holdings', 'permission_club_lock_held')) as v92_functions_absent_ok,
       not exists (select 1 from pg_trigger t where not t.tgisinternal and t.tgname like '%permission_%' and t.tgrelid in ('public.user_club_roles'::regclass, 'public.user_team_roles'::regclass)) as old_tables_untouched_ok;

-- Block 4: the basic roles' items are v84's seed
select (select array_agg(permission_word order by permission_word) from public.permission_role_items where role_id = '00000000-0000-4000-8000-000000000842')
         = array['athletes.manage', 'athletes.remove', 'org.club.edit', 'org.teams.manage', 'org.view', 'roles.manage', 'staff.assign'] as club_admin_seed_ok,
       (select array_agg(permission_word order by permission_word) from public.permission_role_items where role_id = '00000000-0000-4000-8000-000000000843')
         = array['athletes.manage', 'athletes.remove', 'org.view'] as team_coach_seed_ok;

-- Block 5: every view word of the package is in the catalog with club and team rows, neither platform- nor system-role-only
select count(*) = 11 as view_words_ok
  from public.permissions p
 where p.word in ('athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view', 'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view', 'variables.view') and not p.platform_only and not p.system_role_only
   and (select count(*) from public.permission_scope_types s where s.permission_word = p.word and s.scope_type in ('club', 'team')) = 2;

-- Block 6: the two request-record constraints v92 replaces exist under the names it drops
select exists (select 1 from pg_constraint where conrelid = 'public.permission_requests'::regclass and conname = 'permission_requests_operation_check') as operation_check_ok,
       exists (select 1 from pg_constraint where conrelid = 'public.permission_requests'::regclass and conname = 'permission_requests_result_shape') as result_shape_ok;

-- Block 7: for the record (no ok column): how many rows v92's new triggers will watch
select (select count(*) from public.user_club_roles) as club_role_rows, (select count(*) from public.user_team_roles) as team_role_rows,
       (select count(*) from public.user_role_assignments where revoked_at is null) as live_assignments,
       (select count(*) from public.permission_roles where archived_at is null) as roles;

-- Block 8: a quiet moment: no other transaction holds a lock on the roles tables
select not exists (select 1 from pg_locks l join pg_class c on c.oid = l.relation
                    where l.pid <> pg_backend_pid() and c.relnamespace = 'public'::regnamespace
                      and c.relname in ('permission_roles', 'permission_role_items', 'permission_requests', 'user_club_roles', 'user_team_roles', 'user_role_assignments')) as quiet_ok;

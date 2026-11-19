-- Read-only POST-CHECK for migration v84 (roles and permissions, step R2; migrations_v2/202611201000_roles_v84_permission_roles.sql).
-- Run after the deploy the merge triggers. Changes nothing: run each block as
--   begin transaction read only; <block>; rollback;
-- Every ok column must be true; block 6a is compared by the reader with preflight block 3a.

-- 1. v84 is recorded once, its checksum the file's sha256 (the literal below; the runbook test keeps it equal to the
--    file), and it is the last migration.
select count(*) = 1 as recorded_once,
       bool_and(checksum = 'dfafb581c762d724d63a8356f93d9422ec96e27dfab75a344746e83b23df2e9c') as checksum_is_the_file,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611201000_roles_v84_permission_roles.sql' as is_last
  from public.schema_migrations where migration_name = 'migrations_v2/202611201000_roles_v84_permission_roles.sql';

-- 2. The nine tables, row-level security on each, and no privilege of PUBLIC, anon, authenticated or service_role on any table or function of v84.
with t as (select c.oid, c.relname, c.relrowsecurity, c.relacl, c.relowner from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
              and c.relname in ('permission_modules', 'permissions', 'permission_scope_types', 'permission_roles', 'permission_role_items',
                                'permission_role_module_display', 'permission_role_changes', 'user_role_assignments', 'permission_requests')),
     f as (select p.oid, p.proacl, p.proowner from pg_proc p where p.pronamespace = 'public'::regnamespace
            and (p.proname like 'permission\_%' or p.proname in ('user_has_permission', 'user_holds_role_items', 'lock_permission_actor') or p.proname like 'user\_role\_assignments\_%')),
     grantees as (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role') union all select 0::oid)
select (select count(*) from t) = 9 as nine_tables,
       (select bool_and(relrowsecurity) from t) as rls_on_every_table,
       not exists (select 1 from t, aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) a where a.grantee in (select oid from grantees)) as tables_not_granted,
       (select count(*) from f) = 29 as twenty_nine_functions,
       not exists (select 1 from f, aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a where a.grantee in (select oid from grantees)) as functions_not_granted;

-- 3. The triggers (present, enabled, deferral as written), the functions (body md5, not security definer, volatility, search_path),
--    every foreign key ON DELETE RESTRICT, and every CHECK read back as written (one digest each, from the rehearsal).
--    The search_path is fixed first: regclass / regprocedure text and pg_get_constraintdef name a schema by visibility.
set local search_path = pg_catalog, public;
with tables as (select oid from pg_class where relnamespace = 'public'::regnamespace and relname in ('permission_modules', 'permissions', 'permission_scope_types',
                  'permission_roles', 'permission_role_items', 'permission_role_module_display', 'permission_role_changes', 'user_role_assignments', 'permission_requests'))
select (select md5(string_agg(c.relname || '.' || g.tgname || ':' || g.tgenabled::text || ':' || g.tgdeferrable::text || ':' || g.tginitdeferred::text, ',' order by c.relname, g.tgname))
          from pg_trigger g join pg_class c on c.oid = g.tgrelid where g.tgrelid in (select oid from tables) and not g.tgisinternal) = 'b7075e2b07448c13f7f1e63b8280a970' as triggers_as_written,
       not exists (select 1 from pg_trigger g where g.tgrelid in (select oid from tables) and not g.tgisinternal and g.tgenabled <> 'O') as every_trigger_enabled,
       (select md5(string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':' || coalesce(array_to_string(p.proconfig, ';'), ''), ',' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace
           and (p.proname like 'permission\_%' or p.proname in ('user_has_permission', 'user_holds_role_items', 'lock_permission_actor') or p.proname like 'user\_role\_assignments\_%')) = '3140c03e91e730cf532d32d9a7a6d43f' as functions_as_written,
       not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
                    and (p.proname like 'permission\_%' or p.proname in ('user_has_permission', 'user_holds_role_items', 'lock_permission_actor'))) as no_security_definer,
       not exists (select 1 from pg_constraint k where k.conrelid in (select oid from tables) and k.contype = 'f' and k.confdeltype <> 'r') as every_fk_restrict,
       (select md5(string_agg(k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid), ',' order by k.conrelid::regclass::text, k.conname))
          from pg_constraint k where k.conrelid in (select oid from tables)) = '70bb738f95f73e4c63fab7b2661a99e5' as constraints_as_written;

-- 4. The seed: 12 modules, 52 permissions, 89 scope rows, 4 roles, 10 item rows; the seed fingerprint (the rollback's expression).
select (select count(*) from public.permission_modules) = 12 as modules_12,
       (select count(*) from public.permissions) = 52 as permissions_52,
       (select count(*) from public.permission_scope_types) = 89 as scope_rows_89,
       (select count(*) from public.permission_roles) = 4 as roles_4,
       (select count(*) from public.permission_role_items) = 10 as items_10,
       md5(
      coalesce((select string_agg(format('%s|%s|%s', word, label, sort_order), ';' order by word) from public.permission_modules), '') || '#'
   || coalesce((select string_agg(format('%s|%s|%s|%s|%s', word, module_word, platform_only, system_role_only, sort_order), ';' order by word) from public.permissions), '') || '#'
   || coalesce((select string_agg(format('%s|%s', permission_word, scope_type), ';' order by permission_word, scope_type) from public.permission_scope_types), '') || '#'
   || coalesce((select string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s', id, name, coalesce(description, ''), assignable_club, assignable_team,
                                         assignable_private, assignable_global, revision, coalesce(archived_at::text, '')), ';' order by id) from public.permission_roles), '') || '#'
   || coalesce((select string_agg(format('%s|%s', role_id, permission_word), ';' order by role_id, permission_word) from public.permission_role_items), '') || '#'
   || coalesce((select string_agg(format('%s|%s|%s', role_id, module_word, display), ';' order by role_id, module_word) from public.permission_role_module_display), '')
       ) = 'bee6e8768fceb7a6115cbed0acf31aec' as seed_fingerprint;

-- 5. Nothing was assigned, changed or requested; no module-switch table (a later migration of its own).
select not exists (select 1 from public.user_role_assignments) as no_assignments,
       not exists (select 1 from public.permission_role_changes) as no_changes,
       not exists (select 1 from public.permission_requests) as no_requests,
       not exists (select 1 from public.permission_roles where basic_key is null) as only_the_four_roles,
       to_regclass('public.module_switches') is null and to_regclass('public.module_switch_changes') is null as no_module_switches;

-- 6. Both CHECKs on the old scoped role tables, present and validated.
select (select count(*) from pg_constraint where conrelid = 'public.user_club_roles'::regclass and conname = 'user_club_roles_role_word' and convalidated
          and pg_get_constraintdef(oid) = 'CHECK (((role)::text = ''club_admin''::text))') = 1 as club_check,
       (select count(*) from pg_constraint where conrelid = 'public.user_team_roles'::regclass and conname = 'user_team_roles_role_word' and convalidated
          and pg_get_constraintdef(oid) = 'CHECK (((role)::text = ''team_coach''::text))') = 1 as team_check;

-- 6a. The fingerprint of the three old role tables: equal to preflight block 3a (v84 rewrites no existing role row).
select (select count(*) from public.user_global_roles) as global_rows,
       (select md5(coalesce(string_agg(t::text, ';' order by t.id), '')) from public.user_global_roles t) as global_digest,
       (select count(*) from public.user_club_roles) as club_rows,
       (select md5(coalesce(string_agg(t::text, ';' order by t.id), '')) from public.user_club_roles t) as club_digest,
       (select count(*) from public.user_team_roles) as team_rows,
       (select md5(coalesce(string_agg(t::text, ';' order by t.id), '')) from public.user_team_roles t) as team_digest;

-- 7. The twin's spot rows: an active platform admin passes at global scope; the nil user does not.
select coalesce((select public.user_has_permission(g.user_id, 'platform.admin', 'global', null)
                   from public.user_global_roles g join public.users u on u.id = g.user_id
                  where g.role = 'platform_admin' and g.is_active and u.is_active order by g.user_id limit 1), true) as platform_admin_passes,
       public.user_has_permission('00000000-0000-0000-0000-000000000000', 'org.view', 'club', '00000000-0000-0000-0000-000000000001') = false as nil_user_refused;

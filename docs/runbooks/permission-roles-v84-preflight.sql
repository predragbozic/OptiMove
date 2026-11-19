-- Read-only PREFLIGHT for migration v84 (roles and permissions, step R2; migrations_v2/202611201000_roles_v84_permission_roles.sql).
-- A merge to main is the deploy (Render Auto-Deploy): run it right before the merge, at the quiet moment chosen for it
-- (docs/runbooks/permission-roles-v84.md). Changes nothing: run each block as
--   begin transaction read only; <block>; rollback;
-- Blocks 1-7 return ok columns that must all be true; 3a and 5 are also for the reader; block 8 is run in git.

-- 1. The server, the last recorded migration, v84 not recorded.
select current_setting('server_version_num')::int >= 130000 as server_13_or_later,
       current_setting('server_version') as server_version,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') < 'migrations_v2/202611201000_roles_v84_permission_roles.sql' as v84_sorts_last,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611201000_roles_v84_permission_roles.sql') as v84_not_recorded,
       not exists (select 1 from public.schema_migrations where checksum is null or checksum !~ '^[0-9a-f]{64}$') as checksums_shaped;

-- 2. No object of v84 exists (the nine tables, the functions, the two constraints).
select (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in ('permission_modules', 'permissions', 'permission_scope_types',
          'permission_roles', 'permission_role_items', 'permission_role_module_display', 'permission_role_changes', 'user_role_assignments', 'permission_requests')) = 0 as no_tables,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'permission\_%' or proname in ('user_has_permission', 'user_holds_role_items', 'lock_permission_actor') or proname like 'user\_role\_assignments\_%')) = 0 as no_functions,
       (select count(*) from pg_constraint where conname in ('user_club_roles_role_word', 'user_team_roles_role_word')) = 0 as no_constraints;

-- 3. Every row of the two old scoped role tables (active or not) carries its one word: v84 refuses otherwise.
select (select count(*) from public.user_club_roles where role is distinct from 'club_admin') as club_rows_other_word,
       (select count(*) from public.user_team_roles where role is distinct from 'team_coach') as team_rows_other_word,
       (select count(*) from public.user_club_roles where role is distinct from 'club_admin') = 0
         and (select count(*) from public.user_team_roles where role is distinct from 'team_coach') = 0 as ok;

-- 3a. The fingerprint of the three old role tables (row count and a digest of every row), kept for post-check block 6a.
select (select count(*) from public.user_global_roles) as global_rows,
       (select md5(coalesce(string_agg(t::text, ';' order by t.id), '')) from public.user_global_roles t) as global_digest,
       (select count(*) from public.user_club_roles) as club_rows,
       (select md5(coalesce(string_agg(t::text, ';' order by t.id), '')) from public.user_club_roles t) as club_digest,
       (select count(*) from public.user_team_roles) as team_rows,
       (select md5(coalesce(string_agg(t::text, ';' order by t.id), '')) from public.user_team_roles t) as team_digest;

-- 4. user_global_roles holds only its two words (its own CHECK is in force).
select not exists (select 1 from public.user_global_roles where role not in ('platform_admin', 'independent_coach')) as ok;

-- 5. For the reader: the roles anon / authenticated (they decide which revokes v84 runs) and the owner of public.users.
select exists (select 1 from pg_roles where rolname = 'anon') as anon_exists,
       exists (select 1 from pg_roles where rolname = 'authenticated') as authenticated_exists,
       (select pg_get_userbyid(relowner) from pg_class where oid = 'public.users'::regclass) as users_owner,
       has_schema_privilege(current_user, 'public', 'CREATE') as can_create_in_public;

-- 6. Nothing v84 adds is there already: no function of those names, and no value of the acting-user setting.
select not exists (select 1 from pg_proc where proname in ('user_has_permission', 'lock_permission_actor', 'permission_context_actor')) as no_twin,
       coalesce(current_setting('optimove.permission_actor', true), '') = '' as no_actor_setting;

-- 7. A quiet moment: no idle transaction, no lock wait, no long transaction holding the role tables.
select not exists (select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction') as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
                    where l.relation in ('public.user_club_roles'::regclass, 'public.user_team_roles'::regclass)
                      and a.xact_start < now() - interval '30 seconds' and a.pid <> pg_backend_pid()) as no_long_tx_on_role_tables;

-- 8. (In git, not SQL) the 12-digit prefix is unique on the merge tree (.claude/rules/migrations.md):
--   git ls-tree --name-only $(git merge-tree --write-tree origin/main <head>) migrations_v2/ | sed 's#.*/##' | grep -E '^[0-9]{12}_' | cut -c1-12 | sort | uniq -d
--   must print nothing.

-- 1b. (Generated in the checkout, run read-only here) no checksum of a recorded migrations_v2 file differs from the
--   repository's (contract 7.1, item 1). On the merge tree:
--     node backend/scripts/permission-roles-v84-checksums.mjs > v84-checksums.sql
--   then run that one statement in begin transaction read only; ... rollback;
--   no_recorded_checksum_differs must be true; recorded_not_in_repo is for the reader (0 expected on the merge tree).

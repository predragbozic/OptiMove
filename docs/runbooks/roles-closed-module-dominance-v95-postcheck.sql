-- Read-only POST-CHECK for migration v95 (R2's dominance inside a club whose licence closes a module;
-- migrations_v2/202611271000_roles_v95_closed_module_dominance.sql). Run it right after the deploy
-- (docs/runbooks/roles-closed-module-dominance-v95.md). Changes nothing: run each block as
--   begin transaction read only; <block>; rollback;
-- Every block returns ok columns that must all be true.

-- 1. v95 recorded once with a shaped checksum.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611271000_roles_v95_closed_module_dominance.sql') = 1 as v95_recorded_once,
       (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611271000_roles_v95_closed_module_dominance.sql') ~ '^[0-9a-f]{64}$' as checksum_shaped,
       (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611271000_roles_v95_closed_module_dominance.sql') as checksum_for_the_reader;

-- 2. The four bodies and the new function are v95's; the new function is not executable by PUBLIC.
select (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_actor_holds_in_club') = 'da8b90ab31b0a96d13e8d263d7b42770' as holds_in_club_is_v95,
       (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_club_role_version_items_guard') = 'bec037f372b4afb9334cd56f31916aa7' as version_items_guard_is_v95,
       (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_club_role_versions_complete') = 'b9c58f7a95deb48d89e1626700fe7e08' as versions_complete_is_v95,
       (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_custom_role_items_guard') = '1b2833cefe8e83ece62f039d8e122e49' as custom_items_guard_is_v95,
       (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_custom_roles_complete') = 'd3f4777620765d2ea9270bddf82b6893' as customs_complete_is_v95,
       not has_function_privilege('public', 'public.permission_actor_holds_in_club(uuid, text, uuid)', 'execute') as not_public;

-- 3. The guards still fire: their triggers exist and are enabled (v95 changes no trigger).
select (select count(*) from pg_trigger g join pg_proc p on p.oid = g.tgfoid
         where not g.tgisinternal and g.tgenabled = 'O' and p.proname in (
           'permission_club_role_version_items_guard', 'permission_club_role_versions_complete',
           'permission_custom_role_items_guard', 'permission_custom_roles_complete')) = 4 as four_triggers_enabled;

-- 4. No idle transaction, no lock wait.
select not exists (select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction') as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

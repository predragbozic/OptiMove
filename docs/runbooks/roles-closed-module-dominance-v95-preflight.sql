-- Read-only PREFLIGHT for migration v95 (R2's dominance inside a club whose licence closes a module;
-- migrations_v2/202611271000_roles_v95_closed_module_dominance.sql). Run it right before the merge, at the quiet moment
-- chosen for it (docs/runbooks/roles-closed-module-dominance-v95.md). Changes nothing: run each block as
--   begin transaction read only; <block>; rollback;
-- Every block returns ok columns that must all be true; block 3 is for the reader.

-- 1. The server, the last recorded migration (for the reader), v95 not recorded, v92 recorded.
select current_setting('server_version_num')::int >= 150000 as server_15_or_later,
       current_setting('server_version') as server_version,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611271000_roles_v95_closed_module_dominance.sql') as v95_not_recorded,
       exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611241000_roles_v92_layers_foundation.sql') as v92_recorded,
       not exists (select 1 from public.schema_migrations where checksum is null or checksum !~ '^[0-9a-f]{64}$') as checksums_shaped;

-- 2. The four bodies v95 replaces are v92's; the function it adds does not exist.
select (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_club_role_version_items_guard') = 'd98a0076818f143a932b5f8f835c8635' as version_items_guard_is_v92,
       (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_club_role_versions_complete') = '4bd61e03b5ebd341588d31140c919387' as versions_complete_is_v92,
       (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_custom_role_items_guard') = '4b9b0f8d193a412ebc4b1235397a69d2' as custom_items_guard_is_v92,
       (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_custom_roles_complete') = 'c8ea92473b20abb89bdccc59a01c5932' as customs_complete_is_v92,
       to_regprocedure('public.permission_actor_holds_in_club(uuid, text, uuid)') is null as no_new_function;

-- 3. For the reader: what the guards read (v95 changes no row).
select (select count(*) from public.club_permission_ceiling) as closed_modules,
       (select count(*) from public.permission_club_role_versions where ended_at is null) as live_club_versions,
       (select count(*) from public.permission_custom_roles where ended_at is null) as live_custom_roles;

-- 4. A quiet moment: no idle transaction, no lock wait.
select not exists (select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction') as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

-- 5. (In git, not SQL) the 12-digit prefix is unique on the merge tree (.claude/rules/migrations.md):
--   git ls-tree --name-only $(git merge-tree --write-tree origin/main <head>) migrations_v2/ | sed 's#.*/##' | grep -E '^[0-9]{12}_' | cut -c1-12 | sort | uniq -d
--   must print nothing.

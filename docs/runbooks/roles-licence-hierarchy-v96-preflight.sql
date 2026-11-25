-- Read-only PREFLIGHT for migration v96 (the licence hierarchy; migrations_v2/202611281000_roles_v96_licence_hierarchy.sql).
-- Run it right before the merge, at the quiet moment chosen for it (docs/runbooks/roles-licence-hierarchy-v96.md).
-- Changes nothing: run each block as
--   begin transaction read only; <block>; rollback;
-- Every block returns ok columns that must all be true; block 3 is for the reader.

-- 1. The server, the last recorded migration (for the reader), v96 not recorded, v95 recorded.
select current_setting('server_version_num')::int >= 150000 as server_15_or_later,
       current_setting('server_version') as server_version,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611281000_roles_v96_licence_hierarchy.sql') as v96_not_recorded,
       exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611271000_roles_v95_closed_module_dominance.sql') as v95_recorded,
       not exists (select 1 from public.schema_migrations where checksum is null or checksum !~ '^[0-9a-f]{64}$') as checksums_shaped;

-- 2. The three bodies v96 replaces are v92's and v95's; the functions it adds do not exist; the four modules exist.
select (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'user_has_permission') = '3ee2c276f7caf9fb50066aa753e7c079' as twin_is_v92,
       (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_club_rule7_ok') = '0f97c7a6c365e73e19c649bfe1a304b5' as rule7_is_v92,
       (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_actor_holds_in_club') = 'da8b90ab31b0a96d13e8d263d7b42770' as holds_in_club_is_v95,
       to_regprocedure('public.permission_module_parent(text)') is null as no_parent_function,
       to_regprocedure('public.permission_club_module_closed(uuid, text)') is null as no_closed_function,
       (select count(*) from public.permission_modules where word in ('training_load', 'dashboards', 'imports', 'data_configuration')) = 4 as four_modules;

-- 3. For the reader: the stored ceiling (v96 changes no row). In a club with training_load closed, the role holders
--    lose every child it did not close on its own: children_newly_closed counts those (club, child) pairs.
select (select count(*) from public.club_permission_ceiling) as closed_rows,
       (select count(*) from public.club_permission_ceiling where module_word = 'training_load') as clubs_with_training_load_closed,
       (select count(*) from public.club_permission_ceiling c
         cross join unnest(array['dashboards', 'imports', 'data_configuration']) ch(module)
         where c.module_word = 'training_load'
           and not exists (select 1 from public.club_permission_ceiling o where o.club_id = c.club_id and o.module_word = ch.module)) as children_newly_closed;

-- 4. A quiet moment: no idle transaction, no lock wait.
select not exists (select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction') as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

-- 5. (In git, not SQL) the 12-digit prefix is unique on the merge tree (.claude/rules/migrations.md):
--   git ls-tree --name-only $(git merge-tree --write-tree origin/main <head>) migrations_v2/ | sed 's#.*/##' | grep -E '^[0-9]{12}_' | cut -c1-12 | sort | uniq -d
--   must print nothing.

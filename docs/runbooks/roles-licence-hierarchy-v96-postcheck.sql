-- Read-only POST-CHECK for migration v96 (the licence hierarchy; migrations_v2/202611281000_roles_v96_licence_hierarchy.sql).
-- Run it right after the deploy (docs/runbooks/roles-licence-hierarchy-v96.md). Changes nothing: run each block as
--   begin transaction read only; <block>; rollback;
-- Every block returns ok columns that must all be true.

-- 1. v96 recorded once with a shaped checksum.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611281000_roles_v96_licence_hierarchy.sql') = 1 as v96_recorded_once,
       (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611281000_roles_v96_licence_hierarchy.sql') ~ '^[0-9a-f]{64}$' as checksum_shaped,
       (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611281000_roles_v96_licence_hierarchy.sql') as checksum_for_the_reader;

-- 2. The three bodies and the two new functions are v96's; the new functions are not executable by PUBLIC.
select (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'user_has_permission') = '6f3ae322a169fe73fb1dcb336e1b768d' as twin_is_v96,
       (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_club_rule7_ok') = '73f962702edc2c76f276f3f3501c3aad' as rule7_is_v96,
       (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_actor_holds_in_club') = '0a2cfed0d1a498d9b214be799add36f3' as holds_in_club_is_v96,
       (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_club_module_closed') = '1ddbaf5d0eca6e9ec8656cd9fb43067c' as module_closed_is_v96,
       (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'permission_module_parent') = '103605328dfc0a41c773939889db97f9' as parent_is_v96,
       not has_function_privilege('public', 'public.permission_module_parent(text)', 'execute') as parent_not_public,
       not has_function_privilege('public', 'public.permission_club_module_closed(uuid, text)', 'execute') as module_closed_not_public;

-- 3. The hierarchy as v96 states it: exactly the three children of training_load, and no other module has a parent.
select (select array_agg(m.word order by m.word) from public.permission_modules m where public.permission_module_parent(m.word) = 'training_load')
         = array['dashboards', 'data_configuration', 'imports'] as three_children,
       not exists (select 1 from public.permission_modules m where public.permission_module_parent(m.word) is not null
                     and public.permission_module_parent(m.word) <> 'training_load') as one_parent,
       public.permission_module_parent('training_load') is null as parent_has_no_parent;

-- 4. Every club whose training_load row is stored reads its three children as closed; the stored rows are unchanged
--    (compare closed_rows with preflight block 3).
select not exists (
         select 1 from public.club_permission_ceiling c
          cross join unnest(array['dashboards', 'imports', 'data_configuration']) ch(module)
          where c.module_word = 'training_load' and not public.permission_club_module_closed(c.club_id, ch.module)) as children_closed_with_parent,
       (select count(*) from public.club_permission_ceiling) as closed_rows;

-- 5. No idle transaction, no lock wait.
select not exists (select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction') as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

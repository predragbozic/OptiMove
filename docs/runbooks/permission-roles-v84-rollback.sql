-- Rollback of migration v84 (roles and permissions, step R2; migrations_v2/202611201000_roles_v84_permission_roles.sql).
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/permission-roles-v84-migration.test.mjs:
-- apply -> rollback -> the catalog identical to before -> apply again), on PostgreSQL 16 and, by the command in
-- docs/runbooks/permission-roles-v84.md, on 17. Before it is run anywhere real: the deployed commit no longer contains the v84
-- file (otherwise the migrator applies v84 again at the next start) and runs R1's can() (the previous commit; it reads nothing
-- of v84), and the database is named in its own approval (.claude/rules/database-safety.md).
--
-- It drops the nine tables, their functions and triggers, the two CHECKs on public.user_club_roles and public.user_team_roles,
-- and the v84 record. It changes no other row. It refuses (23514, fixed message), changing nothing, once any of these holds
-- (contract 7.3) - from then on v84 is forward-only:
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v84 is not recorded, or a later migrations_v2 migration is;
--   * a row of user_role_assignments, permission_role_changes, permission_requests or permission_role_module_display;
--   * a role without a basic_key;
--   * a foreign key from outside the nine tables into any of them;
--   * the seed fingerprint differs from the one below (the lookup rows, the four roles' mutable columns, the 10 item rows and
--     the (empty) display rows).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f permission-roles-v84-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
declare
  seed_fingerprint text;
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v84 rollback refused: the migrator is running' using errcode = '23514';
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611201000_roles_v84_permission_roles.sql') then
    raise exception 'v84 rollback refused: v84 is not recorded on this database' using errcode = '23514';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611201000_roles_v84_permission_roles.sql') then
    raise exception 'v84 rollback refused: later migrations are applied' using errcode = '23514';
  end if;
  if exists (select 1 from public.user_role_assignments) or exists (select 1 from public.permission_role_changes)
     or exists (select 1 from public.permission_requests) or exists (select 1 from public.permission_role_module_display) then
    raise exception 'v84 rollback refused: roles were changed or assigned' using errcode = '23514';
  end if;
  if exists (select 1 from public.permission_roles where basic_key is null) then
    raise exception 'v84 rollback refused: a role was created' using errcode = '23514';
  end if;
  if exists (
       select 1 from pg_constraint k
        where k.contype = 'f'
          and k.confrelid in ('public.permission_modules'::regclass, 'public.permissions'::regclass, 'public.permission_scope_types'::regclass,
                              'public.permission_roles'::regclass, 'public.permission_role_items'::regclass,
                              'public.permission_role_module_display'::regclass, 'public.permission_role_changes'::regclass,
                              'public.user_role_assignments'::regclass, 'public.permission_requests'::regclass)
          and k.conrelid not in ('public.permission_modules'::regclass, 'public.permissions'::regclass, 'public.permission_scope_types'::regclass,
                                 'public.permission_roles'::regclass, 'public.permission_role_items'::regclass,
                                 'public.permission_role_module_display'::regclass, 'public.permission_role_changes'::regclass,
                                 'public.user_role_assignments'::regclass, 'public.permission_requests'::regclass)) then
    raise exception 'v84 rollback refused: another table refers to the roles tables' using errcode = '23514';
  end if;
  -- The seed fingerprint (the same expression as post-check block 4).
  select md5(
      coalesce((select string_agg(format('%s|%s|%s', word, label, sort_order), ';' order by word) from public.permission_modules), '') || '#'
   || coalesce((select string_agg(format('%s|%s|%s|%s|%s', word, module_word, platform_only, system_role_only, sort_order), ';' order by word) from public.permissions), '') || '#'
   || coalesce((select string_agg(format('%s|%s', permission_word, scope_type), ';' order by permission_word, scope_type) from public.permission_scope_types), '') || '#'
   || coalesce((select string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s', id, name, coalesce(description, ''), assignable_club, assignable_team,
                                         assignable_private, assignable_global, revision, coalesce(archived_at::text, '')), ';' order by id) from public.permission_roles), '') || '#'
   || coalesce((select string_agg(format('%s|%s', role_id, permission_word), ';' order by role_id, permission_word) from public.permission_role_items), '') || '#'
   || coalesce((select string_agg(format('%s|%s|%s', role_id, module_word, display), ';' order by role_id, module_word) from public.permission_role_module_display), ''))
    into seed_fingerprint;
  if seed_fingerprint is distinct from 'bee6e8768fceb7a6115cbed0acf31aec' then
    raise exception 'v84 rollback refused: the seed was changed' using errcode = '23514';
  end if;
end $$;

alter table public.user_club_roles drop constraint user_club_roles_role_word;
alter table public.user_team_roles drop constraint user_team_roles_role_word;

-- The two functions that use the roles table's row type go before the table.
drop function public.permission_actor_holds(uuid, public.permission_roles, text);
drop function public.permission_role_child_check(uuid, text);

drop table public.permission_requests;
drop table public.user_role_assignments;
drop table public.permission_role_changes;
drop table public.permission_role_module_display;
drop table public.permission_role_items;
drop table public.permission_roles;
drop table public.permission_scope_types;
drop table public.permissions;
drop table public.permission_modules;

drop function public.lock_permission_actor(uuid, text, uuid, uuid, uuid);
drop function public.user_holds_role_items(uuid, uuid, text, uuid);
drop function public.permission_actor_basis(uuid, text, text, uuid);
drop function public.permission_role_actor_may(uuid, text, uuid);
drop function public.user_has_permission(uuid, text, text, uuid);
drop function public.permission_word_honoured(text);
drop function public.permission_current_xmin();
drop function public.permission_actor_absent();
drop function public.permission_context_actor();
drop function public.permission_display_ok(jsonb);
drop function public.permission_text_ok(text, integer);
drop function public.permission_catalog_fixed();
drop function public.permission_catalog_complete();
drop function public.permission_roles_guard();
drop function public.permission_roles_refuse_delete();
drop function public.permission_roles_complete();
drop function public.permission_role_items_guard();
drop function public.permission_role_items_refuse();
drop function public.permission_rule7_check();
drop function public.permission_role_module_display_guard();
drop function public.permission_role_changes_guard();
drop function public.permission_append_only();
drop function public.permission_role_changes_complete();
drop function public.user_role_assignments_guard();
drop function public.user_role_assignments_refuse_delete();
drop function public.user_role_assignments_complete();
drop function public.permission_requests_guard();

delete from public.schema_migrations where migration_name = 'migrations_v2/202611201000_roles_v84_permission_roles.sql';
commit;

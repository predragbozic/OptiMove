-- Roles v96: the licence hierarchy (P-4, the owner's decision of 2026-11-25; docs/ai/roles-v-steps-plan.md section 12.1;
-- docs/runbooks/roles-licence-hierarchy-v96.md).
--
-- Training Load is a parent module: closing it in a club's licence closes its children - Dashboards, Imports and Data
-- configuration - as well. Each child can still be closed on its own. One level only: a child has no children, a parent
-- has no parent. The stored ceiling (public.club_permission_ceiling) keeps the decisions as they were made; a module is
-- CLOSED for a club when its own row is there OR its parent's row is there (the effective ceiling, derived on read).
--
-- What it adds:
--   public.permission_module_parent(module)        - the fixed hierarchy (the three children -> 'training_load', else
--                                                    null). A function, not a column: v84 fixes public.permission_modules.
--                                                    Its JavaScript twin is MODULE_PARENTS in backend/src/permissions.js
--                                                    (a test pins them equal).
--   public.permission_club_module_closed(club, module) - the effective ceiling of one module in one club.
-- What it replaces (md5-gated below), each changing ONLY its ceiling test to the effective one:
--   public.user_has_permission (v92 step 6), public.permission_club_rule7_ok (v92, "minus the closed modules") and
--   public.permission_actor_holds_in_club (v95, the dominance of a closed word).
-- Not changed: public.permission_club_closed_modules (the stored rows, which the licence writer and screen read), the
-- ceiling's table, guards and triggers, and every row. With Training Load closed a child word is refused by the twin
-- (stricter), and rule 7 and dominance treat it as closed (looser); a club without Training Load closed sees no change.
-- The rollback is docs/runbooks/roles-licence-hierarchy-v96-rollback.sql.

set local lock_timeout = '5s';

-- 0. v95 recorded; the three bodies in force are v92's / v95's; the new functions absent; the four modules exist.
do $$
declare
  expected constant text[][] := array[
    ['user_has_permission', '3ee2c276f7caf9fb50066aa753e7c079'],
    ['permission_club_rule7_ok', '0f97c7a6c365e73e19c649bfe1a304b5'],
    ['permission_actor_holds_in_club', 'da8b90ab31b0a96d13e8d263d7b42770']];
  i int;
begin
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611271000_roles_v95_closed_module_dominance.sql') then
    raise exception 'v96 refused: v95 is not recorded' using errcode = '23514';
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v96 refused: the body in force of public.% is not the one v96 replaces', expected[i][1] using errcode = '23514';
    end if;
  end loop;
  if to_regprocedure('public.permission_module_parent(text)') is not null
     or to_regprocedure('public.permission_club_module_closed(uuid, text)') is not null then
    raise exception 'v96 refused: a function v96 adds already exists' using errcode = '23514';
  end if;
  if (select count(*) from public.permission_modules where word in ('training_load', 'dashboards', 'imports', 'data_configuration')) <> 4 then
    raise exception 'v96 refused: a module of the hierarchy is not in the catalog' using errcode = '23514';
  end if;
end;
$$;

-- 1. The hierarchy and the effective ceiling.
create function public.permission_module_parent(p_module text) returns text
  language sql immutable set search_path = pg_catalog, public as $$
    select case p_module
             when 'dashboards' then 'training_load'
             when 'imports' then 'training_load'
             when 'data_configuration' then 'training_load'
           end
  $$;

-- Is the module closed for the club: its own row, or its parent's (a null club has no ceiling, Q10).
create function public.permission_club_module_closed(p_club uuid, p_module text) returns boolean
  language sql stable set search_path = pg_catalog, public as $$
    select p_club is not null and exists (
      select 1 from public.club_permission_ceiling m
       where m.club_id = p_club
         and (m.module_word = p_module or m.module_word = public.permission_module_parent(p_module)))
  $$;

-- v92's revokes for the new functions (a replaced body keeps its own).
do $$
declare
  f text;
  r text;
begin
  foreach f in array array['public.permission_module_parent(text)', 'public.permission_club_module_closed(uuid, text)'] loop
    execute format('revoke execute on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke execute on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
end $$;

-- 2. The twin of can() (v92 section 7): only step 6 changes.
create or replace function public.user_has_permission(p_user uuid, p_permission text, p_scope_type text, p_scope_id uuid)
returns boolean as $$
declare
  w record;
  club uuid;
begin
  -- 1. An unknown word or scope type is a programming error (M12).
  select word, platform_only, module_word into w from public.permissions where word = p_permission;
  if not found or p_scope_type is null or p_scope_type not in ('global', 'club', 'team', 'private') then
    raise exception 'permission check: unknown permission or scope type' using errcode = '22023';
  end if;
  -- 2. No user, an unknown or an inactive one (M13).
  if p_user is null or not exists (select 1 from public.users where id = p_user and is_active = true) then
    return false;
  end if;
  -- 3. A platform admin holds everything (O1: never limited by a ceiling).
  if exists (select 1 from public.user_global_roles where user_id = p_user and role = 'platform_admin' and is_active = true) then
    return true;
  end if;
  -- 4. Convention 1: global scope and platform-only words are a platform admin's only.
  if w.platform_only or p_scope_type = 'global' then
    return false;
  end if;
  -- 5. Convention 3: a scope without an id is no resource.
  if p_scope_id is null or p_scope_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;
  if p_scope_type = 'team' then
    select t.club_id into club from public.teams t where t.id = p_scope_id;
    if not found then
      return false;
    end if;
  elsif p_scope_type = 'club' then
    club := p_scope_id;
  end if;
  -- 6. The ceiling: the word's module closed for the club, on its own or through its parent (v96; a team without a
  --    club has none, Q10).
  if club is not null and public.permission_club_module_closed(club, w.module_word) then
    return false;
  end if;
  -- 7 to 9. Any live holding for the scope (a club's holding reaches its teams) whose effective items hold the word.
  return exists (
    select 1 from public.permission_user_holdings(p_user) h
     where p_permission = any (h.words)
       and ((h.scope_type = p_scope_type and h.scope_id = p_scope_id)
            or (p_scope_type = 'team' and h.scope_type = 'club' and h.scope_id = club)));
end;
$$ language plpgsql stable set search_path = pg_catalog, public;

-- 3. Rule 7 inside a club (v92 section 9): "minus the closed modules" reads the effective ceiling.
create or replace function public.permission_club_rule7_ok(p_club uuid) returns boolean
  language sql stable set search_path = pg_catalog, public as $$
    with ca as (
      select unnest(public.permission_role_club_items((select id from public.permission_roles where basic_key = 'club_admin'), p_club)) as word
    )
    select exists (select 1 from ca where word = 'staff.assign')
       and exists (select 1 from ca where word = 'roles.manage')
       and not exists (
         select 1
           from public.permission_roles r
          cross join lateral unnest(public.permission_role_club_items(r.id, p_club)) w(word)
           join public.permissions p on p.word = w.word
          where r.owner_scope = 'system' and r.archived_at is null
            and r.basic_key is distinct from 'platform_admin' and r.basic_key is distinct from 'club_admin'
            and exists (select 1 from public.permission_scope_types s where s.permission_word = w.word and s.scope_type = 'club')
            and not public.permission_club_module_closed(p_club, p.module_word)
            and not exists (select 1 from ca where ca.word = w.word))
  $$;

-- 4. R2's dominance of a closed word (v95): the word's module closed on its own or through its parent.
create or replace function public.permission_actor_holds_in_club(p_actor uuid, p_word text, p_club uuid) returns boolean
  language sql stable set search_path = pg_catalog, public as $$
    select public.user_has_permission(p_actor, p_word, 'club', p_club)
        or (exists (select 1 from public.permissions p
                     where p.word = p_word and public.permission_club_module_closed(p_club, p.module_word))
            and exists (select 1 from public.users u where u.id = p_actor and u.is_active)
            and exists (select 1 from public.permission_user_holdings(p_actor) h
                         where h.scope_type = 'club' and h.scope_id = p_club and p_word = any (h.words)))
  $$;

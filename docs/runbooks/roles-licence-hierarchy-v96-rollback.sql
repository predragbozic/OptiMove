-- ROLLBACK of migration v96 (the licence hierarchy; migrations_v2/202611281000_roles_v96_licence_hierarchy.sql). One
-- transaction, at a quiet moment, only on its own approval (docs/runbooks/roles-licence-hierarchy-v96.md, "Rollback").
-- Before running it the deployed commit no longer contains the v96 file.
--
-- It REFUSES, changing nothing, when: v96 is not recorded; a later migration is recorded; a body in force is not v96's.
-- It restores v92's user_has_permission and permission_club_rule7_ok and v95's permission_actor_holds_in_club verbatim
-- (checked by md5 at the end) and drops public.permission_club_module_closed and public.permission_module_parent. It
-- changes no row: the stored ceiling stays as it is, so a club that closed Training Load but not a child gets that
-- child back for its role holders.

begin;
set local lock_timeout = '5s';

do $$
declare
  expected constant text[][] := array[
    ['user_has_permission', '6f3ae322a169fe73fb1dcb336e1b768d'],
    ['permission_club_rule7_ok', '73f962702edc2c76f276f3f3501c3aad'],
    ['permission_actor_holds_in_club', '0a2cfed0d1a498d9b214be799add36f3'],
    ['permission_club_module_closed', '1ddbaf5d0eca6e9ec8656cd9fb43067c'],
    ['permission_module_parent', '103605328dfc0a41c773939889db97f9']];
  i int;
begin
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611281000_roles_v96_licence_hierarchy.sql') then
    raise exception 'v96 rollback refused: v96 is not recorded' using errcode = '23514';
  end if;
  if exists (select 1 from public.schema_migrations m where m.migration_name <> 'migrations_v2/202611281000_roles_v96_licence_hierarchy.sql'
              and m.applied_at >= (select applied_at from public.schema_migrations where migration_name = 'migrations_v2/202611281000_roles_v96_licence_hierarchy.sql')) then
    raise exception 'v96 rollback refused: a later migration is recorded' using errcode = '23514';
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v96 rollback refused: the body in force of public.% is not v96''s', expected[i][1] using errcode = '23514';
    end if;
  end loop;
end;
$$;

-- 1. v92's twin of can(), verbatim.
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
  -- 6. The ceiling: the word's module closed for the club (a team without a club has none, Q10).
  if club is not null and exists (select 1 from public.club_permission_ceiling m where m.club_id = club and m.module_word = w.module_word) then
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

-- 2. v92's rule 7 inside a club, verbatim.
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
            and not exists (select 1 from public.club_permission_ceiling m where m.club_id = p_club and m.module_word = p.module_word)
            and not exists (select 1 from ca where ca.word = w.word))
  $$;

-- 3. v95's dominance of a closed word, verbatim.
create or replace function public.permission_actor_holds_in_club(p_actor uuid, p_word text, p_club uuid) returns boolean
  language sql stable set search_path = pg_catalog, public as $$
    select public.user_has_permission(p_actor, p_word, 'club', p_club)
        or (exists (select 1 from public.permissions p
                      join public.club_permission_ceiling m on m.module_word = p.module_word and m.club_id = p_club
                     where p.word = p_word)
            and exists (select 1 from public.users u where u.id = p_actor and u.is_active)
            and exists (select 1 from public.permission_user_holdings(p_actor) h
                         where h.scope_type = 'club' and h.scope_id = p_club and p_word = any (h.words)))
  $$;

-- 4. What v96 added.
drop function public.permission_club_module_closed(uuid, text);
drop function public.permission_module_parent(text);
delete from public.schema_migrations where migration_name = 'migrations_v2/202611281000_roles_v96_licence_hierarchy.sql';

-- 5. The bodies are v92's and v95's again.
do $$
declare
  expected constant text[][] := array[
    ['user_has_permission', '3ee2c276f7caf9fb50066aa753e7c079'],
    ['permission_club_rule7_ok', '0f97c7a6c365e73e19c649bfe1a304b5'],
    ['permission_actor_holds_in_club', 'da8b90ab31b0a96d13e8d263d7b42770']];
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v96 rollback: a restored body of public.% is not the one before v96', expected[i][1] using errcode = '23514';
    end if;
  end loop;
  -- v96 loosened rule 7 (a child of a closed parent is left out); the restored body may refuse a club version written
  -- under v96. Refuse the whole rollback (the bodies come back) rather than leave a club that breaks rule 7 without
  -- the hierarchy: its next licence or version write would fail until fixed by hand.
  if exists (select 1 from public.clubs c where not public.permission_club_rule7_ok(c.id)) then
    raise exception 'v96 rollback refused: a club breaks rule 7 without the hierarchy' using errcode = '23514';
  end if;
end;
$$;

commit;

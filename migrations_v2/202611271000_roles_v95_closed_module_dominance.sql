-- Roles v95: R2's dominance inside a club whose licence closes a module (roles R4 contract 3.5 and 7.2-7.3; the
-- *Rukovodilac* of OptiMove's decision (A), 2026-11-24; docs/runbooks/roles-closed-module-dominance-v95.md).
--
-- v92's four dominance checks of the club versions and the custom roles - the two item guards on INSERT and the two
-- COMMIT checks - require public.user_has_permission(actor, word, 'club', club) for every item. That answer applies
-- the club's ceiling (contract 3.2 step 6), so once a club's licence closes a module whose words its roles carry (the
-- seeded view words sit in Team coach and Club admin), the club's admin "holds" none of them and can make or change no
-- club version or custom role at all. Rule 7 already reads "minus the closed modules"; dominance did not.
--
-- v95 asks instead public.permission_actor_holds_in_club(actor, word, club): the word is held now (the twin, ceiling
-- included), OR its module is closed for the club and the actor holds it through its own club holdings with the
-- ceiling left out (public.permission_user_holdings applies no ceiling: the old row or assignment of the club, its live
-- custom, the club's version, the role's items). So a closed word passes only for an admin who would hold it the moment
-- the module opens again (O1: reopening brings back exactly what was recorded, and an admin still gives only what it
-- holds). A platform admin is unchanged (the twin answers yes). Nothing else changes: who may write, the lock checks,
-- the storable / platform-only / system-role-only / scope-type rules, H1 and rule 7.
--
-- Replaced bodies (md5-gated below, v92's): permission_club_role_version_items_guard,
-- permission_club_role_versions_complete, permission_custom_role_items_guard, permission_custom_roles_complete - in
-- each, only the dominance test. Added: public.permission_actor_holds_in_club. No table, trigger, index or row.
-- The rollback is docs/runbooks/roles-closed-module-dominance-v95-rollback.sql.

set local lock_timeout = '5s';

-- 0. v92 recorded, and the four bodies in force are v92's.
do $$
declare
  expected constant text[][] := array[
    ['permission_club_role_version_items_guard', 'd98a0076818f143a932b5f8f835c8635'],
    ['permission_club_role_versions_complete', '4bd61e03b5ebd341588d31140c919387'],
    ['permission_custom_role_items_guard', '4b9b0f8d193a412ebc4b1235397a69d2'],
    ['permission_custom_roles_complete', 'c8ea92473b20abb89bdccc59a01c5932']];
  i int;
begin
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611241000_roles_v92_layers_foundation.sql') then
    raise exception 'v95 refused: v92 is not recorded' using errcode = '23514';
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v95 refused: the body in force of public.% is not v92''s', expected[i][1] using errcode = '23514';
    end if;
  end loop;
  if to_regprocedure('public.permission_actor_holds_in_club(uuid, text, uuid)') is not null then
    raise exception 'v95 refused: public.permission_actor_holds_in_club already exists' using errcode = '23514';
  end if;
end;
$$;

-- 1. Does the acting user hold the word in the club for R2's dominance? Held now (the twin), or - only for a word of a
--    module the club's licence closes - held through the actor's own club holdings with the ceiling left out.
create function public.permission_actor_holds_in_club(p_actor uuid, p_word text, p_club uuid) returns boolean
  language sql stable set search_path = pg_catalog, public as $$
    select public.user_has_permission(p_actor, p_word, 'club', p_club)
        or (exists (select 1 from public.permissions p
                      join public.club_permission_ceiling m on m.module_word = p.module_word and m.club_id = p_club
                     where p.word = p_word)
            and exists (select 1 from public.users u where u.id = p_actor and u.is_active)
            and exists (select 1 from public.permission_user_holdings(p_actor) h
                         where h.scope_type = 'club' and h.scope_id = p_club and p_word = any (h.words)))
  $$;
-- v92's revokes for the new function (a replaced body keeps its own).
do $$
declare
  f text := 'public.permission_actor_holds_in_club(uuid, text, uuid)';
  r text;
begin
  execute format('revoke execute on function %s from public', f);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function %s from %I', f, r);
    end if;
  end loop;
end $$;

-- 2. The item guard of a club version (v92 section 11): only the dominance line changes.
create or replace function public.permission_club_role_version_items_guard() returns trigger as $$
declare
  v public.permission_club_role_versions;
  r public.permission_roles;
  w public.permissions;
  actor uuid;
  rec record := case when tg_op = 'DELETE' then old else new end;
begin
  select * into v from public.permission_club_role_versions where id = rec.version_id;
  if not found or v.xmin::text::bigint <> public.permission_current_xmin() or v.ended_at is not null then
    raise exception 'permission club version item: the acting user may not write this version' using errcode = '42501';
  end if;
  if not public.permission_club_lock_held(v.club_id, 'exclusive') then
    raise exception 'permissions: the club lock must be taken before the first row lock' using errcode = '55000';
  end if;
  if public.permission_actor_absent() then
    if not exists (select 1 from public.permission_club_role_version_changes c
                    where c.version_id = v.id and c.revision_after = v.revision and c.kind = 'migration'
                      and c.xmin::text::bigint = public.permission_current_xmin()) then
      raise exception 'permission club version item: the acting user may not write this version' using errcode = '42501';
    end if;
    actor := null;
  else
    actor := public.permission_context_actor();
    if not public.permission_version_actor_may(actor, v.club_id, v.system_role_id) then
      raise exception 'permission club version item: the acting user may not write this version' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' then
    select * into r from public.permission_roles where id = v.system_role_id;
    select * into w from public.permissions where word = new.permission_word;
    if w.platform_only then
      raise exception 'permission club version item: a platform-only permission belongs to no role' using errcode = '23514';
    end if;
    if w.system_role_only and r.basic_key is distinct from 'club_admin' then
      raise exception 'permission club version item: this permission exists only in the Club admin role' using errcode = '23514';
    end if;
    if not public.permission_word_honoured(new.permission_word) then
      raise exception 'permission club version item: no route checks this permission yet' using errcode = '23514';
    end if;
    if (r.assignable_club and not exists (select 1 from public.permission_scope_types s where s.permission_word = new.permission_word and s.scope_type = 'club'))
       or (r.assignable_team and not exists (select 1 from public.permission_scope_types s where s.permission_word = new.permission_word and s.scope_type = 'team')) then
      raise exception 'permission club version item: the permission does not cover the role''s scope types' using errcode = '23514';
    end if;
    if actor is not null and not public.permission_is_platform_admin(actor)
       and not public.permission_actor_holds_in_club(actor, new.permission_word, v.club_id) then
      raise exception 'permission club version item: the acting user does not hold this permission' using errcode = '42501';
    end if;
  end if;
  return rec;
end;
$$ language plpgsql set search_path = pg_catalog, public;

-- 3. The COMMIT check of a club version (v92 section 11): only the dominance test changes.
create or replace function public.permission_club_role_versions_complete() returns trigger as $$
declare
  v public.permission_club_role_versions;
  actor uuid;
begin
  select * into v from public.permission_club_role_versions where id = new.id;
  if not exists (select 1 from public.permission_club_role_version_changes c
                  where c.version_id = v.id and c.revision_after = v.revision
                    and c.xmin::text::bigint = public.permission_current_xmin()) then
    raise exception 'permission club version: the change has no change record' using errcode = '23514';
  end if;
  if v.ended_at is null and (select basic_key from public.permission_roles where id = v.system_role_id) = 'club_admin'
     and (not exists (select 1 from public.permission_club_role_version_items i where i.version_id = v.id and i.permission_word = 'staff.assign')
          or not exists (select 1 from public.permission_club_role_version_items i where i.version_id = v.id and i.permission_word = 'roles.manage')) then
    raise exception 'permission club version: the Club admin role must hold this permission' using errcode = '23514';
  end if;
  if not public.permission_actor_absent() then
    actor := public.permission_context_actor();
    if not public.permission_is_platform_admin(actor) and exists (
         select 1 from public.permission_club_role_version_items i
          where i.version_id = v.id and not public.permission_actor_holds_in_club(actor, i.permission_word, v.club_id)) then
      raise exception 'permission club version: the acting user does not hold every permission of this version' using errcode = '42501';
    end if;
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

-- 4. The item guard of a custom role (v92 section 12): only the dominance line changes.
create or replace function public.permission_custom_role_items_guard() returns trigger as $$
declare
  c public.permission_custom_roles;
  r public.permission_roles;
  w public.permissions;
  actor uuid;
  rec record := case when tg_op = 'DELETE' then old else new end;
begin
  select * into c from public.permission_custom_roles where id = rec.custom_role_id;
  if not found or c.xmin::text::bigint <> public.permission_current_xmin() or c.ended_at is not null then
    raise exception 'permission custom role item: the acting user may not write this custom role' using errcode = '42501';
  end if;
  if not public.permission_club_lock_held(c.club_id, 'shared') then
    raise exception 'permissions: the club lock must be taken before the first row lock' using errcode = '55000';
  end if;
  if public.permission_actor_absent() then
    if not exists (select 1 from public.permission_custom_role_changes x
                    where x.custom_role_id = c.id and x.revision_after = c.revision and x.kind = 'migration'
                      and x.xmin::text::bigint = public.permission_current_xmin()) then
      raise exception 'permission custom role item: the acting user may not write this custom role' using errcode = '42501';
    end if;
    actor := null;
  else
    actor := public.permission_context_actor();
    if not public.permission_custom_actor_may(actor, c.club_id, c.base_role_id) then
      raise exception 'permission custom role item: the acting user may not write this custom role' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' then
    select * into r from public.permission_roles where id = c.base_role_id;
    select * into w from public.permissions where word = new.permission_word;
    if w.platform_only then
      raise exception 'permission custom role item: a platform-only permission belongs to no role' using errcode = '23514';
    end if;
    if w.system_role_only and r.basic_key is distinct from 'club_admin' then
      raise exception 'permission custom role item: this permission exists only in the Club admin role' using errcode = '23514';
    end if;
    if not public.permission_word_honoured(new.permission_word) then
      raise exception 'permission custom role item: no route checks this permission yet' using errcode = '23514';
    end if;
    if not exists (select 1 from public.permission_scope_types s where s.permission_word = new.permission_word and s.scope_type = c.scope_type) then
      raise exception 'permission custom role item: the permission does not cover the role''s scope types' using errcode = '23514';
    end if;
    if actor is not null and not public.permission_is_platform_admin(actor)
       and not public.permission_actor_holds_in_club(actor, new.permission_word, c.club_id) then
      raise exception 'permission custom role item: the acting user does not hold this permission' using errcode = '42501';
    end if;
  end if;
  return rec;
end;
$$ language plpgsql set search_path = pg_catalog, public;

-- 5. The COMMIT check of a custom role (v92 section 12): only the dominance test changes.
create or replace function public.permission_custom_roles_complete() returns trigger as $$
declare
  c public.permission_custom_roles;
  actor uuid;
begin
  select * into c from public.permission_custom_roles where id = new.id;
  if not exists (select 1 from public.permission_custom_role_changes x
                  where x.custom_role_id = c.id and x.revision_after = c.revision
                    and x.xmin::text::bigint = public.permission_current_xmin()) then
    raise exception 'permission custom role: the change has no change record' using errcode = '23514';
  end if;
  if c.ended_at is null and (select basic_key from public.permission_roles where id = c.base_role_id) = 'club_admin'
     and (not exists (select 1 from public.permission_custom_role_items i where i.custom_role_id = c.id and i.permission_word = 'staff.assign')
          or not exists (select 1 from public.permission_custom_role_items i where i.custom_role_id = c.id and i.permission_word = 'roles.manage')) then
    raise exception 'permission custom role: the Club admin role must hold this permission' using errcode = '23514';
  end if;
  if c.ended_at is null and not public.permission_actor_absent() then
    actor := public.permission_context_actor();
    if not public.permission_is_platform_admin(actor) and exists (
         select 1 from public.permission_custom_role_items i
          where i.custom_role_id = c.id and not public.permission_actor_holds_in_club(actor, i.permission_word, c.club_id)) then
      raise exception 'permission custom role: the acting user does not hold every permission of this custom role' using errcode = '42501';
    end if;
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

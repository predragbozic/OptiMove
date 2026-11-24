-- ROLLBACK of migration v95 (R2's dominance inside a club whose licence closes a module;
-- migrations_v2/202611271000_roles_v95_closed_module_dominance.sql). One transaction, at a quiet moment, only on its own approval
-- (docs/runbooks/roles-closed-module-dominance-v95.md, "Rollback"). Before running it the deployed commit no longer
-- contains the v95 file.
--
-- It REFUSES, changing nothing, when: v95 is not recorded; a later migration is recorded; a body in force is not v95's.
-- It restores v92's four bodies verbatim (checked by md5 at the end) and drops public.permission_actor_holds_in_club.
-- It changes no row: club versions and custom roles written under v95 stay as they are (v92's checks run on the next
-- write only).

begin;
set local lock_timeout = '5s';

do $$
declare
  expected constant text[][] := array[
    ['permission_actor_holds_in_club', 'da8b90ab31b0a96d13e8d263d7b42770'],
    ['permission_club_role_version_items_guard', 'bec037f372b4afb9334cd56f31916aa7'],
    ['permission_club_role_versions_complete', 'b9c58f7a95deb48d89e1626700fe7e08'],
    ['permission_custom_role_items_guard', '1b2833cefe8e83ece62f039d8e122e49'],
    ['permission_custom_roles_complete', 'd3f4777620765d2ea9270bddf82b6893']];
  i int;
begin
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611271000_roles_v95_closed_module_dominance.sql') then
    raise exception 'v95 rollback refused: v95 is not recorded' using errcode = '23514';
  end if;
  if exists (select 1 from public.schema_migrations m where m.migration_name <> 'migrations_v2/202611271000_roles_v95_closed_module_dominance.sql'
              and m.applied_at >= (select applied_at from public.schema_migrations where migration_name = 'migrations_v2/202611271000_roles_v95_closed_module_dominance.sql')) then
    raise exception 'v95 rollback refused: a later migration is recorded' using errcode = '23514';
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v95 rollback refused: the body in force of public.% is not v95''s', expected[i][1] using errcode = '23514';
    end if;
  end loop;
end;
$$;

-- 1. v92's four bodies, verbatim.
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
       and not public.user_has_permission(actor, new.permission_word, 'club', v.club_id) then
      raise exception 'permission club version item: the acting user does not hold this permission' using errcode = '42501';
    end if;
  end if;
  return rec;
end;
$$ language plpgsql set search_path = pg_catalog, public;

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
          where i.version_id = v.id and not public.user_has_permission(actor, i.permission_word, 'club', v.club_id)) then
      raise exception 'permission club version: the acting user does not hold every permission of this version' using errcode = '42501';
    end if;
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

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
       and not public.user_has_permission(actor, new.permission_word, 'club', c.club_id) then
      raise exception 'permission custom role item: the acting user does not hold this permission' using errcode = '42501';
    end if;
  end if;
  return rec;
end;
$$ language plpgsql set search_path = pg_catalog, public;

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
          where i.custom_role_id = c.id and not public.user_has_permission(actor, i.permission_word, 'club', c.club_id)) then
      raise exception 'permission custom role: the acting user does not hold every permission of this custom role' using errcode = '42501';
    end if;
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

-- 2. What v95 added.
drop function public.permission_actor_holds_in_club(uuid, text, uuid);
delete from public.schema_migrations where migration_name = 'migrations_v2/202611271000_roles_v95_closed_module_dominance.sql';

-- 3. The bodies are v92's again.
do $$
declare
  expected constant text[][] := array[
    ['permission_club_role_version_items_guard', 'd98a0076818f143a932b5f8f835c8635'],
    ['permission_club_role_versions_complete', '4bd61e03b5ebd341588d31140c919387'],
    ['permission_custom_role_items_guard', '4b9b0f8d193a412ebc4b1235397a69d2'],
    ['permission_custom_roles_complete', 'c8ea92473b20abb89bdccc59a01c5932']];
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v95 rollback: a restored body of public.% is not v92''s', expected[i][1] using errcode = '23514';
    end if;
  end loop;
end;
$$;

commit;

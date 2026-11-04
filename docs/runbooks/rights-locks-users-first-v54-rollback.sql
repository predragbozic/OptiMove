-- Rollback of migration v54 (the database's own rights locks take the users
-- row first; LO-2): migrations_v2/202611041100_training_load_v54_rights_locks_users_first.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/rights-locks-users-first-lo2.test.mjs: apply ->
-- rollback -> the v53 bodies exactly (md5) -> re-apply, every refusal below).
-- Before it is run anywhere real: a fresh restore-verified backup exists; the
-- deployed commit no longer contains the v54 migration file (otherwise the
-- migrator applies v54 again at the next start); and the owner approved this
-- database specifically (.claude/rules/database-safety.md).
--
-- It restores the seven bodies byte for byte and removes the v54 record; it
-- changes no other row. It refuses, changing nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v54 is not recorded, or any later migrations_v2 migration is;
--   * a body in force of the seven is not v54's (by md5).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f rights-locks-users-first-v54-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v54 rollback refused: the migrator is running';
  end if;
end $$;

do $$
declare
  v54 constant text := 'migrations_v2/202611041100_training_load_v54_rights_locks_users_first.sql';
  expected constant text[][] := array[
    ['training_load', 'lock_gpexe_import_approver', '9c3bf3edeb1dcca9c5516b77c30e86ee', 'v23'],
    ['training', 'lock_activity_decider', '145ac6b8723af9afddb4c95f450a1ff2', 'v26'],
    ['calendar', 'lock_event_writer', '7ebf1bcf39cbb930fb913d89f25fd406', 'v49'],
    ['training_load', 'source_metric_require_platform_admin', '3dd0005215d31e7fc6f7047aad8ceb2f', 'v34'],
    ['training_load', 'source_metric_require_club_admin', 'da1fb4ba28b807b7ac92e4a86a463af5', 'v34'],
    ['training_load', 'source_metric_actor_basis', '28e53decb03f9fef28c2759bedac93f0', 'v35'],
    ['training_load', 'metric_variable_change_basis', '24c47f23f90bb9c9301397c3aa90db10', 'v38']];
  i int;
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v54) then
    raise exception 'v54 rollback refused: v54 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v54) then
    raise exception 'v54 rollback refused: later migrations are applied';
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2])
       is distinct from expected[i][3] then
      raise exception 'v54 rollback refused: the body in force of %.% is not v54''s', expected[i][1], expected[i][2];
    end if;
  end loop;
end $$;

-- training_load.lock_gpexe_import_approver back to v23's body
create or replace function training_load.lock_gpexe_import_approver(p_user_id uuid, p_team_id uuid)
returns table (basis text, grant_id uuid) as $$
begin
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_user_id and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
   for share of r, u;
  if found then
    return query select 'platform_admin'::text, null::uuid;
    return;
  end if;
  return query
    select 'team_grant'::text, a.id
      from training_load.gpexe_import_approvers a
      join public.user_team_roles tr on tr.user_id = a.user_id and tr.team_id = a.owner_team_id
           and tr.role = 'team_coach' and tr.is_active = true
      join public.users u on u.id = a.user_id and u.is_active = true
     where a.user_id = p_user_id and a.owner_team_id = p_team_id and a.revoked_at is null
     for share of a, tr, u;
  if not found then
    raise exception 'user % may not approve GPEXE imports for team %', p_user_id, p_team_id
      using errcode = 'insufficient_privilege';
  end if;
end;
$$ language plpgsql;

-- training.lock_activity_decider back to v26's body
create or replace function training.lock_activity_decider(p_user_id uuid, p_team_id uuid, p_basis varchar)
returns varchar as $$
declare
  v_club_id uuid;
begin
  if p_basis is null or p_basis not in ('team_coach', 'club_admin', 'platform_admin') then
    raise exception 'lock_activity_decider: unknown basis %', p_basis using errcode = 'invalid_parameter_value';
  end if;
  select club_id into v_club_id from public.teams where id = p_team_id and coalesce(is_active, true) for share;
  if not found then
    raise exception 'user % may not decide on the roster of team %', p_user_id, p_team_id using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.clubs where id = v_club_id and coalesce(is_active, true) for share;
  if not found then
    raise exception 'user % may not decide on the roster of team %: its club is archived', p_user_id, p_team_id using errcode = 'insufficient_privilege';
  end if;
  if p_basis = 'team_coach' then
    perform 1 from public.user_team_roles r join public.users u on u.id = r.user_id
     where r.user_id = p_user_id and r.team_id = p_team_id and r.role = 'team_coach' and r.is_active = true and u.is_active = true
       for share of r, u;
  elsif p_basis = 'club_admin' then
    perform 1 from public.user_club_roles r join public.users u on u.id = r.user_id
     where r.user_id = p_user_id and r.club_id = v_club_id and r.role = 'club_admin' and r.is_active = true and u.is_active = true
       for share of r, u;
  else
    perform 1 from public.user_global_roles r join public.users u on u.id = r.user_id
     where r.user_id = p_user_id and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
       for share of r, u;
  end if;
  if not found then
    raise exception 'user % may not decide on the roster of team % as %', p_user_id, p_team_id, p_basis using errcode = 'insufficient_privilege';
  end if;
  return p_basis;
end;
$$ language plpgsql;

-- calendar.lock_event_writer back to v49's body
create or replace function calendar.lock_event_writer(p_user_id uuid, p_owner_scope varchar, p_owner_id uuid, p_basis varchar)
returns varchar language plpgsql as $$
declare
  v_club_id uuid;
  v_team_active boolean;
  v_club_active boolean;
begin
  if p_basis is null or p_basis not in ('platform_admin', 'club_admin', 'team_coach', 'private_coach') then
    raise exception 'lock_event_writer: unknown basis %', p_basis using errcode = 'invalid_parameter_value';
  end if;
  if p_owner_scope is null or p_owner_scope not in ('club', 'team', 'user') or p_owner_id is null then
    raise exception 'lock_event_writer: unknown owner' using errcode = 'invalid_parameter_value';
  end if;

  -- 1. The owner: the team, then its club; a club; a user. An archived owner
  --    takes writes from the next level up only (plan section 4.1, so its
  --    events can still be cancelled): an archived team never through its
  --    team_coach (its club's admin or the platform admin instead); an
  --    archived club — an archived team's club included — through
  --    platform_admin only.
  if p_owner_scope = 'team' then
    select t.club_id, coalesce(t.is_active, true) into v_club_id, v_team_active from public.teams t where t.id = p_owner_id for share;
    if not found then
      raise exception 'user % may not write the events of an unknown team', p_user_id using errcode = 'insufficient_privilege';
    end if;
    if not v_team_active and p_basis = 'team_coach' then
      raise exception 'user % may not write the events of an archived team as team_coach', p_user_id using errcode = 'insufficient_privilege';
    end if;
  elsif p_owner_scope = 'club' then
    v_club_id := p_owner_id;
  end if;
  if v_club_id is not null then
    select coalesce(c.is_active, true) into v_club_active from public.clubs c where c.id = v_club_id for share;
    if not found then
      raise exception 'user % may not write the events of an unknown club', p_user_id using errcode = 'insufficient_privilege';
    end if;
    if not v_club_active and p_basis <> 'platform_admin' then
      raise exception 'user % may not write the events of an archived club as %', p_user_id, p_basis using errcode = 'insufficient_privilege';
    end if;
  end if;
  if p_owner_scope = 'user' and p_basis <> 'platform_admin' and p_owner_id <> p_user_id then
    raise exception 'user % may not write another coach''s events', p_user_id using errcode = 'insufficient_privilege';
  end if;

  -- 2. The role row of the basis.
  if p_basis = 'platform_admin' then
    perform 1 from public.user_global_roles r
     where r.user_id = p_user_id and r.role = 'platform_admin' and r.is_active = true
       for share;
  elsif p_basis = 'club_admin' then
    if v_club_id is null then
      raise exception 'user % may not write these events as club_admin', p_user_id using errcode = 'insufficient_privilege';
    end if;
    perform 1 from public.user_club_roles r
     where r.user_id = p_user_id and r.club_id = v_club_id and r.role = 'club_admin' and r.is_active = true
       for share;
  elsif p_basis = 'team_coach' then
    if p_owner_scope <> 'team' then
      raise exception 'user % may not write these events as team_coach', p_user_id using errcode = 'insufficient_privilege';
    end if;
    perform 1 from public.user_team_roles r
     where r.user_id = p_user_id and r.team_id = p_owner_id and r.role = 'team_coach' and r.is_active = true
       for share;
  else
    if p_owner_scope <> 'user' then
      raise exception 'user % may not write these events as private_coach', p_user_id using errcode = 'insufficient_privilege';
    end if;
    perform 1 from public.user_global_roles r
     where r.user_id = p_user_id and r.role = 'independent_coach' and r.is_active = true
       for share;
  end if;
  if not found then
    raise exception 'user % may not write the events of this % as %', p_user_id, p_owner_scope, p_basis using errcode = 'insufficient_privilege';
  end if;

  -- 3. The acting user, last.
  perform 1 from public.users u where u.id = p_user_id and u.is_active = true for share;
  if not found then
    raise exception 'user % may not write calendar events', p_user_id using errcode = 'insufficient_privilege';
  end if;
  return p_basis;
end $$;

-- training_load.source_metric_require_platform_admin back to v34's body
create or replace function training_load.source_metric_require_platform_admin(p_user uuid) returns void as $$
begin
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_user and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
     for share of r, u;
  if not found then
    raise exception 'source metric mapping: the acting user is not an active platform admin' using errcode = '42501';
  end if;
end;
$$ language plpgsql;

-- training_load.source_metric_require_club_admin back to v34's body
create or replace function training_load.source_metric_require_club_admin(p_user uuid, p_club uuid) returns void as $$
begin
  perform 1
    from public.user_club_roles r
    join public.users u on u.id = r.user_id
    join public.clubs c on c.id = r.club_id
   where r.user_id = p_user and r.club_id = p_club and r.role = 'club_admin' and r.is_active = true
     and u.is_active = true and coalesce(c.is_active, true)
     for share of r, u, c;
  if not found then
    raise exception 'source metric mapping: the acting user is not an active admin of the mapping''s club' using errcode = '42501';
  end if;
end;
$$ language plpgsql;

-- training_load.source_metric_actor_basis back to v35's body
create or replace function training_load.source_metric_actor_basis(p_actor uuid, p_owner_club uuid) returns text as $$
begin
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_actor and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
     for share of r, u;
  if found then
    if p_owner_club is not null then
      perform 1 from public.clubs where id = p_owner_club and coalesce(is_active, true) for share;
      if not found then
        return null;
      end if;
    end if;
    return 'platform_admin';
  end if;
  if p_owner_club is null then
    return null;
  end if;
  perform 1
    from public.user_club_roles r
    join public.users u on u.id = r.user_id
    join public.clubs c on c.id = r.club_id
   where r.user_id = p_actor and r.club_id = p_owner_club and r.role = 'club_admin' and r.is_active = true
     and u.is_active = true and coalesce(c.is_active, true)
     for share of r, u, c;
  if found then
    return 'club_admin';
  end if;
  return null;
end;
$$ language plpgsql;

-- training_load.metric_variable_change_basis back to v38's body
create or replace function training_load.metric_variable_change_basis(p_actor uuid, p_owner_club uuid, p_team uuid) returns text as $$
begin
  perform 1
    from public.user_global_roles g
    join public.users u on u.id = g.user_id
   where g.user_id = p_actor and g.role = 'platform_admin' and g.is_active = true and u.is_active = true
     for share of g, u;
  if found then
    if p_owner_club is not null then
      perform 1 from public.clubs where id = p_owner_club and coalesce(is_active, true) for share;
      if not found then
        return null;
      end if;
    end if;
    return 'platform_admin';
  end if;
  if p_owner_club is null then
    return null;
  end if;
  perform 1
    from public.user_club_roles r
    join public.users u on u.id = r.user_id
    join public.clubs c on c.id = r.club_id
   where r.user_id = p_actor and r.club_id = p_owner_club and r.role = 'club_admin' and r.is_active = true
     and u.is_active = true and coalesce(c.is_active, true)
     for share of r, u, c;
  if found then
    return 'club_admin';
  end if;
  if p_team is null then
    return null;
  end if;
  perform 1 from public.teams where id = p_team and club_id = p_owner_club and coalesce(is_active, true) for share;
  if not found then
    return null;
  end if;
  perform 1 from public.clubs where id = p_owner_club and coalesce(is_active, true) for share;
  if not found then
    return null;
  end if;
  perform 1
    from public.user_team_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_actor and r.team_id = p_team and r.role = 'team_coach' and r.is_active = true and u.is_active = true
     for share of r, u;
  if found then
    return 'team_coach';
  end if;
  return null;
end;
$$ language plpgsql;

do $$
declare
  expected constant text[][] := array[
    ['training_load', 'lock_gpexe_import_approver', 'be924aae7de75db74b6cbff0658e2835', 'v23'],
    ['training', 'lock_activity_decider', 'e8b36405f0e2fe3d66a5973fdfc1c0d0', 'v26'],
    ['calendar', 'lock_event_writer', 'ad2250f6f9f04cecde96bed29a211a79', 'v49'],
    ['training_load', 'source_metric_require_platform_admin', 'fa0e002b3f1961f1e06b54c8f0b10bd3', 'v34'],
    ['training_load', 'source_metric_require_club_admin', '97e576a08323d5b2d6e11d9cdedf05cc', 'v34'],
    ['training_load', 'source_metric_actor_basis', 'bff4852216ffda968b33b730cd05da47', 'v35'],
    ['training_load', 'metric_variable_change_basis', '4ff0503a658dde888966e27065c430de', 'v38']];
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2])
       is distinct from expected[i][3] then
      raise exception 'v54 rollback failed: the body of %.% is not %''s after the restore', expected[i][1], expected[i][2], expected[i][4];
    end if;
  end loop;
end $$;

delete from public.schema_migrations where migration_name = 'migrations_v2/202611041100_training_load_v54_rights_locks_users_first.sql';
commit;

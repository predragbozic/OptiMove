-- v54: the database's own rights locks take the users row first (LO-2, the
-- Rukovodilac's L0 (a), 2026-11-03; scope confirmed at LO-1's GO, decision 3).
--
-- Why: the revocations (backend/src/routes/organization.js) lock `users`, then
-- the role row (`for update of u, r` / `u, g`). Seven database functions locked
-- the role row first, or the users row last, so a revocation of the same user
-- could meet them in the opposite order and end in a deadlock (40P01, nothing
-- written). LO-1 turned the services users-first; this turns the functions.
--
-- What it changes: seven function bodies, CREATE OR REPLACE, nothing else - no
-- table, column, trigger, index or row. Signatures, return values, exceptions
-- and their error codes are unchanged. In each body the acting user's row is
-- locked FOR SHARE in a statement of its own ahead of the role row(s), and the
-- role queries keep the same active-user condition (a join on users), so an
-- inactive or unknown user reaches the same outcome as before. The one
-- difference in locking: the users row is now share-locked also when the role
-- row does not exist (it conflicts only with an exclusive write of that user).
--   * v23 training_load.lock_gpexe_import_approver   (first rights lock of an approval)
--   * v26 training.lock_activity_decider             (first rights lock of a roster decision)
--   * v49 calendar.lock_event_writer                 (first rights lock of a calendar write; users was LAST)
--   * v34 training_load.source_metric_require_platform_admin, ..._require_club_admin
--   * v35 training_load.source_metric_actor_basis
--   * v38 training_load.metric_variable_change_basis
--
-- Before anything changes it checks that each body in force is the one it
-- replaces (md5 of pg_proc.prosrc); after, that each body is the new one.
-- Rollback: docs/runbooks/rights-locks-users-first-v54-rollback.sql.

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
      raise exception 'v54 refused: the body in force of %.% is not %''s', expected[i][1], expected[i][2], expected[i][4] using errcode = '23514';
    end if;
  end loop;
end;
$$;

-- training_load.lock_gpexe_import_approver (v23)
create or replace function training_load.lock_gpexe_import_approver(p_user_id uuid, p_team_id uuid)
returns table (basis text, grant_id uuid) as $$
begin
  -- LO-2: the acting user first, then the role rows (the order of the revocations).
  perform 1 from public.users u where u.id = p_user_id and u.is_active = true for share;
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_user_id and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
   for share of r;
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
     for share of a, tr;
  if not found then
    raise exception 'user % may not approve GPEXE imports for team %', p_user_id, p_team_id
      using errcode = 'insufficient_privilege';
  end if;
end;
$$ language plpgsql;

-- training.lock_activity_decider (v26)
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
  -- LO-2: the acting user first, then the role row (the order of the revocations).
  perform 1 from public.users u where u.id = p_user_id and u.is_active = true for share;
  if p_basis = 'team_coach' then
    perform 1 from public.user_team_roles r join public.users u on u.id = r.user_id
     where r.user_id = p_user_id and r.team_id = p_team_id and r.role = 'team_coach' and r.is_active = true and u.is_active = true
       for share of r;
  elsif p_basis = 'club_admin' then
    perform 1 from public.user_club_roles r join public.users u on u.id = r.user_id
     where r.user_id = p_user_id and r.club_id = v_club_id and r.role = 'club_admin' and r.is_active = true and u.is_active = true
       for share of r;
  else
    perform 1 from public.user_global_roles r join public.users u on u.id = r.user_id
     where r.user_id = p_user_id and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
       for share of r;
  end if;
  if not found then
    raise exception 'user % may not decide on the roster of team % as %', p_user_id, p_team_id, p_basis using errcode = 'insufficient_privilege';
  end if;
  return p_basis;
end;
$$ language plpgsql;

-- calendar.lock_event_writer (v49)
create or replace function calendar.lock_event_writer(p_user_id uuid, p_owner_scope varchar, p_owner_id uuid, p_basis varchar)
returns varchar language plpgsql as $$
declare
  v_club_id uuid;
  v_team_active boolean;
  v_club_active boolean;
  v_user_ok boolean;
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

  -- 2. The acting user (LO-2: before the role row, the order of the revocations;
  --    an inactive or unknown user is refused after the role row, as before),
  --    then the role row of the basis.
  perform 1 from public.users u where u.id = p_user_id and u.is_active = true for share;
  v_user_ok := found;
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

  -- 3. The acting user was locked in step 2.
  if not v_user_ok then
    raise exception 'user % may not write calendar events', p_user_id using errcode = 'insufficient_privilege';
  end if;
  return p_basis;
end $$;

-- training_load.source_metric_require_platform_admin (v34)
create or replace function training_load.source_metric_require_platform_admin(p_user uuid) returns void as $$
begin
  perform 1 from public.users u where u.id = p_user and u.is_active = true for share;
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_user and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
     for share of r;
  if not found then
    raise exception 'source metric mapping: the acting user is not an active platform admin' using errcode = '42501';
  end if;
end;
$$ language plpgsql;

-- training_load.source_metric_require_club_admin (v34)
create or replace function training_load.source_metric_require_club_admin(p_user uuid, p_club uuid) returns void as $$
begin
  perform 1 from public.users u where u.id = p_user and u.is_active = true for share;
  perform 1
    from public.user_club_roles r
    join public.users u on u.id = r.user_id
    join public.clubs c on c.id = r.club_id
   where r.user_id = p_user and r.club_id = p_club and r.role = 'club_admin' and r.is_active = true
     and u.is_active = true and coalesce(c.is_active, true)
     for share of r, c;
  if not found then
    raise exception 'source metric mapping: the acting user is not an active admin of the mapping''s club' using errcode = '42501';
  end if;
end;
$$ language plpgsql;

-- training_load.source_metric_actor_basis (v35)
create or replace function training_load.source_metric_actor_basis(p_actor uuid, p_owner_club uuid) returns text as $$
begin
  perform 1 from public.users u where u.id = p_actor and u.is_active = true for share;
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_actor and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
     for share of r;
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
     for share of r, c;
  if found then
    return 'club_admin';
  end if;
  return null;
end;
$$ language plpgsql;

-- training_load.metric_variable_change_basis (v38)
create or replace function training_load.metric_variable_change_basis(p_actor uuid, p_owner_club uuid, p_team uuid) returns text as $$
begin
  perform 1 from public.users u where u.id = p_actor and u.is_active = true for share;
  perform 1
    from public.user_global_roles g
    join public.users u on u.id = g.user_id
   where g.user_id = p_actor and g.role = 'platform_admin' and g.is_active = true and u.is_active = true
     for share of g;
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
     for share of r, c;
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
     for share of r;
  if found then
    return 'team_coach';
  end if;
  return null;
end;
$$ language plpgsql;

do $$
declare
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
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2])
       is distinct from expected[i][3] then
      raise exception 'v54 failed: the body of %.% is not the one v54 writes', expected[i][1], expected[i][2] using errcode = '23514';
    end if;
  end loop;
end;
$$;

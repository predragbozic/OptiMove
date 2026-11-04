-- v56: the import switch per team, the recorded prerequisites, and who may approve
-- (J19 part U2; docs/ai/u2-per-team-import-switch-plan.md, the Rukovodilac's GO of 2026-11-04).
--
-- What it adds
--   * training_load.gpexe_team_import_switch          one row per team: enabled, mode ('pilot' | 'team'), who, when, why.
--   * training_load.gpexe_team_import_switch_history  append-only: every change with the basis (platform_admin / club_admin).
--   * training_load.gpexe_import_prerequisite_records append-only: the dates an administrator records (a backup, a restore
--     probe, and, for team mode, two attestations).
--   * training_load.set_team_import_switch(...)       the only writer of the switch; reads the conditions INSIDE the database.
--   * training_load.record_import_prerequisite(...)   the only writer of the records; platform admin only.
--   * lock_gpexe_import_approver (v23, rewritten by v54) now also derives the bases 'club_admin' and 'team_coach' and
--     refuses an approval while the team's switch is off (or, for those two bases, while the mode is 'pilot'). The switch
--     row is read FOR SHARE inside the approval transaction, after the role rows: a switch turned off is waited for, and an
--     approval that began before it can no longer pass once it has committed.
--   * gpexe_import_approvals.approval_basis accepts 'club_admin' and 'team_coach'.
--
-- Lock order (users first, the revocations' order - v54): the acting user's row, then the role rows, then the switch row.
-- The approver function takes NO team or club row lock (a team move holds the team import lock and then the team row; an
-- early team row share lock here would close a cycle with the approval's import lock): the team's club is a plain read,
-- and the route's R16 check (team and club FOR SHARE after the import lock) stays the authority for archive and move.
--
-- Known limit, stated: the write guards on the three tables prove that a row comes from the sanctioned function in the
-- same transaction. They are not a defence against whoever controls the database credentials (the v35 limit).
--
-- Before anything changes it checks that the body in force of lock_gpexe_import_approver is v54's (md5 of prosrc);
-- after, that it is this migration's. Rollback: docs/runbooks/team-import-switch-v56-rollback.sql.

do $$
begin
  if (select md5(p.prosrc)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'lock_gpexe_import_approver')
     is distinct from '9c3bf3edeb1dcca9c5516b77c30e86ee' then
    raise exception 'v56 refused: the body in force of training_load.lock_gpexe_import_approver is not v54''s' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table training_load.gpexe_team_import_switch (
  owner_team_id uuid primary key references public.teams(id) on delete restrict,
  enabled boolean not null,
  mode varchar(8) not null check (mode in ('pilot', 'team')),
  changed_by_user_id uuid not null references public.users(id) on delete restrict,
  changed_at timestamptz not null default now(),
  change_reason text not null check (length(btrim(change_reason)) between 1 and 500)
);

create table training_load.gpexe_team_import_switch_history (
  id uuid primary key default gen_random_uuid(),
  owner_team_id uuid not null references public.teams(id) on delete restrict,
  enabled boolean not null,
  mode varchar(8) not null check (mode in ('pilot', 'team')),
  changed_by_user_id uuid not null references public.users(id) on delete restrict,
  basis varchar(20) not null check (basis in ('platform_admin', 'club_admin')),
  changed_at timestamptz not null default now(),
  change_reason text not null check (length(btrim(change_reason)) between 1 and 500)
);
create index gpexe_team_import_switch_history_team_idx on training_load.gpexe_team_import_switch_history (owner_team_id, changed_at desc);
create index gpexe_team_import_switch_history_by_idx on training_load.gpexe_team_import_switch_history (changed_by_user_id);
create index gpexe_team_import_switch_by_idx on training_load.gpexe_team_import_switch (changed_by_user_id);

create table training_load.gpexe_import_prerequisite_records (
  id uuid primary key default gen_random_uuid(),
  kind varchar(30) not null check (kind in ('backup', 'restore_probe', 'wrong_link_procedure', 'archived_team_check_stop')),
  recorded_on date not null,
  recorded_by_user_id uuid not null references public.users(id) on delete restrict,
  note varchar(300),
  recorded_at timestamptz not null default now()
);
create index gpexe_import_prerequisite_records_kind_idx on training_load.gpexe_import_prerequisite_records (kind, recorded_on desc);
create index gpexe_import_prerequisite_records_by_idx on training_load.gpexe_import_prerequisite_records (recorded_by_user_id);

-- ---------------------------------------------------------------------------
-- Write guards
-- ---------------------------------------------------------------------------

-- A row of the switch or of the history is written only inside set_team_import_switch (and a record only inside
-- record_import_prerequisite): the function sets a transaction-local marker the guard compares with this transaction.
create function training_load.team_import_write_guard() returns trigger as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception '% is never deleted (% refused)', tg_table_name, tg_op using errcode = '23514';
  end if;
  if tg_table_name <> 'gpexe_team_import_switch' and tg_op = 'UPDATE' then
    raise exception '% is append-only (% refused)', tg_table_name, tg_op using errcode = '23514';
  end if;
  if current_setting('optimove.team_import_tx', true) is distinct from txid_current()::text then
    raise exception '% is written only by its sanctioned function', tg_table_name using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_team_import_switch_guard before insert or update or delete on training_load.gpexe_team_import_switch
  for each row execute function training_load.team_import_write_guard();
create trigger gpexe_team_import_switch_no_truncate before truncate on training_load.gpexe_team_import_switch
  for each statement execute function training_load.team_import_write_guard();
create trigger gpexe_team_import_switch_history_guard before insert or update or delete on training_load.gpexe_team_import_switch_history
  for each row execute function training_load.team_import_write_guard();
create trigger gpexe_team_import_switch_history_no_truncate before truncate on training_load.gpexe_team_import_switch_history
  for each statement execute function training_load.team_import_write_guard();
create trigger gpexe_import_prerequisite_records_guard before insert or update or delete on training_load.gpexe_import_prerequisite_records
  for each row execute function training_load.team_import_write_guard();
create trigger gpexe_import_prerequisite_records_no_truncate before truncate on training_load.gpexe_import_prerequisite_records
  for each statement execute function training_load.team_import_write_guard();

-- ---------------------------------------------------------------------------
-- The sanctioned writers
-- ---------------------------------------------------------------------------

-- The acting user's right to switch a team's import: an active platform admin, or the active admin of the team's club.
-- The users row first, then the role row, each FOR SHARE in a statement of its own (the revocations' order).
create function training_load.team_import_actor_basis(p_actor uuid, p_team uuid) returns text as $$
declare
  v_club uuid;
begin
  perform 1 from public.users u where u.id = p_actor and u.is_active = true for share;
  if not found then
    raise exception 'user % may not switch imports for team %', p_actor, p_team using errcode = '42501';
  end if;
  perform 1 from public.user_global_roles r where r.user_id = p_actor and r.role = 'platform_admin' and r.is_active = true for share;
  if found then
    return 'platform_admin';
  end if;
  select t.club_id into v_club from public.teams t where t.id = p_team;
  perform 1 from public.user_club_roles cr
   where cr.user_id = p_actor and cr.club_id = v_club and cr.role = 'club_admin' and cr.is_active = true for share;
  if found then
    return 'club_admin';
  end if;
  raise exception 'user % may not switch imports for team %', p_actor, p_team using errcode = '42501';
end;
$$ language plpgsql;

create function training_load.set_team_import_switch(p_actor uuid, p_team uuid, p_enabled boolean, p_mode text, p_reason text)
returns table (enabled boolean, mode text, changed_at timestamptz) as $$
declare
  v_basis text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_cur record;
  v_mode text;
  v_prev_mode text;
begin
  if p_enabled is null or (p_mode is not null and p_mode not in ('pilot', 'team')) then
    raise exception 'set_team_import_switch: enabled and mode must be valid' using errcode = '22023';
  end if;
  if length(v_reason) not between 1 and 500 or v_reason ~ '[[:cntrl:]]' then
    raise exception 'set_team_import_switch: the reason is required (1-500 characters, no control characters)' using errcode = '22023';
  end if;
  v_basis := training_load.team_import_actor_basis(p_actor, p_team);
  -- The team and its club, active, FOR SHARE (this function takes no import lock, so the early team row lock closes no cycle).
  perform 1 from public.teams t where t.id = p_team and coalesce(t.is_active, true) for share;
  if not found then
    raise exception 'team % is not available', p_team using errcode = '42501';
  end if;
  perform 1 from public.teams t join public.clubs c on c.id = t.club_id where t.id = p_team and coalesce(c.is_active, true) for share of c;
  if not found then
    raise exception 'team % is not available', p_team using errcode = '42501';
  end if;
  select s.owner_team_id, s.enabled as is_on, s.mode as cur_mode into v_cur
    from training_load.gpexe_team_import_switch s where s.owner_team_id = p_team for update;
  v_prev_mode := coalesce(v_cur.cur_mode, 'pilot');
  v_mode := coalesce(p_mode, v_prev_mode);
  if v_basis = 'club_admin' then
    -- A club admin does not move a team between modes (the end of the pilot is a platform admin's act) and turns a team on
    -- only once the pilot is over for it.
    if v_mode <> v_prev_mode then
      raise exception 'team_import_mode_platform_admin_only' using errcode = '42501';
    end if;
    if p_enabled and (v_cur.owner_team_id is null or v_cur.cur_mode <> 'team') then
      raise exception 'team_import_pilot_platform_admin_only' using errcode = '42501';
    end if;
  end if;
  if p_enabled then
    -- The conditions, read here, inside the database, at this moment.
    if not exists (select 1 from training_load.gpexe_import_prerequisite_records r
                    where r.kind = 'backup' and r.recorded_on between current_date - 2 and current_date) then
      raise exception 'team_import_condition:backup' using errcode = '55000';
    end if;
    if not exists (select 1 from training_load.gpexe_import_prerequisite_records r
                    where r.kind = 'restore_probe' and r.recorded_on between current_date - 35 and current_date) then
      raise exception 'team_import_condition:restore_probe' using errcode = '55000';
    end if;
    if v_mode = 'team' then
      if not exists (select 1 from training_load.gpexe_import_prerequisite_records r where r.kind = 'wrong_link_procedure') then
        raise exception 'team_import_condition:wrong_link_procedure' using errcode = '55000';
      end if;
      if not exists (select 1 from training_load.gpexe_import_prerequisite_records r where r.kind = 'archived_team_check_stop') then
        raise exception 'team_import_condition:archived_team_check_stop' using errcode = '55000';
      end if;
    end if;
  end if;
  perform set_config('optimove.team_import_tx', txid_current()::text, true);
  insert into training_load.gpexe_team_import_switch as s (owner_team_id, enabled, mode, changed_by_user_id, changed_at, change_reason)
    values (p_team, p_enabled, v_mode, p_actor, clock_timestamp(), v_reason)
  on conflict (owner_team_id) do update
    set enabled = excluded.enabled, mode = excluded.mode, changed_by_user_id = excluded.changed_by_user_id,
        changed_at = excluded.changed_at, change_reason = excluded.change_reason;
  insert into training_load.gpexe_team_import_switch_history (owner_team_id, enabled, mode, changed_by_user_id, basis, changed_at, change_reason)
    values (p_team, p_enabled, v_mode, p_actor, v_basis, clock_timestamp(), v_reason);
  return query select s2.enabled, s2.mode::text, s2.changed_at from training_load.gpexe_team_import_switch s2 where s2.owner_team_id = p_team;
end;
$$ language plpgsql;

create function training_load.record_import_prerequisite(p_actor uuid, p_kind text, p_recorded_on date, p_note text)
returns uuid as $$
declare
  v_id uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_kind is null or p_kind not in ('backup', 'restore_probe', 'wrong_link_procedure', 'archived_team_check_stop') then
    raise exception 'record_import_prerequisite: unknown kind' using errcode = '22023';
  end if;
  if p_recorded_on is null or p_recorded_on > current_date or p_recorded_on < current_date - 400 then
    raise exception 'record_import_prerequisite: the date must be today or in the past (at most 400 days)' using errcode = '22023';
  end if;
  if v_note is not null and (length(v_note) > 300 or v_note ~ '[[:cntrl:]]') then
    raise exception 'record_import_prerequisite: the note is at most 300 characters without control characters' using errcode = '22023';
  end if;
  perform 1 from public.users u where u.id = p_actor and u.is_active = true for share;
  if not found then
    raise exception 'user % may not record import prerequisites', p_actor using errcode = '42501';
  end if;
  perform 1 from public.user_global_roles r where r.user_id = p_actor and r.role = 'platform_admin' and r.is_active = true for share;
  if not found then
    raise exception 'user % may not record import prerequisites', p_actor using errcode = '42501';
  end if;
  perform set_config('optimove.team_import_tx', txid_current()::text, true);
  insert into training_load.gpexe_import_prerequisite_records (kind, recorded_on, recorded_by_user_id, note)
    values (p_kind, p_recorded_on, p_actor, v_note) returning id into v_id;
  return v_id;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- Who may approve (v23, rewritten by v54): bases and the switch
-- ---------------------------------------------------------------------------

alter table training_load.gpexe_import_approvals drop constraint gpexe_import_approvals_approval_basis_check;
alter table training_load.gpexe_import_approvals add constraint gpexe_import_approvals_approval_basis_check
  check (approval_basis in ('platform_admin', 'team_grant', 'club_admin', 'team_coach'));

create or replace function training_load.lock_gpexe_import_approver(p_user_id uuid, p_team_id uuid)
returns table (basis text, grant_id uuid) as $$
declare
  v_basis text;
  v_grant uuid;
  v_club uuid;
  v_sw record;
  v_peek text;
begin
  -- The acting user first, then the role rows (the order of the revocations); the switch row last.
  perform 1 from public.users u where u.id = p_user_id and u.is_active = true for share;
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_user_id and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
   for share of r;
  if found then
    v_basis := 'platform_admin';
  end if;
  if v_basis is null then
    select a.id into v_grant
      from training_load.gpexe_import_approvers a
      join public.user_team_roles tr on tr.user_id = a.user_id and tr.team_id = a.owner_team_id
           and tr.role = 'team_coach' and tr.is_active = true
      join public.users u on u.id = a.user_id and u.is_active = true
     where a.user_id = p_user_id and a.owner_team_id = p_team_id and a.revoked_at is null
     for share of a, tr;
    if found then
      v_basis := 'team_grant';
    end if;
  end if;
  -- club_admin / team_coach count as a right only while the team is in mode 'team'. The mode is peeked here WITHOUT a lock
  -- (the switch row is locked last, below, and the mode is decided again there); in pilot mode these two are no right at
  -- all, so a person who holds nothing else gets the plain insufficient_privilege.
  select s.mode into v_peek from training_load.gpexe_team_import_switch s where s.owner_team_id = p_team_id;
  if v_basis is null and v_peek = 'team' then
    select t.club_id into v_club from public.teams t where t.id = p_team_id;
    perform 1
      from public.user_club_roles cr
      join public.users u on u.id = cr.user_id and u.is_active = true
     where cr.user_id = p_user_id and cr.club_id = v_club and cr.role = 'club_admin' and cr.is_active = true
     for share of cr;
    if found then
      v_basis := 'club_admin';
    end if;
  end if;
  if v_basis is null and v_peek = 'team' then
    perform 1
      from public.user_team_roles tr
      join public.users u on u.id = tr.user_id and u.is_active = true
     where tr.user_id = p_user_id and tr.team_id = p_team_id and tr.role = 'team_coach' and tr.is_active = true
     for share of tr;
    if found then
      v_basis := 'team_coach';
    end if;
  end if;
  if v_basis is null then
    raise exception 'user % may not approve GPEXE imports for team %', p_user_id, p_team_id
      using errcode = 'insufficient_privilege';
  end if;
  -- The team's switch, FOR SHARE for the rest of the approval transaction: a writer of the switch waits for this approval,
  -- and an approval that arrives after a committed "off" is refused here.
  select s.enabled as is_on, s.mode as sw_mode into v_sw
    from training_load.gpexe_team_import_switch s where s.owner_team_id = p_team_id for share;
  if not found or v_sw.is_on is not true then
    raise exception 'team_import_switch_off' using errcode = '55000';
  end if;
  if v_basis in ('club_admin', 'team_coach') and v_sw.sw_mode <> 'team' then
    raise exception 'team_import_pilot_mode' using errcode = '55000';
  end if;
  return query select v_basis, v_grant;
end;
$$ language plpgsql;

-- Post-gate: the body in force is this migration's (md5 recorded in the post-check).
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'training_load' and p.proname = 'lock_gpexe_import_approver'
                    and p.prosrc like '%team_import_switch_off%') then
    raise exception 'v56 refused: lock_gpexe_import_approver is not the new body' using errcode = '23514';
  end if;
end;
$$;

-- Calendar M-1: rights checked under lock, coexistence with the previous build until activation.
set local lock_timeout = '5s';

do $$ begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('calendar.lock_event_writer(uuid,character varying,uuid,character varying)')) is distinct from '7ebf1bcf39cbb930fb913d89f25fd406' then
    raise exception 'v98 expects calendar.lock_event_writer(uuid,character varying,uuid,character varying) to have its approved body';
  end if;
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('calendar.delete_event(uuid,integer,uuid,character varying,uuid,text,jsonb)')) is distinct from '9ec5c97afeca674dc772f5f8503e21f7' then
    raise exception 'v98 expects calendar.delete_event(uuid,integer,uuid,character varying,uuid,text,jsonb) to have its approved body';
  end if;
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('calendar.event_deletion_log_before_insert()')) is distinct from 'a5c35d8e6f860d02af596ce0fa9f949c' then
    raise exception 'v98 expects calendar.event_deletion_log_before_insert() to have its approved body';
  end if;
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.permission_word_honoured(text)')) is distinct from '0c47ce1a6b157c1c9205d4f48438a5ac' then
    raise exception 'v98 expects public.permission_word_honoured(text) to have its approved body';
  end if;
end $$;

-- Both builds take this shared lock before any resource row. Activation takes
-- its exclusive companion and waits for old writers without locking event rows.
create table calendar.m1_activation (
  singleton boolean primary key default true check (singleton),
  active boolean not null default false,
  first_checked_write_at timestamptz
);
insert into calendar.m1_activation (singleton) values (true);
alter table calendar.m1_activation enable row level security;
revoke all on calendar.m1_activation from public;

create function calendar.require_m1_cutover(p_checked boolean) returns void
language plpgsql set search_path = pg_catalog, public, calendar as $$
declare
  v_active boolean;
begin
  perform pg_advisory_xact_lock_shared(11816506, 1);
  select active into strict v_active from calendar.m1_activation where singleton;
  if p_checked is distinct from true and v_active then
    raise exception 'Calendar legacy write path is closed' using errcode = '42501';
  end if;
end $$;

create function calendar.record_m1_write() returns void
language sql set search_path = pg_catalog, public, calendar as $$
  update calendar.m1_activation set first_checked_write_at = clock_timestamp()
   where singleton and first_checked_write_at is null
$$;

alter table calendar.event_deletion_log
  add column writer_workspace_type varchar,
  add column writer_workspace_id uuid,
  add constraint calendar_m1_delete_workspace check (
    (writer_workspace_type is null and writer_workspace_id is null)
    or (writer_workspace_type is not null and (
      (writer_workspace_type in ('club', 'team') and writer_workspace_id is not null)
      or (writer_workspace_type in ('platform', 'private_coach') and writer_workspace_id is null)))
  );


create function calendar.lock_event_writer_basis(p_user_id uuid, p_owner_scope varchar, p_owner_id uuid, p_basis varchar)
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

create or replace function calendar.lock_event_writer(p_user_id uuid, p_owner_scope varchar, p_owner_id uuid, p_basis varchar)
returns varchar language plpgsql set search_path = pg_catalog, public, calendar as $$
begin
  perform calendar.require_m1_cutover(false);
  return calendar.lock_event_writer_basis(p_user_id, p_owner_scope, p_owner_id, p_basis);
end $$;

-- The fixed word is chosen by its caller in a separate entry point. This
-- helper only locks owners, before the existing users-first rights sequence.
create function calendar.lock_m1_owner(p_owner_scope varchar, p_owner_id uuid)
returns uuid language plpgsql set search_path = pg_catalog, public, calendar as $$
declare
  v_club uuid;
  v_locked_club uuid;
begin
  if p_owner_scope = 'team' then
    select club_id into v_club from public.teams where id = p_owner_id;
    if not found then
      raise exception 'Calendar owner is unavailable' using errcode = '42501';
    end if;
  elsif p_owner_scope = 'club' then
    v_club := p_owner_id;
  elsif p_owner_scope is distinct from 'user' then
    raise exception 'Calendar owner is unavailable' using errcode = '42501';
  end if;
  if v_club is not null then
    perform public.lock_club_ceiling(array[v_club], 'shared');
  end if;
  if p_owner_scope = 'team' then
    select club_id into v_locked_club from public.teams where id = p_owner_id for share;
    if not found or v_locked_club is distinct from v_club then
      raise exception 'Calendar owner is unavailable' using errcode = '42501';
    end if;
  end if;
  if v_club is not null then
    perform 1 from public.clubs where id = v_club for share;
    if not found then
      raise exception 'Calendar owner is unavailable' using errcode = '42501';
    end if;
  end if;
  return v_club;
end $$;

create function calendar.lock_event_writer_checked(p_user_id uuid, p_owner_scope varchar, p_owner_id uuid, p_basis varchar,
                                                    p_workspace_type varchar, p_workspace_id uuid)
returns varchar language plpgsql set search_path = pg_catalog, public, calendar as $$
declare
  v_club uuid;
begin
  perform calendar.require_m1_cutover(true);
  v_club := calendar.lock_m1_owner(p_owner_scope, p_owner_id);
  if p_workspace_type = 'club' and p_workspace_id is not null and v_club = p_workspace_id
     and p_basis in ('club_admin','platform_admin') then
    perform public.lock_permission_actor(p_user_id, 'club', p_workspace_id);
    if not exists (select 1 from public.user_club_roles r where r.user_id=p_user_id and r.club_id=p_workspace_id
                   and r.role='club_admin' and r.is_active)
       or not public.user_has_permission(p_user_id, 'calendar.view', 'club', p_workspace_id)
       or not public.user_has_permission(p_user_id, 'calendar.events.manage', 'club', p_workspace_id) then
      raise exception 'Calendar write permission is unavailable' using errcode = '42501';
    end if;
  elsif p_workspace_type = 'team' and p_owner_scope = 'team' and p_workspace_id = p_owner_id
     and p_basis in ('club_admin','team_coach','platform_admin') then
    perform public.lock_permission_actor(p_user_id, 'team', p_workspace_id);
    if not exists (select 1 from public.user_team_roles r where r.user_id=p_user_id and r.team_id=p_workspace_id
                   and r.role='team_coach' and r.is_active)
       or not public.user_has_permission(p_user_id, 'calendar.view', 'team', p_workspace_id)
       or not public.user_has_permission(p_user_id, 'calendar.events.manage', 'team', p_workspace_id) then
      raise exception 'Calendar write permission is unavailable' using errcode = '42501';
    end if;
  elsif p_workspace_type = 'platform' and p_workspace_id is null and p_basis = 'platform_admin' then
    null;
  elsif p_workspace_type = 'private_coach' and p_workspace_id is null and p_owner_scope = 'user'
     and p_owner_id = p_user_id and p_basis = 'private_coach' then
    null;
  else
    raise exception 'Calendar write permission is unavailable' using errcode = '42501';
  end if;
  return calendar.lock_event_writer_basis(p_user_id, p_owner_scope, p_owner_id, p_basis);
end $$;

create function calendar.lock_settings_writer_checked(p_user_id uuid, p_club_id uuid, p_team_id uuid)
returns varchar language plpgsql set search_path = pg_catalog, public, calendar as $$
declare
  v_scope varchar := case when p_team_id is null then 'club' else 'team' end;
  v_owner uuid := coalesce(p_team_id, p_club_id);
  v_club uuid;
begin
  perform calendar.require_m1_cutover(true);
  v_club := calendar.lock_m1_owner(v_scope, v_owner);
  if p_club_id is null or v_club is distinct from p_club_id then
    raise exception 'Calendar settings permission is unavailable' using errcode = '42501';
  end if;
  perform public.lock_permission_actor(p_user_id, 'club', p_club_id);
  if not public.user_has_permission(p_user_id, 'calendar.view', 'club', p_club_id)
     or not public.user_has_permission(p_user_id, 'calendar.settings.manage', 'club', p_club_id) then
    raise exception 'Calendar settings permission is unavailable' using errcode = '42501';
  end if;
  return calendar.lock_event_writer_basis(p_user_id, v_scope, v_owner, 'club_admin');
end $$;

create function calendar.lock_questions_switch_checked(p_user_id uuid, p_club_id uuid)
returns varchar language plpgsql set search_path = pg_catalog, public, calendar as $$
begin
  perform calendar.require_m1_cutover(true);
  perform calendar.lock_m1_owner('club', p_club_id);
  return calendar.lock_event_writer_basis(p_user_id, 'club', p_club_id, 'platform_admin');
end $$;


create or replace function calendar.delete_event(p_event_id uuid, p_expected_revision integer, p_user_id uuid, p_basis varchar,
                                      p_request_key uuid, p_request_hash text, p_result jsonb)
returns uuid language plpgsql as $$
declare
  v_event record;
  v_owner record;
  v_log_id uuid;
begin
  perform calendar.require_m1_cutover(false);
  -- Rights first, then the event (as the log row's guard and every event command).
  select e.owner_scope, coalesce(e.owner_club_id, e.owner_team_id, e.owner_user_id) as owner_id into v_owner
    from calendar.events e where e.id = p_event_id;
  if not found then
    raise exception 'calendar.delete_event: no such event' using errcode = '23514', constraint = 'event_delete_no_event';
  end if;
  perform calendar.lock_event_writer(p_user_id, v_owner.owner_scope, v_owner.owner_id, p_basis);
  select e.*, et.kind as type_kind into v_event
    from calendar.events e join calendar.event_types et on et.id = e.event_type_id
   where e.id = p_event_id
     for update of e;
  if not found then
    raise exception 'calendar.delete_event: no such event' using errcode = '23514', constraint = 'event_delete_no_event';
  end if;
  if v_event.revision is distinct from p_expected_revision then
    raise exception 'calendar.delete_event: the event was changed meanwhile' using errcode = '23514', constraint = 'event_delete_revision';
  end if;
  insert into calendar.event_deletion_log (request_key, request_hash, performed_by_user_id, basis, event_id, owner_scope,
      owner_user_id, owner_club_id, owner_team_id, event_kind, title, day, end_day, event_status, event_revision, result)
    values (p_request_key, p_request_hash, p_user_id, p_basis, v_event.id, v_event.owner_scope,
      v_event.owner_user_id, v_event.owner_club_id, v_event.owner_team_id, v_event.type_kind, v_event.title, v_event.day,
      v_event.end_day, v_event.status, v_event.revision, p_result)
    returning id into v_log_id;
  -- The event's request keys stay spent; then its own rows: the change log before the request records it names.
  insert into calendar.event_deleted_request_keys (performed_by_user_id, request_key, request_hash, operation, event_id)
    select r.performed_by_user_id, r.request_key, r.request_hash, r.operation, r.event_id
      from calendar.event_requests r where r.event_id = p_event_id;
  delete from calendar.event_changes where event_id = p_event_id;
  delete from calendar.event_requests where event_id = p_event_id;
  delete from calendar.event_selected_fields where event_id = p_event_id;
  delete from calendar.event_targets where event_id = p_event_id;
  delete from calendar.events where id = p_event_id;
  return v_log_id;
end $$;

create function calendar.delete_event_checked(p_event_id uuid, p_expected_revision integer, p_user_id uuid, p_basis varchar,
                                      p_request_key uuid, p_request_hash text, p_result jsonb, p_workspace_type varchar, p_workspace_id uuid)
returns uuid language plpgsql as $$
declare
  v_event record;
  v_owner record;
  v_log_id uuid;
begin
  -- Rights first, then the event (as the log row's guard and every event command).
  select e.owner_scope, coalesce(e.owner_club_id, e.owner_team_id, e.owner_user_id) as owner_id into v_owner
    from calendar.events e where e.id = p_event_id;
  if not found then
    raise exception 'calendar.delete_event: no such event' using errcode = '23514', constraint = 'event_delete_no_event';
  end if;
  perform calendar.lock_event_writer_checked(p_user_id, v_owner.owner_scope, v_owner.owner_id, p_basis, p_workspace_type, p_workspace_id);
  select e.*, et.kind as type_kind into v_event
    from calendar.events e join calendar.event_types et on et.id = e.event_type_id
   where e.id = p_event_id
     for update of e;
  if not found then
    raise exception 'calendar.delete_event: no such event' using errcode = '23514', constraint = 'event_delete_no_event';
  end if;
  if v_event.revision is distinct from p_expected_revision then
    raise exception 'calendar.delete_event: the event was changed meanwhile' using errcode = '23514', constraint = 'event_delete_revision';
  end if;
  insert into calendar.event_deletion_log (request_key, request_hash, performed_by_user_id, basis, event_id, owner_scope,
      owner_user_id, owner_club_id, owner_team_id, event_kind, title, day, end_day, event_status, event_revision, result, writer_workspace_type, writer_workspace_id)
    values (p_request_key, p_request_hash, p_user_id, p_basis, v_event.id, v_event.owner_scope,
      v_event.owner_user_id, v_event.owner_club_id, v_event.owner_team_id, v_event.type_kind, v_event.title, v_event.day,
      v_event.end_day, v_event.status, v_event.revision, p_result, p_workspace_type, p_workspace_id)
    returning id into v_log_id;
  -- The event's request keys stay spent; then its own rows: the change log before the request records it names.
  insert into calendar.event_deleted_request_keys (performed_by_user_id, request_key, request_hash, operation, event_id)
    select r.performed_by_user_id, r.request_key, r.request_hash, r.operation, r.event_id
      from calendar.event_requests r where r.event_id = p_event_id;
  delete from calendar.event_changes where event_id = p_event_id;
  delete from calendar.event_requests where event_id = p_event_id;
  delete from calendar.event_selected_fields where event_id = p_event_id;
  delete from calendar.event_targets where event_id = p_event_id;
  delete from calendar.events where id = p_event_id;
  perform calendar.record_m1_write();
  return v_log_id;
end $$;

create or replace function calendar.event_deletion_log_before_insert() returns trigger language plpgsql as $$
declare
  v_event record;
  v_owner record;
begin
  -- The writer's rights before the event's lock (the order of every event command): the owner read without a lock,
  -- the rights locked, then the event locked and its owner compared again.
  select e.owner_scope, coalesce(e.owner_club_id, e.owner_team_id, e.owner_user_id) as owner_id into v_owner
    from calendar.events e where e.id = new.event_id;
  if not found then
    raise exception 'calendar.event_deletion_log: event_id names no event' using errcode = '23514', constraint = 'event_delete_no_event';
  end if;
  if new.writer_workspace_type is null then
    perform calendar.lock_event_writer(new.performed_by_user_id, v_owner.owner_scope, v_owner.owner_id, new.basis);
  else
    perform calendar.lock_event_writer_checked(new.performed_by_user_id, v_owner.owner_scope, v_owner.owner_id,
      new.basis, new.writer_workspace_type, new.writer_workspace_id);
  end if;
  select e.*, et.kind as type_kind into v_event
    from calendar.events e join calendar.event_types et on et.id = e.event_type_id
   where e.id = new.event_id
     for update of e;
  if not found then
    raise exception 'calendar.event_deletion_log: event_id names no event' using errcode = '23514', constraint = 'event_delete_no_event';
  end if;
  if new.owner_scope is distinct from v_event.owner_scope or new.owner_user_id is distinct from v_event.owner_user_id
     or new.owner_club_id is distinct from v_event.owner_club_id or new.owner_team_id is distinct from v_event.owner_team_id
     or new.title is distinct from v_event.title or new.day is distinct from v_event.day or new.end_day is distinct from v_event.end_day
     or new.event_status is distinct from v_event.status or new.event_revision is distinct from v_event.revision
     or new.event_kind is distinct from v_event.type_kind
     or v_owner.owner_scope is distinct from v_event.owner_scope
     or v_owner.owner_id is distinct from coalesce(v_event.owner_club_id, v_event.owner_team_id, v_event.owner_user_id) then
    raise exception 'calendar.event_deletion_log: the row does not repeat the event''s facts' using errcode = '23514', constraint = 'event_delete_facts';
  end if;
  if v_event.external_schedule_id is not null or v_event.test_schedule_id is not null then
    raise exception 'calendar.event_deletion_log: the event refers to a schedule' using errcode = '23514', constraint = 'event_delete_has_schedule';
  end if;
  if exists (select 1 from calendar.event_session_links l where l.event_id = new.event_id) then
    raise exception 'calendar.event_deletion_log: the event has linked trainings' using errcode = '23514', constraint = 'event_delete_has_trainings';
  end if;
  if exists (select 1 from calendar.event_activity_links l where l.event_id = new.event_id) then
    raise exception 'calendar.event_deletion_log: the event has linked activities' using errcode = '23514', constraint = 'event_delete_has_activities';
  end if;
  if exists (select 1 from calendar.event_questions q where q.event_id = new.event_id) then
    raise exception 'calendar.event_deletion_log: the event has questions for athletes' using errcode = '23514', constraint = 'event_delete_has_questions';
  end if;
  if exists (select 1 from calendar.question_assignment_skips s where s.event_id = new.event_id) then
    raise exception 'calendar.event_deletion_log: the event has skipped assignments' using errcode = '23514', constraint = 'event_delete_has_assignments';
  end if;
  if exists (select 1 from calendar.event_field_values v where v.event_id = new.event_id) then
    raise exception 'calendar.event_deletion_log: the event has detail values' using errcode = '23514', constraint = 'event_delete_has_details';
  end if;
  return new;
end $$;

create or replace function public.permission_word_honoured(p_word text) returns boolean
  language sql immutable set search_path = pg_catalog, public as $$
    select p_word in ('org.view', 'org.teams.manage', 'org.club.edit', 'athletes.manage', 'athletes.remove',
                      'staff.assign', 'roles.manage',
                      'athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view',
                      'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view',
                      'variables.view', 'calendar.events.manage', 'calendar.settings.manage')
  $$;

-- Audit exact seed inputs and post-seed state for the pre-activation rollback.
create table calendar.m1_permission_seed (
  layer text not null check (layer in ('role','version','custom')),
  id uuid not null,
  revision_before integer not null,
  based_before integer,
  answered_before integer,
  updated_before timestamptz,
  words text[] not null,
  primary key (layer,id)
);
alter table calendar.m1_permission_seed enable row level security;
revoke all on calendar.m1_permission_seed from public;

select public.lock_club_ceiling(array(select id from public.clubs order by id), 'exclusive');

insert into calendar.m1_permission_seed (layer,id,revision_before,updated_before,words)
select 'role',id,revision,updated_at,case basic_key
  when 'club_admin' then array['calendar.events.manage','calendar.settings.manage']
  else array['calendar.events.manage'] end
from public.permission_roles where basic_key in ('club_admin','team_coach');

insert into calendar.m1_permission_seed (layer,id,revision_before,based_before,answered_before,words)
select 'version',v.id,v.revision,v.based_on_revision,v.answered_revision,s.words
from public.permission_club_role_versions v
join calendar.m1_permission_seed s on s.layer='role' and s.id=v.system_role_id
where v.ended_at is null;

insert into calendar.m1_permission_seed (layer,id,revision_before,words)
select 'custom',c.id,c.revision,s.words
from public.permission_custom_roles c
join calendar.m1_permission_seed s on s.layer='role' and s.id=c.base_role_id
where c.ended_at is null
  and exists (select 1 from public.permission_user_holdings(c.user_id) h where h.custom_role_id=c.id);

update public.permission_roles r set revision=r.revision+1,updated_at=now()
from calendar.m1_permission_seed s where s.layer='role' and s.id=r.id;
insert into public.permission_role_changes (role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202611301000_calendar_v98_manage_permissions.sql',words
from calendar.m1_permission_seed where layer='role';
insert into public.permission_role_items (role_id,permission_word)
select id,unnest(words) from calendar.m1_permission_seed where layer='role';

update public.permission_club_role_versions v set revision=v.revision+1,
  based_on_revision=r.revision,answered_revision=r.revision
from calendar.m1_permission_seed s,public.permission_roles r
where s.layer='version' and s.id=v.id and r.id=v.system_role_id;
insert into public.permission_club_role_version_changes (version_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202611301000_calendar_v98_manage_permissions.sql',words
from calendar.m1_permission_seed where layer='version';
insert into public.permission_club_role_version_items (version_id,permission_word)
select id,unnest(words) from calendar.m1_permission_seed where layer='version';

update public.permission_custom_roles c set revision=c.revision+1
from calendar.m1_permission_seed s where s.layer='custom' and s.id=c.id;
insert into public.permission_custom_role_changes (custom_role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202611301000_calendar_v98_manage_permissions.sql',words
from calendar.m1_permission_seed where layer='custom';
insert into public.permission_custom_role_items (custom_role_id,permission_word)
select id,unnest(words) from calendar.m1_permission_seed where layer='custom';

-- Same privilege fence as the existing Calendar schema. The runtime connects
-- as the application database owner; PostgREST roles have no access here.
do $$
declare
  v_fn text;
  v_role text;
begin
  foreach v_role in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=v_role) then
      execute format('revoke all on calendar.m1_activation, calendar.m1_permission_seed from %I',v_role);
    end if;
  end loop;
  for v_fn in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='calendar' and p.proname in ('require_m1_cutover','record_m1_write','lock_event_writer_basis',
      'lock_m1_owner','lock_event_writer_checked','lock_settings_writer_checked','lock_questions_switch_checked','delete_event_checked')
  loop
    execute format('revoke execute on function %s from public',v_fn);
    foreach v_role in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=v_role) then
        execute format('revoke execute on function %s from %I',v_fn,v_role);
      end if;
    end loop;
  end loop;
end $$;

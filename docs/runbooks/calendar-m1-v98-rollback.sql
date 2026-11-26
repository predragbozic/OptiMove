-- Before activation and before use only. Revert application first and drain writers.
begin;
set local lock_timeout='5s';
select pg_advisory_xact_lock(11816506,1);
select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive');
lock table calendar.event_deletion_log, calendar.m1_activation, public.permission_roles, public.permission_role_items, public.permission_role_changes,
  public.permission_club_role_versions, public.permission_club_role_version_items, public.permission_club_role_version_changes,
  public.permission_custom_roles, public.permission_custom_role_items, public.permission_custom_role_changes, public.user_role_assignments,
  public.user_club_roles, public.user_team_roles in share row exclusive mode;
do $$
declare v_applied timestamptz;
begin
  select applied_at into v_applied from public.schema_migrations where migration_name='migrations_v2/202611301000_calendar_v98_manage_permissions.sql';
  if v_applied is null or exists (select 1 from public.schema_migrations where migration_name<>'migrations_v2/202611301000_calendar_v98_manage_permissions.sql' and applied_at>=v_applied) then
    raise exception 'v98 rollback refused: v98 missing or a later migration recorded';
  end if;
  if not exists(select 1 from calendar.m1_activation where singleton and not active and first_checked_write_at is null) then
    raise exception 'v98 rollback refused: Calendar permissions were activated or used';
  end if;
  if exists (select 1 from (values
  ('calendar.lock_event_writer(uuid,character varying,uuid,character varying)', '000ad562f33c8b1ce6bc283397a19a38'),
  ('calendar.delete_event(uuid,integer,uuid,character varying,uuid,text,jsonb)', '3bdce7b2005fc45748bb794e88220c52'),
  ('calendar.event_deletion_log_before_insert()', '1fea5c273306308d9aee091387268896'),
  ('public.permission_word_honoured(text)', '1fa3aa98df127c791a7abed9ab5e894a'),
  ('calendar.require_m1_cutover(boolean)', 'd81b78d2fa71e78373b94ac457d355a5'),
  ('calendar.record_m1_write()', '6e2087efec66908269aa2ae0e5b297b2'),
  ('calendar.lock_event_writer_basis(uuid,character varying,uuid,character varying)', '7ebf1bcf39cbb930fb913d89f25fd406'),
  ('calendar.lock_m1_owner(character varying,uuid)', '180ccf855e3a4d0ddbf72db65cf820e5'),
  ('calendar.lock_event_writer_checked(uuid,character varying,uuid,character varying,character varying,uuid)', '6dc716ecceeedc6635d52e1d59249d86'),
  ('calendar.lock_settings_writer_checked(uuid,uuid,uuid)', '3058f5b967fbdb3085089829d2ec91cd'),
  ('calendar.lock_questions_switch_checked(uuid,uuid)', '10a6254c761ee2d8de0c2687819bb7af'),
  ('calendar.delete_event_checked(uuid,integer,uuid,character varying,uuid,text,jsonb,character varying,uuid)', '88484b28236e730471996435512fce98')
  ) x(sig,body) left join pg_proc p on p.oid=to_regprocedure(x.sig) where md5(p.prosrc) is distinct from x.body) then
    raise exception 'v98 rollback refused: Calendar or permission body changed';
  end if;
  if exists (select 1 from (values
    ('public.permission_role_items','permission_role_items_guard'),
    ('public.permission_roles','permission_roles_guard'),
    ('public.permission_roles','permission_roles_complete'),
    ('public.permission_role_changes','permission_role_changes_append_only'),
    ('public.permission_club_role_version_items','permission_club_role_version_items_guard'),
    ('public.permission_club_role_versions','permission_club_role_versions_guard'),
    ('public.permission_club_role_versions','permission_club_role_versions_complete'),
    ('public.permission_club_role_version_changes','permission_club_role_version_changes_append_only'),
    ('public.permission_custom_role_items','permission_custom_role_items_guard'),
    ('public.permission_custom_roles','permission_custom_roles_guard'),
    ('public.permission_custom_roles','permission_custom_roles_complete'),
    ('public.permission_custom_role_changes','permission_custom_role_changes_append_only')
  ) x(tbl,name) left join pg_trigger t on t.tgrelid=to_regclass(x.tbl) and t.tgname=x.name where t.tgenabled is distinct from 'O') then
    raise exception 'v98 rollback refused: an audited trigger is missing or disabled';
  end if;
  if exists (
    select 1 from calendar.m1_permission_seed s
    left join public.permission_roles r on s.layer='role' and r.id=s.id
    left join public.permission_club_role_versions v on s.layer='version' and v.id=s.id
    left join public.permission_custom_roles c on s.layer='custom' and c.id=s.id
    left join public.permission_roles vr on vr.id=v.system_role_id
    where coalesce(r.revision,v.revision,c.revision) is distinct from s.revision_before+1
       or (s.layer='version' and (v.ended_at is not null
           or v.based_on_revision is distinct from vr.revision or v.answered_revision is distinct from vr.revision))
       or (s.layer='custom' and c.ended_at is not null)
  ) then
    raise exception 'v98 rollback refused: a seeded layer changed';
  end if;
  if exists (
    with expected as (select layer,id,unnest(words) as word from calendar.m1_permission_seed),
    actual as (
      select 'role' as layer,role_id as id,permission_word as word from public.permission_role_items
      union all select 'version',version_id,permission_word from public.permission_club_role_version_items
      union all select 'custom',custom_role_id,permission_word from public.permission_custom_role_items
    ), changes as (
      (select * from expected except select * from actual)
      union all
      (select * from actual where word in ('calendar.events.manage','calendar.settings.manage') except select * from expected)
    ) select 1 from changes
  ) then
    raise exception 'v98 rollback refused: Calendar permission grants changed';
  end if;
  if exists (select 1 from public.user_club_roles where role='club_admin' and greatest(created_at,updated_at)>=v_applied)
     or exists (select 1 from public.user_team_roles where role='team_coach' and greatest(created_at,updated_at)>=v_applied) then
    raise exception 'v98 rollback refused: a native Calendar role grant changed';
  end if;

end $$;

alter table public.permission_role_items disable trigger permission_role_items_guard;
alter table public.permission_roles disable trigger permission_roles_guard;
alter table public.permission_roles disable trigger permission_roles_complete;
alter table public.permission_role_changes disable trigger permission_role_changes_append_only;
alter table public.permission_club_role_version_items disable trigger permission_club_role_version_items_guard;
alter table public.permission_club_role_versions disable trigger permission_club_role_versions_guard;
alter table public.permission_club_role_versions disable trigger permission_club_role_versions_complete;
alter table public.permission_club_role_version_changes disable trigger permission_club_role_version_changes_append_only;
alter table public.permission_custom_role_items disable trigger permission_custom_role_items_guard;
alter table public.permission_custom_roles disable trigger permission_custom_roles_guard;
alter table public.permission_custom_roles disable trigger permission_custom_roles_complete;
alter table public.permission_custom_role_changes disable trigger permission_custom_role_changes_append_only;

delete from public.permission_role_items i using calendar.m1_permission_seed s
where s.layer='role' and i.role_id=s.id and i.permission_word=any(s.words);
delete from public.permission_club_role_version_items i using calendar.m1_permission_seed s
where s.layer='version' and i.version_id=s.id and i.permission_word=any(s.words);
delete from public.permission_custom_role_items i using calendar.m1_permission_seed s
where s.layer='custom' and i.custom_role_id=s.id and i.permission_word=any(s.words);

delete from public.permission_role_changes where migration_name='migrations_v2/202611301000_calendar_v98_manage_permissions.sql';
delete from public.permission_club_role_version_changes where migration_name='migrations_v2/202611301000_calendar_v98_manage_permissions.sql';
delete from public.permission_custom_role_changes where migration_name='migrations_v2/202611301000_calendar_v98_manage_permissions.sql';

update public.permission_roles r set revision=s.revision_before,updated_at=s.updated_before
from calendar.m1_permission_seed s where s.layer='role' and r.id=s.id;
update public.permission_club_role_versions v set revision=s.revision_before,based_on_revision=s.based_before,answered_revision=s.answered_before
from calendar.m1_permission_seed s where s.layer='version' and v.id=s.id;
update public.permission_custom_roles c set revision=s.revision_before
from calendar.m1_permission_seed s where s.layer='custom' and c.id=s.id;
-- Run the remaining deferred invariant checks before re-enabling guards.
set constraints all immediate;

alter table public.permission_role_items enable trigger permission_role_items_guard;
alter table public.permission_roles enable trigger permission_roles_guard;
alter table public.permission_roles enable trigger permission_roles_complete;
alter table public.permission_role_changes enable trigger permission_role_changes_append_only;
alter table public.permission_club_role_version_items enable trigger permission_club_role_version_items_guard;
alter table public.permission_club_role_versions enable trigger permission_club_role_versions_guard;
alter table public.permission_club_role_versions enable trigger permission_club_role_versions_complete;
alter table public.permission_club_role_version_changes enable trigger permission_club_role_version_changes_append_only;
alter table public.permission_custom_role_items enable trigger permission_custom_role_items_guard;
alter table public.permission_custom_roles enable trigger permission_custom_roles_guard;
alter table public.permission_custom_roles enable trigger permission_custom_roles_complete;
alter table public.permission_custom_role_changes enable trigger permission_custom_role_changes_append_only;

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

create or replace function calendar.delete_event(p_event_id uuid, p_expected_revision integer, p_user_id uuid, p_basis varchar,
                                      p_request_key uuid, p_request_hash text, p_result jsonb)
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
  perform calendar.lock_event_writer(new.performed_by_user_id, v_owner.owner_scope, v_owner.owner_id, new.basis);
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
                      'variables.view')
  $$;

alter table calendar.event_deletion_log drop constraint calendar_m1_delete_workspace, drop column writer_workspace_type, drop column writer_workspace_id;
drop function calendar.delete_event_checked(uuid,integer,uuid,character varying,uuid,text,jsonb,character varying,uuid);
drop function calendar.lock_questions_switch_checked(uuid,uuid);
drop function calendar.lock_settings_writer_checked(uuid,uuid,uuid);
drop function calendar.lock_event_writer_checked(uuid,character varying,uuid,character varying,character varying,uuid);
drop function calendar.lock_m1_owner(character varying,uuid);
drop function calendar.lock_event_writer_basis(uuid,character varying,uuid,character varying);
drop function calendar.record_m1_write();
drop function calendar.require_m1_cutover(boolean);
drop table calendar.m1_permission_seed;
drop table calendar.m1_activation;
do $$ begin
  if exists (select 1 from (values
  ('calendar.lock_event_writer(uuid,character varying,uuid,character varying)', '7ebf1bcf39cbb930fb913d89f25fd406'),
  ('calendar.delete_event(uuid,integer,uuid,character varying,uuid,text,jsonb)', '9ec5c97afeca674dc772f5f8503e21f7'),
  ('calendar.event_deletion_log_before_insert()', 'a5c35d8e6f860d02af596ce0fa9f949c'),
  ('public.permission_word_honoured(text)', '0c47ce1a6b157c1c9205d4f48438a5ac')
  ) x(sig,body) left join pg_proc p on p.oid=to_regprocedure(x.sig) where md5(p.prosrc) is distinct from x.body) then
    raise exception 'v98 rollback refused: original body restoration differs';
  end if;
end $$;
delete from public.schema_migrations where migration_name='migrations_v2/202611301000_calendar_v98_manage_permissions.sql';
commit;

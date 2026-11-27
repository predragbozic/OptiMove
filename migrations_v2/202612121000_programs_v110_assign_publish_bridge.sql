-- Stage distinct Programs Assign and Publish rights. Programs Edit retains its v109 evidence.
set local lock_timeout='5s';
select pg_advisory_xact_lock(hashtextextended('program-assign-publish-v110',0));
select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive');
lock table public.permission_roles, public.permission_role_items, public.permission_role_changes,
  public.permission_club_role_versions, public.permission_club_role_version_items, public.permission_club_role_version_changes,
  public.permission_custom_roles, public.permission_custom_role_items, public.permission_custom_role_changes in share row exclusive mode;

do $$ begin
  if not exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql' and checksum='d18d03b6bdfaae33fe6481e4b9a44187ebcf763741b994f1ad473fd2a654d764') or exists (select 1 from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612111000_programs_v109_edit_bridge.sql') then
    raise exception 'v110 expects the exact v109 registry predecessor';
  end if;
  if (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)')) is distinct from '087f01e9188b2a8a16e3f748addba19f' then
    raise exception 'v110 expects the approved permission evaluator';
  end if;
  if to_regclass('plans.program_manage_v109_use') is null
     or to_regclass('plans.program_edit_v109_assignment_evidence') is null then
    raise exception 'v110 expects the existing Programs Edit evidence';
  end if;
  if (select count(*) from public.permission_roles r where basic_key in ('club_admin','team_coach') and archived_at is null
        and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='programs.view')) <> 2
     or (exists (select 1 from public.permission_role_items where permission_word in ('programs.assign','programs.publish'))
    or exists (select 1 from public.permission_club_role_version_items where permission_word in ('programs.assign','programs.publish'))
    or exists (select 1 from public.permission_custom_role_items where permission_word in ('programs.assign','programs.publish'))) then
    raise exception 'v110 found an unexpected Programs Assign/Publish staging or built-in role set';
  end if;
end $$;

create or replace function public.permission_word_honoured(p_word text) returns boolean
  language sql immutable set search_path = pg_catalog, public as $$
    select p_word in ('org.view', 'org.teams.manage', 'org.club.edit', 'athletes.manage', 'athletes.remove',
                      'staff.assign', 'roles.manage',
                      'athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view',
                      'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view',
                      'variables.view', 'calendar.events.manage', 'calendar.settings.manage', 'load.schedule.manage', 'load.roster.decide', 'load.estimates.manage', 'load.activities.manage', 'dashboards.manage', 'programs.rpe_settings', 'exercises.add', 'exercises.remove', 'programs.edit', 'programs.assign', 'programs.publish')
  $$;

create table plans.program_assign_publish_v110_use (
  singleton boolean primary key default true check (singleton),
  first_used_at timestamptz not null default clock_timestamp()
);
alter table plans.program_assign_publish_v110_use enable row level security;
revoke all on plans.program_assign_publish_v110_use from public;
create function plans.keep_program_assign_publish_v110_use() returns trigger
language plpgsql set search_path=pg_catalog,plans as $program_assign_publish_use_guard$
begin
  raise exception 'Programs Assign/Publish bridge first-use evidence is immutable';
end
$program_assign_publish_use_guard$;
revoke all on function plans.keep_program_assign_publish_v110_use() from public;
create trigger program_assign_publish_v110_keep_use
before update or delete or truncate on plans.program_assign_publish_v110_use
for each statement execute function plans.keep_program_assign_publish_v110_use();

create table plans.program_assign_publish_v110_seed (
  layer text not null check (layer in ('role','version','custom')),
  id uuid not null,
  revision_before integer not null,
  based_before integer,
  answered_before integer,
  updated_before timestamptz,
  words text[] not null,
  primary key (layer,id)
);
alter table plans.program_assign_publish_v110_seed enable row level security;
revoke all on plans.program_assign_publish_v110_seed from public;



insert into plans.program_assign_publish_v110_seed (layer,id,revision_before,updated_before,words)
select 'role',id,revision,updated_at,array['programs.assign','programs.publish']
from public.permission_roles r where basic_key in ('club_admin','team_coach') and archived_at is null
  and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='programs.view');

insert into plans.program_assign_publish_v110_seed (layer,id,revision_before,based_before,answered_before,words)
select 'version',v.id,v.revision,v.based_on_revision,v.answered_revision,s.words
from public.permission_club_role_versions v
join plans.program_assign_publish_v110_seed s on s.layer='role' and s.id=v.system_role_id
where v.ended_at is null
  and exists (select 1 from public.permission_club_role_version_items i where i.version_id=v.id and i.permission_word='programs.view');

insert into plans.program_assign_publish_v110_seed (layer,id,revision_before,words)
select 'custom',c.id,c.revision,s.words
from public.permission_custom_roles c
join plans.program_assign_publish_v110_seed s on s.layer='role' and s.id=c.base_role_id
where c.ended_at is null
  and exists (select 1 from public.permission_custom_role_items i where i.custom_role_id=c.id and i.permission_word='programs.view')
  and exists (
    select 1 from public.permission_user_holdings(c.user_id) h
    where h.custom_role_id=c.id and h.assignment_id is null and h.scope_type in ('club','team')
  );

update public.permission_roles r set revision=r.revision+1,updated_at=now()
from plans.program_assign_publish_v110_seed s where s.layer='role' and s.id=r.id;
insert into public.permission_role_changes (role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612121000_programs_v110_assign_publish_bridge.sql',words
from plans.program_assign_publish_v110_seed where layer='role';
insert into public.permission_role_items (role_id,permission_word)
select id,unnest(words) from plans.program_assign_publish_v110_seed where layer='role';

update public.permission_club_role_versions v set revision=v.revision+1,
  based_on_revision=case when s.based_before=r.revision-1 then r.revision else s.based_before end,
  answered_revision=case when s.answered_before=r.revision-1 then r.revision else s.answered_before end
from plans.program_assign_publish_v110_seed s,public.permission_roles r
where s.layer='version' and s.id=v.id and r.id=v.system_role_id;
insert into public.permission_club_role_version_changes (version_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612121000_programs_v110_assign_publish_bridge.sql',words
from plans.program_assign_publish_v110_seed where layer='version';
insert into public.permission_club_role_version_items (version_id,permission_word)
select id,unnest(words) from plans.program_assign_publish_v110_seed where layer='version';

update public.permission_custom_roles c set revision=c.revision+1
from plans.program_assign_publish_v110_seed s where s.layer='custom' and s.id=c.id;
insert into public.permission_custom_role_changes (custom_role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612121000_programs_v110_assign_publish_bridge.sql',words
from plans.program_assign_publish_v110_seed where layer='custom';
insert into public.permission_custom_role_items (custom_role_id,permission_word)
select id,unnest(words) from plans.program_assign_publish_v110_seed where layer='custom';

do $$
declare api_role text;
begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=api_role) then
      execute format('revoke all on plans.program_assign_publish_v110_use, plans.program_assign_publish_v110_seed from %I',api_role);
      execute format('revoke all on function plans.keep_program_assign_publish_v110_use() from %I',api_role);
    end if;
  end loop;
end $$;

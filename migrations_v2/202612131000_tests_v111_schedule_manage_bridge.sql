-- Stage Tests Schedule Manage independently from Tests View and its predecessor rights.
set local lock_timeout='5s';
select pg_advisory_xact_lock(hashtextextended('tests-schedule-manage-v111',0));
select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive');
lock table public.permission_roles, public.permission_role_items, public.permission_role_changes,
  public.permission_club_role_versions, public.permission_club_role_version_items, public.permission_club_role_version_changes,
  public.permission_custom_roles, public.permission_custom_role_items, public.permission_custom_role_changes in share row exclusive mode;

do $$ begin
  if not exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612121000_programs_v110_assign_publish_bridge.sql' and checksum='43a36a33128afb57f97f02767f7fd7d49743c4958fd10e774fc9b3f3a95f0cfd') or exists (select 1 from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612121000_programs_v110_assign_publish_bridge.sql') then
    raise exception 'v111 expects the exact v110 registry predecessor';
  end if;
  if (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)')) is distinct from '3fdbf46bdba6bd0a209e26fc1bf7fcb2' then
    raise exception 'v111 expects the approved permission evaluator';
  end if;
  if to_regclass('plans.program_manage_v109_use') is null
     or to_regclass('plans.program_assign_publish_v110_use') is null then
    raise exception 'v111 expects the existing Programs staging evidence';
  end if;
  if (select count(*) from public.permission_roles r where basic_key in ('club_admin','team_coach') and archived_at is null
        and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='tests.view')) <> 2
     or (exists (select 1 from public.permission_role_items where permission_word = 'tests.schedule.manage')
    or exists (select 1 from public.permission_club_role_version_items where permission_word = 'tests.schedule.manage')
    or exists (select 1 from public.permission_custom_role_items where permission_word = 'tests.schedule.manage')) then
    raise exception 'v111 found an unexpected Tests Schedule Manage staging or built-in role set';
  end if;
end $$;

create or replace function public.permission_word_honoured(p_word text) returns boolean
  language sql immutable set search_path = pg_catalog, public as $$
    select p_word in ('org.view', 'org.teams.manage', 'org.club.edit', 'athletes.manage', 'athletes.remove',
                      'staff.assign', 'roles.manage',
                      'athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view',
                      'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view',
                      'variables.view', 'calendar.events.manage', 'calendar.settings.manage', 'load.schedule.manage', 'load.roster.decide', 'load.estimates.manage', 'load.activities.manage', 'dashboards.manage', 'programs.rpe_settings', 'exercises.add', 'exercises.remove', 'programs.edit', 'programs.assign', 'programs.publish', 'tests.schedule.manage')
  $$;

create table tests.schedule_manage_bridge_use (
  singleton boolean primary key default true check (singleton),
  first_checked_write_at timestamptz
);
insert into tests.schedule_manage_bridge_use (singleton) values (true);
alter table tests.schedule_manage_bridge_use enable row level security;
revoke all on tests.schedule_manage_bridge_use from public;

create function tests.keep_schedule_manage_v111_use() returns trigger
language plpgsql set search_path=pg_catalog,tests as $schedule_manage_use_guard$
begin
  if tg_op = 'UPDATE' then
    if old.singleton and new.singleton
       and old.first_checked_write_at is null and new.first_checked_write_at is not null then
      return new;
    end if;
  end if;
  raise exception 'Tests Schedule Manage first-use evidence is immutable';
end
$schedule_manage_use_guard$;
revoke all on function tests.keep_schedule_manage_v111_use() from public;
create trigger schedule_manage_v111_keep_use
before update or delete on tests.schedule_manage_bridge_use
for each row execute function tests.keep_schedule_manage_v111_use();
create trigger schedule_manage_v111_keep_use_truncate
before truncate on tests.schedule_manage_bridge_use
for each statement execute function tests.keep_schedule_manage_v111_use();

create table tests.schedule_manage_v111_seed (
  layer text not null check (layer in ('role','version','custom')),
  id uuid not null,
  revision_before integer not null,
  based_before integer,
  answered_before integer,
  updated_before timestamptz,
  words text[] not null,
  check (words = array['tests.schedule.manage']),
  primary key (layer,id)
);
alter table tests.schedule_manage_v111_seed enable row level security;
revoke all on tests.schedule_manage_v111_seed from public;



insert into tests.schedule_manage_v111_seed (layer,id,revision_before,updated_before,words)
select 'role',id,revision,updated_at,array['tests.schedule.manage']
from public.permission_roles r where basic_key in ('club_admin','team_coach') and archived_at is null
  and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='tests.view');

insert into tests.schedule_manage_v111_seed (layer,id,revision_before,based_before,answered_before,words)
select 'version',v.id,v.revision,v.based_on_revision,v.answered_revision,s.words
from public.permission_club_role_versions v
join tests.schedule_manage_v111_seed s on s.layer='role' and s.id=v.system_role_id
where v.ended_at is null
  and exists (select 1 from public.permission_club_role_version_items i where i.version_id=v.id and i.permission_word='tests.view');

insert into tests.schedule_manage_v111_seed (layer,id,revision_before,words)
select 'custom',c.id,c.revision,s.words
from public.permission_custom_roles c
join tests.schedule_manage_v111_seed s on s.layer='role' and s.id=c.base_role_id
where c.ended_at is null
  and exists (select 1 from public.permission_custom_role_items i where i.custom_role_id=c.id and i.permission_word='tests.view')
  and exists (
    select 1 from public.permission_user_holdings(c.user_id) h
    where h.custom_role_id=c.id and h.assignment_id is null and h.scope_type in ('club','team')
  );

update public.permission_roles r set revision=r.revision+1,updated_at=now()
from tests.schedule_manage_v111_seed s where s.layer='role' and s.id=r.id;
insert into public.permission_role_changes (role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612131000_tests_v111_schedule_manage_bridge.sql',words
from tests.schedule_manage_v111_seed where layer='role';
insert into public.permission_role_items (role_id,permission_word)
select id,unnest(words) from tests.schedule_manage_v111_seed where layer='role';

update public.permission_club_role_versions v set revision=v.revision+1,
  based_on_revision=case when s.based_before=r.revision-1 then r.revision else s.based_before end,
  answered_revision=case when s.answered_before=r.revision-1 then r.revision else s.answered_before end
from tests.schedule_manage_v111_seed s,public.permission_roles r
where s.layer='version' and s.id=v.id and r.id=v.system_role_id;
insert into public.permission_club_role_version_changes (version_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612131000_tests_v111_schedule_manage_bridge.sql',words
from tests.schedule_manage_v111_seed where layer='version';
insert into public.permission_club_role_version_items (version_id,permission_word)
select id,unnest(words) from tests.schedule_manage_v111_seed where layer='version';

update public.permission_custom_roles c set revision=c.revision+1
from tests.schedule_manage_v111_seed s where s.layer='custom' and s.id=c.id;
insert into public.permission_custom_role_changes (custom_role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612131000_tests_v111_schedule_manage_bridge.sql',words
from tests.schedule_manage_v111_seed where layer='custom';
insert into public.permission_custom_role_items (custom_role_id,permission_word)
select id,unnest(words) from tests.schedule_manage_v111_seed where layer='custom';

do $$
declare api_role text;
begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=api_role) then
      execute format('revoke all on tests.schedule_manage_bridge_use, tests.schedule_manage_v111_seed from %I',api_role);
      execute format('revoke all on function tests.keep_schedule_manage_v111_use() from %I',api_role);
    end if;
  end loop;
end $$;

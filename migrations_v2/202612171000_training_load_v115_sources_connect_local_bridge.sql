-- Stage Sources Connect for historically eligible native Club-admin layers for local writers.
set local lock_timeout='5s';
select pg_advisory_xact_lock(hashtextextended('sources-connect-v115',0));
select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive');
lock table public.permission_roles, public.permission_role_items, public.permission_role_changes,
  public.permission_club_role_versions, public.permission_club_role_version_items, public.permission_club_role_version_changes,
  public.permission_custom_roles, public.permission_custom_role_items, public.permission_custom_role_changes in share row exclusive mode;

do $$ begin
  if not exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612161000_training_load_v114_mappings_manage_bridge.sql' and checksum='7eefcd2204babab96633ff69905405349fa9eadb9ce19643670879ebf603dbfb') or exists (select 1 from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612161000_training_load_v114_mappings_manage_bridge.sql') then
    raise exception 'v115 expects the exact v114 registry predecessor';
  end if;
  if (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)')) is distinct from '5049fee9f1790dee54fc174de2d0c058' then
    raise exception 'v115 expects the approved permission evaluator';
  end if;
  if to_regclass('plans.program_manage_v109_use') is null
     or to_regclass('plans.program_assign_publish_v110_use') is null
     or to_regclass('tests.schedule_manage_bridge_use') is null
     or to_regclass('training_load.variable_rename_archive_v112_use') is null
     or to_regclass('training_load.variables_manage_v113_use') is null
     or to_regclass('training_load.mappings_manage_bridge_use') is null then
    raise exception 'v115 expects the existing Programs, Tests, Variables and Mappings staging evidence';
  end if;
  if (select count(*) from public.permission_roles r where basic_key='club_admin' and archived_at is null) <> 1
     or (exists (select 1 from public.permission_role_items where permission_word = 'sources.connect')
    or exists (select 1 from public.permission_club_role_version_items where permission_word = 'sources.connect')
    or exists (select 1 from public.permission_custom_role_items where permission_word = 'sources.connect')) then
    raise exception 'v115 found an unexpected Sources Connect staging or built-in role set';
  end if;
end $$;

create or replace function public.permission_word_honoured(p_word text) returns boolean
  language sql immutable set search_path = pg_catalog, public as $$
    select p_word in ('org.view', 'org.teams.manage', 'org.club.edit', 'athletes.manage', 'athletes.remove',
                      'staff.assign', 'roles.manage',
                      'athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view',
                      'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view',
                      'variables.view', 'calendar.events.manage', 'calendar.settings.manage', 'load.schedule.manage', 'load.roster.decide', 'load.estimates.manage', 'load.activities.manage', 'dashboards.manage', 'programs.rpe_settings', 'exercises.add', 'exercises.remove', 'programs.edit', 'programs.assign', 'programs.publish', 'tests.schedule.manage', 'variables.rename_archive', 'variables.manage', 'mappings.manage', 'sources.connect')
  $$;

create table training_load.sources_connect_local_bridge_use (
  singleton boolean primary key default true check (singleton),
  first_checked_write_at timestamptz
);
insert into training_load.sources_connect_local_bridge_use (singleton) values (true);
alter table training_load.sources_connect_local_bridge_use enable row level security;
revoke all on training_load.sources_connect_local_bridge_use from public;

create function training_load.keep_sources_connect_local_bridge_use() returns trigger
language plpgsql set search_path=pg_catalog,training_load as $sources_connect_use_guard$
begin
  if tg_op = 'UPDATE' then
    if old.singleton and new.singleton
       and old.first_checked_write_at is null and new.first_checked_write_at is not null then
      return new;
    end if;
  end if;
  raise exception 'Sources Connect first-use evidence is immutable';
end
$sources_connect_use_guard$;
revoke all on function training_load.keep_sources_connect_local_bridge_use() from public;
create trigger sources_connect_v115_keep_use
before update or delete on training_load.sources_connect_local_bridge_use
for each row execute function training_load.keep_sources_connect_local_bridge_use();
create trigger sources_connect_v115_keep_use_truncate
before truncate on training_load.sources_connect_local_bridge_use
for each statement execute function training_load.keep_sources_connect_local_bridge_use();

create table training_load.sources_connect_v115_seed (
  layer text not null check (layer in ('role','version','custom')),
  id uuid not null,
  revision_before integer not null,
  based_before integer,
  answered_before integer,
  updated_before timestamptz,
  words text[] not null,
  check (words = array['sources.connect']),
  primary key (layer,id)
);
alter table training_load.sources_connect_v115_seed enable row level security;
revoke all on training_load.sources_connect_v115_seed from public;



insert into training_load.sources_connect_v115_seed (layer,id,revision_before,updated_before,words)
select 'role',id,revision,updated_at,array['sources.connect']
from public.permission_roles r where basic_key='club_admin' and archived_at is null;

insert into training_load.sources_connect_v115_seed (layer,id,revision_before,based_before,answered_before,words)
select 'version',v.id,v.revision,v.based_on_revision,v.answered_revision,s.words
from public.permission_club_role_versions v
join training_load.sources_connect_v115_seed s on s.layer='role' and s.id=v.system_role_id
where v.ended_at is null;

insert into training_load.sources_connect_v115_seed (layer,id,revision_before,words)
select 'custom',c.id,c.revision,s.words
from public.permission_custom_roles c
join training_load.sources_connect_v115_seed s on s.layer='role' and s.id=c.base_role_id
where c.ended_at is null and c.scope_type='club'
  and exists (
    select 1 from public.permission_user_holdings(c.user_id) h
    where h.custom_role_id=c.id and h.assignment_id is null and h.scope_type='club'
  );

update public.permission_roles r set revision=r.revision+1,updated_at=now()
from training_load.sources_connect_v115_seed s where s.layer='role' and s.id=r.id;
insert into public.permission_role_changes (role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612171000_training_load_v115_sources_connect_local_bridge.sql',words
from training_load.sources_connect_v115_seed where layer='role';
insert into public.permission_role_items (role_id,permission_word)
select id,unnest(words) from training_load.sources_connect_v115_seed where layer='role';

update public.permission_club_role_versions v set revision=v.revision+1,
  based_on_revision=case when s.based_before=r.revision-1 then r.revision else s.based_before end,
  answered_revision=case when s.answered_before=r.revision-1 then r.revision else s.answered_before end
from training_load.sources_connect_v115_seed s,public.permission_roles r
where s.layer='version' and s.id=v.id and r.id=v.system_role_id;
insert into public.permission_club_role_version_changes (version_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612171000_training_load_v115_sources_connect_local_bridge.sql',words
from training_load.sources_connect_v115_seed where layer='version';
insert into public.permission_club_role_version_items (version_id,permission_word)
select id,unnest(words) from training_load.sources_connect_v115_seed where layer='version';

update public.permission_custom_roles c set revision=c.revision+1
from training_load.sources_connect_v115_seed s where s.layer='custom' and s.id=c.id;
insert into public.permission_custom_role_changes (custom_role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612171000_training_load_v115_sources_connect_local_bridge.sql',words
from training_load.sources_connect_v115_seed where layer='custom';
insert into public.permission_custom_role_items (custom_role_id,permission_word)
select id,unnest(words) from training_load.sources_connect_v115_seed where layer='custom';

do $$
declare api_role text;
begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=api_role) then
      execute format('revoke all on training_load.sources_connect_local_bridge_use, training_load.sources_connect_v115_seed from %I',api_role);
      execute format('revoke all on function training_load.keep_sources_connect_local_bridge_use() from %I',api_role);
    end if;
  end loop;
end $$;

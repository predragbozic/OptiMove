-- M-3a bridge: stage the Roster Decide word and seed the existing native writers.
set local lock_timeout = '5s';

do $$ begin
  if not exists (select 1 from public.schema_migrations
    where migration_name='migrations_v2/202612011000_training_load_v99_schedule_manage_bridge.sql'
      and checksum='230d51b45702a291b21e84a60fa3738404d1e4bfeb68124ec9554396d858a401') then
    raise exception 'v101 expects the approved v99 migration record';
  end if;
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.permission_word_honoured(text)')) is distinct from '83d0186d6ab02ea435ad5303bea5da0f' then
    raise exception 'v101 expects the approved v99 permission body';
  end if;
end $$;

create or replace function public.permission_word_honoured(p_word text) returns boolean
  language sql immutable set search_path = pg_catalog, public as $$
    select p_word in ('org.view', 'org.teams.manage', 'org.club.edit', 'athletes.manage', 'athletes.remove',
                      'staff.assign', 'roles.manage',
                      'athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view',
                      'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view',
                      'variables.view', 'calendar.events.manage', 'calendar.settings.manage', 'load.schedule.manage', 'load.roster.decide')
  $$;

create table training_load.activity_roster_m3a_use (
  singleton boolean primary key default true check (singleton),
  first_checked_write_at timestamptz
);
insert into training_load.activity_roster_m3a_use (singleton) values (true);
alter table training_load.activity_roster_m3a_use enable row level security;
revoke all on training_load.activity_roster_m3a_use from public;

create table training_load.activity_roster_m3a_seed (
  layer text not null check (layer in ('role','version','custom')),
  id uuid not null,
  revision_before integer not null,
  based_before integer,
  answered_before integer,
  updated_before timestamptz,
  words text[] not null,
  primary key (layer,id)
);
alter table training_load.activity_roster_m3a_seed enable row level security;
revoke all on training_load.activity_roster_m3a_seed from public;

select public.lock_club_ceiling(array(select id from public.clubs order by id), 'exclusive');

insert into training_load.activity_roster_m3a_seed (layer,id,revision_before,updated_before,words)
select 'role',id,revision,updated_at,array['load.roster.decide']
from public.permission_roles where basic_key in ('club_admin','team_coach');

insert into training_load.activity_roster_m3a_seed (layer,id,revision_before,based_before,answered_before,words)
select 'version',v.id,v.revision,v.based_on_revision,v.answered_revision,s.words
from public.permission_club_role_versions v
join training_load.activity_roster_m3a_seed s on s.layer='role' and s.id=v.system_role_id
where v.ended_at is null;

insert into training_load.activity_roster_m3a_seed (layer,id,revision_before,words)
select 'custom',c.id,c.revision,s.words
from public.permission_custom_roles c
join training_load.activity_roster_m3a_seed s on s.layer='role' and s.id=c.base_role_id
where c.ended_at is null
  and exists (select 1 from public.permission_user_holdings(c.user_id) h where h.custom_role_id=c.id);

update public.permission_roles r set revision=r.revision+1,updated_at=now()
from training_load.activity_roster_m3a_seed s where s.layer='role' and s.id=r.id;
insert into public.permission_role_changes (role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612031000_training_load_v101_roster_manage_bridge.sql',words
from training_load.activity_roster_m3a_seed where layer='role';
insert into public.permission_role_items (role_id,permission_word)
select id,unnest(words) from training_load.activity_roster_m3a_seed where layer='role';

update public.permission_club_role_versions v set revision=v.revision+1,
  based_on_revision=case when s.based_before=r.revision-1 then r.revision else s.based_before end,
  answered_revision=case when s.answered_before=r.revision-1 then r.revision else s.answered_before end
from training_load.activity_roster_m3a_seed s,public.permission_roles r
where s.layer='version' and s.id=v.id and r.id=v.system_role_id;
insert into public.permission_club_role_version_changes (version_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612031000_training_load_v101_roster_manage_bridge.sql',words
from training_load.activity_roster_m3a_seed where layer='version';
insert into public.permission_club_role_version_items (version_id,permission_word)
select id,unnest(words) from training_load.activity_roster_m3a_seed where layer='version';

update public.permission_custom_roles c set revision=c.revision+1
from training_load.activity_roster_m3a_seed s where s.layer='custom' and s.id=c.id;
insert into public.permission_custom_role_changes (custom_role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612031000_training_load_v101_roster_manage_bridge.sql',words
from training_load.activity_roster_m3a_seed where layer='custom';
insert into public.permission_custom_role_items (custom_role_id,permission_word)
select id,unnest(words) from training_load.activity_roster_m3a_seed where layer='custom';

do $$
declare v_role text;
begin
  foreach v_role in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname=v_role) then
      execute format('revoke all on training_load.activity_roster_m3a_seed, training_load.activity_roster_m3a_use from %I',v_role);
    end if;
  end loop;
end $$;

-- Exercise Add/Remove staging preserves existing exercise ownership and media policy.
set local lock_timeout='5s';
select pg_advisory_xact_lock(hashtextextended('exercise-manage-v108',0));
select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive');
lock table public.permission_roles, public.permission_role_items, public.permission_role_changes,
  public.permission_club_role_versions, public.permission_club_role_version_items, public.permission_club_role_version_changes,
  public.permission_custom_roles, public.permission_custom_role_items, public.permission_custom_role_changes in share row exclusive mode;

do $$ begin
  if not exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612091000_training_load_v107_builder_rpe_copy_attestation.sql' and checksum='7f1f42e052681532a7ce6860f184013ca21490006ff58d3baecf154c24f93f9f') or exists (select 1 from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612091000_training_load_v107_builder_rpe_copy_attestation.sql') then
    raise exception 'v108 expects the exact v107 registry predecessor';
  end if;
  if (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)')) is distinct from 'ab3c43d4a319567b7f208305a1097fd3' then
    raise exception 'v108 expects the approved permission evaluator';
  end if;
  if (select count(*) from public.permission_roles r where basic_key in ('club_admin','team_coach') and archived_at is null
        and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='exercises.use')) <> 2
     or (exists (select 1 from public.permission_role_items where permission_word in ('exercises.add','exercises.remove'))
    or exists (select 1 from public.permission_club_role_version_items where permission_word in ('exercises.add','exercises.remove'))
    or exists (select 1 from public.permission_custom_role_items where permission_word in ('exercises.add','exercises.remove'))) then
    raise exception 'v108 found an unexpected Exercise staging or built-in role set';
  end if;
end $$;

create or replace function public.permission_word_honoured(p_word text) returns boolean
  language sql immutable set search_path = pg_catalog, public as $$
    select p_word in ('org.view', 'org.teams.manage', 'org.club.edit', 'athletes.manage', 'athletes.remove',
                      'staff.assign', 'roles.manage',
                      'athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view',
                      'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view',
                      'variables.view', 'calendar.events.manage', 'calendar.settings.manage', 'load.schedule.manage', 'load.roster.decide', 'load.estimates.manage', 'load.activities.manage', 'dashboards.manage', 'programs.rpe_settings', 'exercises.add', 'exercises.remove')
  $$;

create table library.exercise_manage_v108_use (
  singleton boolean primary key default true check (singleton),
  first_used_at timestamptz not null default clock_timestamp()
);
alter table library.exercise_manage_v108_use enable row level security;
revoke all on library.exercise_manage_v108_use from public;
create function library.keep_exercise_manage_v108_use() returns trigger
language plpgsql set search_path=pg_catalog,library as $exercise_use_guard$
begin
  raise exception 'Exercise bridge first-use evidence is immutable';
end
$exercise_use_guard$;
revoke all on function library.keep_exercise_manage_v108_use() from public;
create trigger exercise_manage_v108_keep_use
before update or delete or truncate on library.exercise_manage_v108_use
for each statement execute function library.keep_exercise_manage_v108_use();

create table library.exercise_manage_v108_seed (
  layer text not null check (layer in ('role','version','custom')),
  id uuid not null,
  revision_before integer not null,
  based_before integer,
  answered_before integer,
  updated_before timestamptz,
  words text[] not null,
  primary key (layer,id)
);
alter table library.exercise_manage_v108_seed enable row level security;
revoke all on library.exercise_manage_v108_seed from public;



insert into library.exercise_manage_v108_seed (layer,id,revision_before,updated_before,words)
select 'role',id,revision,updated_at,array['exercises.add','exercises.remove']
from public.permission_roles r where basic_key in ('club_admin','team_coach') and archived_at is null
  and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='exercises.use');

insert into library.exercise_manage_v108_seed (layer,id,revision_before,based_before,answered_before,words)
select 'version',v.id,v.revision,v.based_on_revision,v.answered_revision,s.words
from public.permission_club_role_versions v
join library.exercise_manage_v108_seed s on s.layer='role' and s.id=v.system_role_id
where v.ended_at is null
  and exists (select 1 from public.permission_club_role_version_items i where i.version_id=v.id and i.permission_word='exercises.use');

insert into library.exercise_manage_v108_seed (layer,id,revision_before,words)
select 'custom',c.id,c.revision,s.words
from public.permission_custom_roles c
join library.exercise_manage_v108_seed s on s.layer='role' and s.id=c.base_role_id
where c.ended_at is null
  and exists (select 1 from public.permission_custom_role_items i where i.custom_role_id=c.id and i.permission_word='exercises.use')
  and exists (
    select 1 from public.permission_user_holdings(c.user_id) h
    where h.custom_role_id=c.id and h.assignment_id is null and h.scope_type in ('club','team')
  );

update public.permission_roles r set revision=r.revision+1,updated_at=now()
from library.exercise_manage_v108_seed s where s.layer='role' and s.id=r.id;
insert into public.permission_role_changes (role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612101000_exercises_v108_manage_bridge.sql',words
from library.exercise_manage_v108_seed where layer='role';
insert into public.permission_role_items (role_id,permission_word)
select id,unnest(words) from library.exercise_manage_v108_seed where layer='role';

update public.permission_club_role_versions v set revision=v.revision+1,
  based_on_revision=case when s.based_before=r.revision-1 then r.revision else s.based_before end,
  answered_revision=case when s.answered_before=r.revision-1 then r.revision else s.answered_before end
from library.exercise_manage_v108_seed s,public.permission_roles r
where s.layer='version' and s.id=v.id and r.id=v.system_role_id;
insert into public.permission_club_role_version_changes (version_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612101000_exercises_v108_manage_bridge.sql',words
from library.exercise_manage_v108_seed where layer='version';
insert into public.permission_club_role_version_items (version_id,permission_word)
select id,unnest(words) from library.exercise_manage_v108_seed where layer='version';

update public.permission_custom_roles c set revision=c.revision+1
from library.exercise_manage_v108_seed s where s.layer='custom' and s.id=c.id;
insert into public.permission_custom_role_changes (custom_role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612101000_exercises_v108_manage_bridge.sql',words
from library.exercise_manage_v108_seed where layer='custom';
insert into public.permission_custom_role_items (custom_role_id,permission_word)
select id,unnest(words) from library.exercise_manage_v108_seed where layer='custom';

do $$
declare api_role text;
begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=api_role) then
      execute format('revoke all on library.exercise_manage_v108_use, library.exercise_manage_v108_seed from %I',api_role);
      execute format('revoke all on function library.keep_exercise_manage_v108_use() from %I',api_role);
    end if;
  end loop;
end $$;

-- Additive Builder RPE provenance. No legacy-owner or draft backfill.
set local lock_timeout = '5s';

select pg_advisory_xact_lock(hashtextextended('builder-rpe-provenance-v106', 0));


do $$ begin
  if not exists (select 1 from public.schema_migrations
    where migration_name='migrations_v2/202612071000_training_load_v105_dashboards_manage_bridge.sql'
      and checksum='4de3a21ecdb76ce67c34610460c087b4b3df6a9a0635bee3a7eb708a5184284d') then
    raise exception 'v106 expects the approved v105 migration record';
  end if;
  if (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))
    is distinct from '6c1e8d75e9631ca53ff0aa18bebddfd7' then
    raise exception 'v106 expects the approved v105 permission body';
  end if;
end $$;
select public.lock_club_ceiling(array(select id from public.clubs order by id), 'exclusive');

do $$ begin
  if (select count(*) from public.permission_roles where basic_key in ('club_admin','team_coach') and archived_at is null) <> 2
     or public.permission_word_honoured('programs.rpe_settings')
     or exists (select 1 from public.permission_role_items where permission_word='programs.rpe_settings')
     or exists (select 1 from public.permission_club_role_version_items where permission_word='programs.rpe_settings')
     or exists (select 1 from public.permission_custom_role_items where permission_word='programs.rpe_settings') then
    raise exception 'v106 refuses unexpected existing Builder RPE staging';
  end if;
end $$;
create or replace function public.permission_word_honoured(p_word text) returns boolean
  language sql immutable set search_path = pg_catalog, public as $$
    select p_word in ('org.view', 'org.teams.manage', 'org.club.edit', 'athletes.manage', 'athletes.remove',
                      'staff.assign', 'roles.manage',
                      'athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view',
                      'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view',
                      'variables.view', 'calendar.events.manage', 'calendar.settings.manage', 'load.schedule.manage', 'load.roster.decide', 'load.estimates.manage', 'load.activities.manage', 'dashboards.manage', 'programs.rpe_settings')
  $$;

create table training_load.builder_rpe_provenance_use (
  singleton boolean primary key default true check (singleton),
  first_used_at timestamptz not null default clock_timestamp()
);

create table training_load.builder_rpe_plan_baselines (
  plan_id uuid primary key references plans.plans(id) on delete cascade,
  origin text not null check (origin in ('created', 'edit', 'copy')),
  source_plan_id uuid,
  source_updated_at timestamptz,
  owner_scope text,
  owner_user_id uuid,
  owner_club_id uuid,
  owner_team_id uuid,
  opening_tracking boolean not null,
  opening_rpe boolean not null,
  check (opening_tracking or not opening_rpe),
  check ((origin = 'created') = (source_plan_id is null)),
  check ((source_plan_id is null) = (source_updated_at is null)),
  check (
    (coalesce(owner_scope, 'unresolved') in ('system', 'unresolved') and num_nonnulls(owner_user_id, owner_club_id, owner_team_id) = 0)
    or (coalesce(owner_scope, '') = 'user' and owner_user_id is not null and num_nonnulls(owner_user_id, owner_club_id, owner_team_id) = 1)
    or (coalesce(owner_scope, '') = 'club' and owner_club_id is not null and num_nonnulls(owner_user_id, owner_club_id, owner_team_id) = 1)
    or (coalesce(owner_scope, '') = 'team' and owner_team_id is not null and num_nonnulls(owner_user_id, owner_club_id, owner_team_id) = 1)
  )
);

create table training_load.builder_rpe_session_baselines (
  plan_id uuid not null references training_load.builder_rpe_plan_baselines(plan_id) on delete cascade,
  session_id uuid not null,
  logical_session_id uuid,
  source_plan_id uuid,
  source_session_id uuid,
  retained_from_opening boolean not null default false,
  opening_tracking boolean not null,
  opening_rpe boolean not null,
  primary key (plan_id, session_id),
  check ((source_plan_id is null) = (source_session_id is null)),
  check (not retained_from_opening or source_session_id is not null),
  check (opening_tracking or not opening_rpe)
);

create table training_load.builder_rpe_plan_effects (
  plan_id uuid primary key references training_load.builder_rpe_plan_baselines(plan_id) on delete cascade,
  changed_tracking boolean not null,
  changed_rpe boolean not null,
  effective_tracking boolean not null,
  effective_rpe boolean not null,
  check (changed_tracking or changed_rpe),
  check (effective_tracking or not effective_rpe)
);

create table training_load.builder_rpe_session_effects (
  plan_id uuid not null,
  session_id uuid not null,
  changed_tracking boolean not null,
  changed_rpe boolean not null,
  effective_tracking boolean not null,
  effective_rpe boolean not null,
  primary key (plan_id, session_id),
  foreign key (plan_id, session_id) references training_load.builder_rpe_session_baselines(plan_id, session_id) on delete cascade,
  check (changed_tracking or changed_rpe),
  check (effective_tracking or not effective_rpe)
);

revoke all on training_load.builder_rpe_provenance_use, training_load.builder_rpe_plan_baselines,
  training_load.builder_rpe_session_baselines, training_load.builder_rpe_plan_effects,
  training_load.builder_rpe_session_effects from public;

create table training_load.builder_rpe_v106_seed (
  layer text not null check (layer in ('role','version','custom')),
  id uuid not null,
  revision_before integer not null,
  based_before integer,
  answered_before integer,
  updated_before timestamptz,
  words text[] not null,
  primary key (layer,id)
);
alter table training_load.builder_rpe_v106_seed enable row level security;
revoke all on training_load.builder_rpe_v106_seed from public;



insert into training_load.builder_rpe_v106_seed (layer,id,revision_before,updated_before,words)
select 'role',id,revision,updated_at,array['programs.rpe_settings']
from public.permission_roles where basic_key in ('club_admin','team_coach');

insert into training_load.builder_rpe_v106_seed (layer,id,revision_before,based_before,answered_before,words)
select 'version',v.id,v.revision,v.based_on_revision,v.answered_revision,s.words
from public.permission_club_role_versions v
join training_load.builder_rpe_v106_seed s on s.layer='role' and s.id=v.system_role_id
where v.ended_at is null;

insert into training_load.builder_rpe_v106_seed (layer,id,revision_before,words)
select 'custom',c.id,c.revision,s.words
from public.permission_custom_roles c
join training_load.builder_rpe_v106_seed s on s.layer='role' and s.id=c.base_role_id
where c.ended_at is null
  and exists (
    select 1 from public.permission_user_holdings(c.user_id) h
    where h.custom_role_id=c.id and h.assignment_id is null and h.scope_type in ('club','team')
  );

update public.permission_roles r set revision=r.revision+1,updated_at=now()
from training_load.builder_rpe_v106_seed s where s.layer='role' and s.id=r.id;
insert into public.permission_role_changes (role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612081000_training_load_v106_builder_rpe_provenance.sql',words
from training_load.builder_rpe_v106_seed where layer='role';
insert into public.permission_role_items (role_id,permission_word)
select id,unnest(words) from training_load.builder_rpe_v106_seed where layer='role';

update public.permission_club_role_versions v set revision=v.revision+1,
  based_on_revision=case when s.based_before=r.revision-1 then r.revision else s.based_before end,
  answered_revision=case when s.answered_before=r.revision-1 then r.revision else s.answered_before end
from training_load.builder_rpe_v106_seed s,public.permission_roles r
where s.layer='version' and s.id=v.id and r.id=v.system_role_id;
insert into public.permission_club_role_version_changes (version_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612081000_training_load_v106_builder_rpe_provenance.sql',words
from training_load.builder_rpe_v106_seed where layer='version';
insert into public.permission_club_role_version_items (version_id,permission_word)
select id,unnest(words) from training_load.builder_rpe_v106_seed where layer='version';

update public.permission_custom_roles c set revision=c.revision+1
from training_load.builder_rpe_v106_seed s where s.layer='custom' and s.id=c.id;
insert into public.permission_custom_role_changes (custom_role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612081000_training_load_v106_builder_rpe_provenance.sql',words
from training_load.builder_rpe_v106_seed where layer='custom';
insert into public.permission_custom_role_items (custom_role_id,permission_word)
select id,unnest(words) from training_load.builder_rpe_v106_seed where layer='custom';

do $$
declare
  object_name text;
  api_role text;
begin
  foreach object_name in array array['builder_rpe_provenance_use','builder_rpe_plan_baselines','builder_rpe_session_baselines',
    'builder_rpe_plan_effects','builder_rpe_session_effects','builder_rpe_v106_seed'] loop
    execute format('alter table training_load.%I enable row level security',object_name);
    foreach api_role in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=api_role) then
        execute format('revoke all on training_load.%I from %I',object_name,api_role);
      end if;
    end loop;
  end loop;
end $$;

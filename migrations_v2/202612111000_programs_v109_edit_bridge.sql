-- Programs Edit staging preserves existing program ownership and the separate assignment/publication rules.
set local lock_timeout='5s';
select pg_advisory_xact_lock(hashtextextended('program-edit-v109',0));
select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive');
lock table public.permission_roles, public.permission_role_items, public.permission_role_changes,
  public.permission_club_role_versions, public.permission_club_role_version_items, public.permission_club_role_version_changes,
  public.permission_custom_roles, public.permission_custom_role_items, public.permission_custom_role_changes in share row exclusive mode;

do $$ begin
  if not exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612101000_exercises_v108_manage_bridge.sql' and checksum='e277b4107b72c3c423692ca1f687cc0ea10e3dab83f7b1b3af2321e71c68e3c2') or exists (select 1 from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612101000_exercises_v108_manage_bridge.sql') then
    raise exception 'v109 expects the exact v108 registry predecessor';
  end if;
  if (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)')) is distinct from '2a01ec9e027967a44892fc0f2fb6202d' then
    raise exception 'v109 expects the approved permission evaluator';
  end if;
  if (select count(*) from public.permission_roles r where basic_key in ('club_admin','team_coach') and archived_at is null
        and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='programs.view')) <> 2
     or (exists (select 1 from public.permission_role_items where permission_word in ('programs.edit'))
    or exists (select 1 from public.permission_club_role_version_items where permission_word in ('programs.edit'))
    or exists (select 1 from public.permission_custom_role_items where permission_word in ('programs.edit'))) then
    raise exception 'v109 found an unexpected Programs Edit staging or built-in role set';
  end if;
end $$;

create or replace function public.permission_word_honoured(p_word text) returns boolean
  language sql immutable set search_path = pg_catalog, public as $$
    select p_word in ('org.view', 'org.teams.manage', 'org.club.edit', 'athletes.manage', 'athletes.remove',
                      'staff.assign', 'roles.manage',
                      'athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view',
                      'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view',
                      'variables.view', 'calendar.events.manage', 'calendar.settings.manage', 'load.schedule.manage', 'load.roster.decide', 'load.estimates.manage', 'load.activities.manage', 'dashboards.manage', 'programs.rpe_settings', 'exercises.add', 'exercises.remove', 'programs.edit')
  $$;

create table plans.program_manage_v109_use (
  singleton boolean primary key default true check (singleton),
  first_used_at timestamptz not null default clock_timestamp()
);
alter table plans.program_manage_v109_use enable row level security;
revoke all on plans.program_manage_v109_use from public;
create function plans.keep_program_manage_v109_use() returns trigger
language plpgsql set search_path=pg_catalog,plans as $exercise_use_guard$
begin
  raise exception 'Program Edit bridge first-use evidence is immutable';
end
$exercise_use_guard$;
revoke all on function plans.keep_program_manage_v109_use() from public;
create trigger program_manage_v109_keep_use
before update or delete or truncate on plans.program_manage_v109_use
for each statement execute function plans.keep_program_manage_v109_use();

create table plans.program_manage_v109_seed (
  layer text not null check (layer in ('role','version','custom')),
  id uuid not null,
  revision_before integer not null,
  based_before integer,
  answered_before integer,
  updated_before timestamptz,
  words text[] not null,
  primary key (layer,id)
);
alter table plans.program_manage_v109_seed enable row level security;
revoke all on plans.program_manage_v109_seed from public;



insert into plans.program_manage_v109_seed (layer,id,revision_before,updated_before,words)
select 'role',id,revision,updated_at,array['programs.edit']
from public.permission_roles r where basic_key in ('club_admin','team_coach') and archived_at is null
  and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='programs.view');

insert into plans.program_manage_v109_seed (layer,id,revision_before,based_before,answered_before,words)
select 'version',v.id,v.revision,v.based_on_revision,v.answered_revision,s.words
from public.permission_club_role_versions v
join plans.program_manage_v109_seed s on s.layer='role' and s.id=v.system_role_id
where v.ended_at is null
  and exists (select 1 from public.permission_club_role_version_items i where i.version_id=v.id and i.permission_word='programs.view');

insert into plans.program_manage_v109_seed (layer,id,revision_before,words)
select 'custom',c.id,c.revision,s.words
from public.permission_custom_roles c
join plans.program_manage_v109_seed s on s.layer='role' and s.id=c.base_role_id
where c.ended_at is null
  and exists (select 1 from public.permission_custom_role_items i where i.custom_role_id=c.id and i.permission_word='programs.view')
  and exists (
    select 1 from public.permission_user_holdings(c.user_id) h
    where h.custom_role_id=c.id and h.assignment_id is null and h.scope_type in ('club','team')
  );

update public.permission_roles r set revision=r.revision+1,updated_at=now()
from plans.program_manage_v109_seed s where s.layer='role' and s.id=r.id;
insert into public.permission_role_changes (role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612111000_programs_v109_edit_bridge.sql',words
from plans.program_manage_v109_seed where layer='role';
insert into public.permission_role_items (role_id,permission_word)
select id,unnest(words) from plans.program_manage_v109_seed where layer='role';

update public.permission_club_role_versions v set revision=v.revision+1,
  based_on_revision=case when s.based_before=r.revision-1 then r.revision else s.based_before end,
  answered_revision=case when s.answered_before=r.revision-1 then r.revision else s.answered_before end
from plans.program_manage_v109_seed s,public.permission_roles r
where s.layer='version' and s.id=v.id and r.id=v.system_role_id;
insert into public.permission_club_role_version_changes (version_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612111000_programs_v109_edit_bridge.sql',words
from plans.program_manage_v109_seed where layer='version';
insert into public.permission_club_role_version_items (version_id,permission_word)
select id,unnest(words) from plans.program_manage_v109_seed where layer='version';

update public.permission_custom_roles c set revision=c.revision+1
from plans.program_manage_v109_seed s where s.layer='custom' and s.id=c.id;
insert into public.permission_custom_role_changes (custom_role_id,revision_after,kind,migration_name,items_added)
select id,revision_before+1,'migration','migrations_v2/202612111000_programs_v109_edit_bridge.sql',words
from plans.program_manage_v109_seed where layer='custom';
insert into public.permission_custom_role_items (custom_role_id,permission_word)
select id,unnest(words) from plans.program_manage_v109_seed where layer='custom';

-- Separate proof preserves the legacy receipt payload returned during rollout.
create table plans.program_edit_v109_assignment_evidence (
  request_id uuid primary key references public.builder_assignment_requests(id) on delete cascade,
  edited_plan_ids uuid[] not null,
  removed_plan_ids uuid[] not null,
  scope_type text not null check (scope_type in ('club','team','private_coach','platform')),
  scope_id uuid,
  check ((scope_type in ('club','team')) = (scope_id is not null)),
  check (coalesce(array_ndims(edited_plan_ids),1)=1 and coalesce(array_ndims(removed_plan_ids),1)=1),
  check (array_position(edited_plan_ids,null) is null and array_position(removed_plan_ids,null) is null),
  check (not (edited_plan_ids && removed_plan_ids))
);
alter table plans.program_edit_v109_assignment_evidence enable row level security;
revoke all on plans.program_edit_v109_assignment_evidence from public;
create function plans.keep_program_edit_v109_assignment_evidence() returns trigger
language plpgsql set search_path=pg_catalog,plans as $assignment_evidence_guard$
begin
  if tg_op = 'DELETE' then
    -- The receipt's existing cascade removes orphaned evidence. A direct
    -- delete cannot take evidence away from any surviving receipt.
    if not exists (select 1 from public.builder_assignment_requests where id=old.request_id) then
      return old;
    end if;
  end if;
  raise exception 'Program Edit assignment evidence is immutable';
end
$assignment_evidence_guard$;
revoke all on function plans.keep_program_edit_v109_assignment_evidence() from public;
create trigger program_edit_v109_assignment_evidence_keep_row
before update or delete on plans.program_edit_v109_assignment_evidence
for each row execute function plans.keep_program_edit_v109_assignment_evidence();
create trigger program_edit_v109_assignment_evidence_keep_truncate
before truncate on plans.program_edit_v109_assignment_evidence
for each statement execute function plans.keep_program_edit_v109_assignment_evidence();

do $$
declare api_role text;
begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=api_role) then
      execute format('revoke all on plans.program_manage_v109_use, plans.program_manage_v109_seed, plans.program_edit_v109_assignment_evidence from %I',api_role);
      execute format('revoke all on function plans.keep_program_manage_v109_use(), plans.keep_program_edit_v109_assignment_evidence() from %I',api_role);
    end if;
  end loop;
end $$;

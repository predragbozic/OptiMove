-- Only before bridge use and exposure. Drain the bridge and older writers first.
begin;
set local lock_timeout='5s';
do $$ begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v109 rollback refused: the migrator is running';
  end if;
end $$;
select pg_advisory_xact_lock(hashtextextended('program-edit-v109',0));
select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive');
lock table plans.program_manage_v109_use, public.permission_roles, public.permission_role_items, public.permission_role_changes,
  public.permission_club_role_versions, public.permission_club_role_version_items, public.permission_club_role_version_changes,
  public.permission_custom_roles, public.permission_custom_role_items, public.permission_custom_role_changes in share row exclusive mode;
do $$
declare v_applied timestamptz;
begin
  select applied_at into v_applied from public.schema_migrations where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql' and checksum='232de3919373123f6e79dd89550f0d4ec65a164d10158ec02b0cbab7243ebce3';
  if v_applied is null or exists (select 1 from public.schema_migrations where migration_name<>'migrations_v2/202612111000_programs_v109_edit_bridge.sql' and migration_name ~ '^migrations_v2/[0-9]{12}_' and (applied_at>=v_applied or migration_name>'migrations_v2/202612111000_programs_v109_edit_bridge.sql')) then
    raise exception 'v109 rollback refused: v109 is missing, its checksum changed, or a later migration is recorded';
  end if;
  if exists (select 1 from plans.program_manage_v109_use) then
    raise exception 'v109 rollback refuses checked Programs Edit writer use';
  end if;
  if ((select t.tgenabled from pg_trigger t
        where t.tgrelid='plans.program_manage_v109_use'::regclass
          and t.tgname='program_manage_v109_keep_use'
          and t.tgfoid=to_regprocedure('plans.keep_program_manage_v109_use()')) = 'O'
       and (select md5(prosrc) from pg_proc
         where oid=to_regprocedure('plans.keep_program_manage_v109_use()'))='f2c169e3ad3329bc06a24d4270c8e924') is distinct from true then
    raise exception 'v109 rollback refused: first-use evidence guard changed';
  end if;
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.permission_word_honoured(text)')) is distinct from '087f01e9188b2a8a16e3f748addba19f' then
    raise exception 'v109 rollback refused: the permission body changed';
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
    raise exception 'v109 rollback refused: an audited trigger is missing or disabled';
  end if;
  if exists (
    select 1 from plans.program_manage_v109_seed s
    left join public.permission_roles r on s.layer='role' and r.id=s.id
    left join public.permission_club_role_versions v on s.layer='version' and v.id=s.id
    left join public.permission_custom_roles c on s.layer='custom' and c.id=s.id
    left join public.permission_roles vr on vr.id=v.system_role_id
    where coalesce(r.revision,v.revision,c.revision) is distinct from s.revision_before+1
       or (s.layer='version' and (v.ended_at is not null
           or v.based_on_revision is distinct from (case when s.based_before=vr.revision-1 then vr.revision else s.based_before end)
           or v.answered_revision is distinct from (case when s.answered_before=vr.revision-1 then vr.revision else s.answered_before end)))
       or (s.layer='custom' and c.ended_at is not null)
  ) then
    raise exception 'v109 rollback refused: a seeded layer changed';
  end if;
  if exists (
    with expected as (select layer,id,unnest(words) as word from plans.program_manage_v109_seed),
    actual as (
      select 'role' as layer,role_id as id,permission_word as word from public.permission_role_items
      union all select 'version',version_id,permission_word from public.permission_club_role_version_items
      union all select 'custom',custom_role_id,permission_word from public.permission_custom_role_items
    ), changes as (
      (select * from expected except select * from actual)
      union all
      (select * from actual where word in ('programs.edit') except select * from expected)
    ) select 1 from changes
  ) then
    raise exception 'v109 rollback refused: Programs Edit permission grants changed';
  end if;
  if exists (
    select 1 from plans.program_manage_v109_seed s
    full join (
      select 'role' as layer,role_id as id,revision_after,items_added from public.permission_role_changes where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql'
      union all select 'version',version_id,revision_after,items_added from public.permission_club_role_version_changes where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql'
      union all select 'custom',custom_role_id,revision_after,items_added from public.permission_custom_role_changes where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql'
    ) a using(layer,id)
    where a.revision_after is distinct from s.revision_before+1 or a.items_added is distinct from s.words
  ) then
    raise exception 'v109 rollback refused: a staged audit entry changed';
  end if;
  -- Native membership and R4 assignment rows are independent of the staged permission items.
  -- Neither their grant nor their removal is reversed by this rollback.

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

delete from public.permission_role_items i using plans.program_manage_v109_seed s
where s.layer='role' and i.role_id=s.id and i.permission_word=any(s.words);
delete from public.permission_club_role_version_items i using plans.program_manage_v109_seed s
where s.layer='version' and i.version_id=s.id and i.permission_word=any(s.words);
delete from public.permission_custom_role_items i using plans.program_manage_v109_seed s
where s.layer='custom' and i.custom_role_id=s.id and i.permission_word=any(s.words);

delete from public.permission_role_changes where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql';
delete from public.permission_club_role_version_changes where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql';
delete from public.permission_custom_role_changes where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql';

update public.permission_roles r set revision=s.revision_before,updated_at=s.updated_before
from plans.program_manage_v109_seed s where s.layer='role' and r.id=s.id;
update public.permission_club_role_versions v set revision=s.revision_before,based_on_revision=s.based_before,answered_revision=s.answered_before
from plans.program_manage_v109_seed s where s.layer='version' and v.id=s.id;
update public.permission_custom_roles c set revision=s.revision_before
from plans.program_manage_v109_seed s where s.layer='custom' and c.id=s.id;
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

create or replace function public.permission_word_honoured(p_word text) returns boolean
  language sql immutable set search_path = pg_catalog, public as $$
    select p_word in ('org.view', 'org.teams.manage', 'org.club.edit', 'athletes.manage', 'athletes.remove',
                      'staff.assign', 'roles.manage',
                      'athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view',
                      'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view',
                      'variables.view', 'calendar.events.manage', 'calendar.settings.manage', 'load.schedule.manage', 'load.roster.decide', 'load.estimates.manage', 'load.activities.manage', 'dashboards.manage', 'programs.rpe_settings', 'exercises.add', 'exercises.remove')
  $$;

do $$ begin
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
    raise exception 'v109 rollback refused: an audited trigger was not restored';
  end if;
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.permission_word_honoured(text)')) is distinct from '2a01ec9e027967a44892fc0f2fb6202d' then
    raise exception 'v109 rollback refused: original body restoration differs';
  end if;
end $$;
drop table plans.program_manage_v109_use, plans.program_manage_v109_seed;
drop function plans.keep_program_manage_v109_use();
delete from public.schema_migrations where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql' and checksum='232de3919373123f6e79dd89550f0d4ec65a164d10158ec02b0cbab7243ebce3';
commit;

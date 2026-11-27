-- Read-only. Require the reviewed release sequence, not a local predecessor guess.
select exists (
  select 1 from public.schema_migrations
  where migration_name = 'migrations_v2/202612071000_training_load_v105_dashboards_manage_bridge.sql'
    and checksum = '4de3a21ecdb76ce67c34610460c087b4b3df6a9a0635bee3a7eb708a5184284d'
) as v105_exact,
not exists (
  select 1 from public.schema_migrations where migration_name like 'migrations_v2/202612081000_%'
) as v106_prefix_unused,
to_regclass('training_load.builder_rpe_provenance_use') is null as marker_absent,
to_regclass('training_load.plan_workspace_ownership') is not null as ownership_present,
(select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='6c1e8d75e9631ca53ff0aa18bebddfd7' as permission_body_exact,
not public.permission_word_honoured('programs.rpe_settings') as word_unstaged,
not exists(select 1 from public.permission_role_items where permission_word='programs.rpe_settings')
and not exists(select 1 from public.permission_club_role_version_items where permission_word='programs.rpe_settings')
and not exists(select 1 from public.permission_custom_role_items where permission_word='programs.rpe_settings') as grants_unstaged;

select owner_scope,count(*) from training_load.plan_workspace_ownership group by owner_scope order by owner_scope;
select count(*) as unclassified_open_drafts
from plans.plans p left join training_load.plan_workspace_ownership o on o.plan_id=p.id
where p.status='draft' and (o.plan_id is null or o.owner_scope='unresolved');

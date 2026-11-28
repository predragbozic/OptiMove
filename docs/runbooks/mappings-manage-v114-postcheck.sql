-- Read-only.
select (select count(*) from public.schema_migrations where migration_name='migrations_v2/202612161000_training_load_v114_mappings_manage_bridge.sql'
         and checksum='7eefcd2204babab96633ff69905405349fa9eadb9ce19643670879ebf603dbfb')=1 as v114_exact,
       (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='5049fee9f1790dee54fc174de2d0c058' as permission_body_exact,
       public.permission_word_honoured('variables.view') and public.permission_word_honoured('mappings.manage')
         and public.permission_word_honoured('tests.schedule.manage') and public.permission_word_honoured('variables.rename_archive')
         and public.permission_word_honoured('variables.manage') and not public.permission_word_honoured('sources.connect') as required_words_staged,
       to_regclass('plans.program_manage_v109_use') is not null
         and to_regclass('plans.program_assign_publish_v110_use') is not null
         and to_regclass('tests.schedule_manage_bridge_use') is not null and to_regclass('training_load.variable_rename_archive_v112_use') is not null
         and to_regclass('training_load.variables_manage_v113_use') is not null as prior_staging_evidence_preserved,
       ((select count(*)=2 from pg_trigger t
        where t.tgrelid='training_load.mappings_manage_bridge_use'::regclass
          and t.tgname in ('mappings_manage_v114_keep_use','mappings_manage_v114_keep_use_truncate')
          and t.tgenabled='O'
          and t.tgfoid=to_regprocedure('training_load.keep_mappings_manage_bridge_use()'))
       and (select md5(prosrc) from pg_proc
         where oid=to_regprocedure('training_load.keep_mappings_manage_bridge_use()'))='85acb99dd33fe5afbcc626aaf37ed682') as first_use_guard_exact,
       (select count(*)=1 and bool_and(first_checked_write_at is null) from training_load.mappings_manage_bridge_use) as unused,
       (select bool_and(relrowsecurity) from pg_class where oid in (
         'training_load.mappings_manage_bridge_use'::regclass,'training_load.mappings_manage_v114_seed'::regclass
       )) as bridge_rls_enabled,
       not exists (
         with expected as (select layer,id,unnest(words) as word from training_load.mappings_manage_v114_seed),
         actual as (
           select 'role' as layer,role_id as id,permission_word as word from public.permission_role_items
           union all select 'version',version_id,permission_word from public.permission_club_role_version_items
           union all select 'custom',custom_role_id,permission_word from public.permission_custom_role_items
         )
         (select * from expected except select * from actual)
         union all
         (select * from actual where word = 'mappings.manage' except select * from expected)
       ) as seeded_items_exact,
       not exists (
         with audit as (
           select 'role' as layer,role_id as id,revision_after,items_added from public.permission_role_changes
           where migration_name='migrations_v2/202612161000_training_load_v114_mappings_manage_bridge.sql'
           union all select 'version',version_id,revision_after,items_added from public.permission_club_role_version_changes
           where migration_name='migrations_v2/202612161000_training_load_v114_mappings_manage_bridge.sql'
           union all select 'custom',custom_role_id,revision_after,items_added from public.permission_custom_role_changes
           where migration_name='migrations_v2/202612161000_training_load_v114_mappings_manage_bridge.sql'
         )
         select 1 from training_load.mappings_manage_v114_seed s full join audit a using(layer,id)
         where a.revision_after is distinct from s.revision_before+1 or a.items_added is distinct from s.words
       ) as seeded_audit_exact;
select layer,count(*) from training_load.mappings_manage_v114_seed group by layer order by layer;

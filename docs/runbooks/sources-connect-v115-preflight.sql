-- Read-only. Pin the previous deployed build independently.
select exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612161000_training_load_v114_mappings_manage_bridge.sql' and checksum='7eefcd2204babab96633ff69905405349fa9eadb9ce19643670879ebf603dbfb') as v114_exact,
       not exists (select 1 from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612161000_training_load_v114_mappings_manage_bridge.sql') as registry_matches,
       (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='5049fee9f1790dee54fc174de2d0c058' as permission_body_exact,
       (select count(*) from public.permission_roles r where basic_key='club_admin' and archived_at is null)=1 as exact_native_seed_roles,
       not (exists (select 1 from public.permission_role_items where permission_word = 'sources.connect')
    or exists (select 1 from public.permission_club_role_version_items where permission_word = 'sources.connect')
    or exists (select 1 from public.permission_custom_role_items where permission_word = 'sources.connect')) as mappings_manage_items_unstaged,
       public.permission_word_honoured('variables.view') and public.permission_word_honoured('programs.assign')
         and public.permission_word_honoured('programs.publish') and public.permission_word_honoured('tests.schedule.manage')
         and public.permission_word_honoured('variables.rename_archive')
         and public.permission_word_honoured('variables.manage')
         and public.permission_word_honoured('mappings.manage') and not public.permission_word_honoured('sources.connect') as exact_prior_words,
       to_regclass('plans.program_manage_v109_use') is not null
         and to_regclass('plans.program_assign_publish_v110_use') is not null
         and to_regclass('tests.schedule_manage_bridge_use') is not null and to_regclass('training_load.variable_rename_archive_v112_use') is not null
         and to_regclass('training_load.variables_manage_v113_use') is not null
         and to_regclass('training_load.mappings_manage_bridge_use') is not null as prior_staging_evidence_present,
       to_regclass('training_load.sources_connect_local_bridge_use') is null
         and to_regclass('training_load.sources_connect_v115_seed') is null as bridge_tables_absent;

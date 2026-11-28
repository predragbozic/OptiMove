-- Read-only. Pin the previous deployed build independently.
select exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612141000_training_load_v112_variable_rename_archive_bridge.sql' and checksum='f7a99f8e9242a681276076e444dfb5c2b4180384216a87ec9dcfefe0706c33d2') as v112_exact,
       not exists (select 1 from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612141000_training_load_v112_variable_rename_archive_bridge.sql') as registry_matches,
       (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='3b1a627d31c6f0c6ab97453d0dc25f07' as permission_body_exact,
       (select count(*) from public.permission_roles r where basic_key='club_admin' and archived_at is null
         and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='variables.view'))=1 as exact_native_seed_roles,
       not (exists (select 1 from public.permission_role_items where permission_word = 'variables.manage')
    or exists (select 1 from public.permission_club_role_version_items where permission_word = 'variables.manage')
    or exists (select 1 from public.permission_custom_role_items where permission_word = 'variables.manage')) as variables_manage_items_unstaged,
       public.permission_word_honoured('variables.view') and public.permission_word_honoured('programs.assign')
         and public.permission_word_honoured('programs.publish') and public.permission_word_honoured('tests.schedule.manage')
         and public.permission_word_honoured('variables.rename_archive')
         and not public.permission_word_honoured('variables.manage') as exact_prior_words,
       to_regclass('plans.program_manage_v109_use') is not null
         and to_regclass('plans.program_assign_publish_v110_use') is not null
         and to_regclass('tests.schedule_manage_bridge_use') is not null and to_regclass('training_load.variable_rename_archive_v112_use') is not null as prior_staging_evidence_present,
       to_regclass('training_load.variables_manage_v113_use') is null
         and to_regclass('training_load.variables_manage_v113_seed') is null as bridge_tables_absent;

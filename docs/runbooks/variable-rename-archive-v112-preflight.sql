-- Read-only. Pin the previous deployed build independently.
select exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612131000_tests_v111_schedule_manage_bridge.sql' and checksum='822f6cc61c51aa66bf48639e9d577439d83d38b8b18efe8b7b41a5bd323f2cf3') as v111_exact,
       not exists (select 1 from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612131000_tests_v111_schedule_manage_bridge.sql') as registry_matches,
       (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='a09af1e41b096da583fbaf04727fe992' as permission_body_exact,
       (select count(*) from public.permission_roles r where basic_key in ('club_admin','team_coach') and archived_at is null
         and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='variables.view'))=2 as exact_native_seed_roles,
       not (exists (select 1 from public.permission_role_items where permission_word = 'variables.rename_archive')
    or exists (select 1 from public.permission_club_role_version_items where permission_word = 'variables.rename_archive')
    or exists (select 1 from public.permission_custom_role_items where permission_word = 'variables.rename_archive')) as rename_archive_items_unstaged,
       public.permission_word_honoured('variables.view') and public.permission_word_honoured('programs.assign')
         and public.permission_word_honoured('programs.publish') and public.permission_word_honoured('tests.schedule.manage')
         and not public.permission_word_honoured('variables.rename_archive') as exact_prior_words,
       to_regclass('plans.program_manage_v109_use') is not null
         and to_regclass('plans.program_assign_publish_v110_use') is not null
         and to_regclass('tests.schedule_manage_bridge_use') is not null as prior_staging_evidence_present,
       to_regclass('training_load.variable_rename_archive_v112_use') is null
         and to_regclass('training_load.variable_rename_archive_v112_seed') is null as bridge_tables_absent;

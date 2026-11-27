-- Read-only. Pin the previous deployed build independently.
select exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612121000_programs_v110_assign_publish_bridge.sql' and checksum='43a36a33128afb57f97f02767f7fd7d49743c4958fd10e774fc9b3f3a95f0cfd') as v110_exact,
       not exists (select 1 from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612121000_programs_v110_assign_publish_bridge.sql') as registry_matches,
       (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='3fdbf46bdba6bd0a209e26fc1bf7fcb2' as permission_body_exact,
       (select count(*) from public.permission_roles r where basic_key in ('club_admin','team_coach') and archived_at is null
         and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='tests.view'))=2 as exact_native_seed_roles,
       not (exists (select 1 from public.permission_role_items where permission_word = 'tests.schedule.manage')
    or exists (select 1 from public.permission_club_role_version_items where permission_word = 'tests.schedule.manage')
    or exists (select 1 from public.permission_custom_role_items where permission_word = 'tests.schedule.manage')) as schedule_manage_items_unstaged,
       public.permission_word_honoured('tests.view') and public.permission_word_honoured('programs.assign')
         and public.permission_word_honoured('programs.publish') and not public.permission_word_honoured('tests.schedule.manage') as exact_prior_words,
       to_regclass('plans.program_manage_v109_use') is not null
         and to_regclass('plans.program_assign_publish_v110_use') is not null as prior_programs_evidence_present,
       to_regclass('tests.schedule_manage_bridge_use') is null
         and to_regclass('tests.schedule_manage_v111_seed') is null as bridge_tables_absent;

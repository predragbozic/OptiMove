-- Read-only. Pin the previous deployed build independently.
select exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql' and checksum='d18d03b6bdfaae33fe6481e4b9a44187ebcf763741b994f1ad473fd2a654d764') as v109_exact,
       not exists (select 1 from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612111000_programs_v109_edit_bridge.sql') as registry_matches,
       (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='087f01e9188b2a8a16e3f748addba19f' as permission_body_exact,
       (select count(*) from public.permission_roles r where basic_key in ('club_admin','team_coach') and archived_at is null
         and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='programs.view'))=2 as exact_native_seed_roles,
       not (exists (select 1 from public.permission_role_items where permission_word in ('programs.assign','programs.publish'))
    or exists (select 1 from public.permission_club_role_version_items where permission_word in ('programs.assign','programs.publish'))
    or exists (select 1 from public.permission_custom_role_items where permission_word in ('programs.assign','programs.publish'))) as assign_publish_items_unstaged,
       public.permission_word_honoured('programs.edit')
         and not public.permission_word_honoured('programs.assign')
         and not public.permission_word_honoured('programs.publish') as exact_prior_words,
       to_regclass('plans.program_manage_v109_use') is not null
         and to_regclass('plans.program_edit_v109_assignment_evidence') is not null as prior_edit_evidence_present,
       to_regclass('plans.program_assign_publish_v110_use') is null
         and to_regclass('plans.program_assign_publish_v110_seed') is null as bridge_tables_absent;

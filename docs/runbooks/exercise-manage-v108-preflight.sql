-- Read-only. Pin the previous deployed build independently.
select exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612091000_training_load_v107_builder_rpe_copy_attestation.sql' and checksum='7f1f42e052681532a7ce6860f184013ca21490006ff58d3baecf154c24f93f9f') as v107_exact,
       not exists (select 1 from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612091000_training_load_v107_builder_rpe_copy_attestation.sql') as registry_matches,
       (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='ab3c43d4a319567b7f208305a1097fd3' as permission_body_exact,
       (select count(*) from public.permission_roles r where basic_key in ('club_admin','team_coach') and archived_at is null
         and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='exercises.use'))=2 as exact_native_seed_roles,
       not (exists (select 1 from public.permission_role_items where permission_word in ('exercises.add','exercises.remove'))
    or exists (select 1 from public.permission_club_role_version_items where permission_word in ('exercises.add','exercises.remove'))
    or exists (select 1 from public.permission_custom_role_items where permission_word in ('exercises.add','exercises.remove'))) as exercise_items_unstaged,
       not public.permission_word_honoured('exercises.add')
         and not public.permission_word_honoured('exercises.remove') as words_unstaged,
       to_regclass('library.exercise_manage_v108_use') is null
         and to_regclass('library.exercise_manage_v108_seed') is null as bridge_tables_absent;

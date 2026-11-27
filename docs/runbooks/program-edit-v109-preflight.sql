-- Read-only. Pin the previous deployed build independently.
select exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612101000_exercises_v108_manage_bridge.sql' and checksum='e277b4107b72c3c423692ca1f687cc0ea10e3dab83f7b1b3af2321e71c68e3c2') as v108_exact,
       not exists (select 1 from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612101000_exercises_v108_manage_bridge.sql') as registry_matches,
       (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='2a01ec9e027967a44892fc0f2fb6202d' as permission_body_exact,
       (select count(*) from public.permission_roles r where basic_key in ('club_admin','team_coach') and archived_at is null
         and exists (select 1 from public.permission_role_items i where i.role_id=r.id and i.permission_word='programs.view'))=2 as exact_native_seed_roles,
       not (exists (select 1 from public.permission_role_items where permission_word in ('programs.edit'))
    or exists (select 1 from public.permission_club_role_version_items where permission_word in ('programs.edit'))
    or exists (select 1 from public.permission_custom_role_items where permission_word in ('programs.edit'))) as edit_items_unstaged,
       not public.permission_word_honoured('programs.edit')
         and not public.permission_word_honoured('programs.assign')
         and not public.permission_word_honoured('programs.publish') as words_unstaged,
       to_regclass('plans.program_manage_v109_use') is null
         and to_regclass('plans.program_manage_v109_seed') is null
         and to_regclass('plans.program_edit_v109_assignment_evidence') is null as bridge_tables_absent;

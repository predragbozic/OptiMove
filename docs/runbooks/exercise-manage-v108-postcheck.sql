-- Read-only.
select (select count(*) from public.schema_migrations where migration_name='migrations_v2/202612101000_exercises_v108_manage_bridge.sql'
         and checksum='ea17315e20c3dc3ae9fc500be666b42f79c9d3000dbeebee8267d37c7d7b6f9a')=1 as v108_exact,
       (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='2a01ec9e027967a44892fc0f2fb6202d' as permission_body_exact,
       public.permission_word_honoured('exercises.add') and public.permission_word_honoured('exercises.remove')
         and not public.permission_word_honoured('exercises.media.upload') as exact_exercise_stage,
       not exists(select 1 from library.exercise_manage_v108_use) as unused,
       (select bool_and(relrowsecurity) from pg_class where oid in (
         'library.exercise_manage_v108_use'::regclass,'library.exercise_manage_v108_seed'::regclass
       )) as bridge_rls_enabled,
       not exists (
         with expected as (select layer,id,unnest(words) as word from library.exercise_manage_v108_seed),
         actual as (
           select 'role' as layer,role_id as id,permission_word as word from public.permission_role_items
           union all select 'version',version_id,permission_word from public.permission_club_role_version_items
           union all select 'custom',custom_role_id,permission_word from public.permission_custom_role_items
         )
         (select * from expected except select * from actual)
         union all
         (select * from actual where word in ('exercises.add','exercises.remove') except select * from expected)
       ) as seeded_items_exact,
       not exists (
         with audit as (
           select 'role' as layer,role_id as id,revision_after,items_added from public.permission_role_changes
           where migration_name='migrations_v2/202612101000_exercises_v108_manage_bridge.sql'
           union all select 'version',version_id,revision_after,items_added from public.permission_club_role_version_changes
           where migration_name='migrations_v2/202612101000_exercises_v108_manage_bridge.sql'
           union all select 'custom',custom_role_id,revision_after,items_added from public.permission_custom_role_changes
           where migration_name='migrations_v2/202612101000_exercises_v108_manage_bridge.sql'
         )
         select 1 from library.exercise_manage_v108_seed s full join audit a using(layer,id)
         where a.revision_after is distinct from s.revision_before+1 or a.items_added is distinct from s.words
       ) as seeded_audit_exact;
select layer,count(*) from library.exercise_manage_v108_seed group by layer order by layer;

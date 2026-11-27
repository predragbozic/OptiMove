-- Read-only.
select (select count(*) from public.schema_migrations where migration_name='migrations_v2/202612121000_programs_v110_assign_publish_bridge.sql'
         and checksum='43a36a33128afb57f97f02767f7fd7d49743c4958fd10e774fc9b3f3a95f0cfd')=1 as v110_exact,
       (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='3fdbf46bdba6bd0a209e26fc1bf7fcb2' as permission_body_exact,
       public.permission_word_honoured('programs.edit') and public.permission_word_honoured('programs.assign')
         and public.permission_word_honoured('programs.publish') as programs_words_staged,
       to_regclass('plans.program_manage_v109_use') is not null
         and to_regclass('plans.program_edit_v109_assignment_evidence') is not null as prior_edit_evidence_preserved,
       ((select t.tgenabled from pg_trigger t
        where t.tgrelid='plans.program_assign_publish_v110_use'::regclass
          and t.tgname='program_assign_publish_v110_keep_use'
          and t.tgfoid=to_regprocedure('plans.keep_program_assign_publish_v110_use()')) = 'O'
       and (select md5(prosrc) from pg_proc
         where oid=to_regprocedure('plans.keep_program_assign_publish_v110_use()'))='cc82a13c93f4dfca7ba5d7a4061bc375') as first_use_guard_exact,
       not exists(select 1 from plans.program_assign_publish_v110_use) as unused,
       (select bool_and(relrowsecurity) from pg_class where oid in (
         'plans.program_assign_publish_v110_use'::regclass,'plans.program_assign_publish_v110_seed'::regclass
       )) as bridge_rls_enabled,
       not exists (
         with expected as (select layer,id,unnest(words) as word from plans.program_assign_publish_v110_seed),
         actual as (
           select 'role' as layer,role_id as id,permission_word as word from public.permission_role_items
           union all select 'version',version_id,permission_word from public.permission_club_role_version_items
           union all select 'custom',custom_role_id,permission_word from public.permission_custom_role_items
         )
         (select * from expected except select * from actual)
         union all
         (select * from actual where word in ('programs.assign','programs.publish') except select * from expected)
       ) as seeded_items_exact,
       not exists (
         with audit as (
           select 'role' as layer,role_id as id,revision_after,items_added from public.permission_role_changes
           where migration_name='migrations_v2/202612121000_programs_v110_assign_publish_bridge.sql'
           union all select 'version',version_id,revision_after,items_added from public.permission_club_role_version_changes
           where migration_name='migrations_v2/202612121000_programs_v110_assign_publish_bridge.sql'
           union all select 'custom',custom_role_id,revision_after,items_added from public.permission_custom_role_changes
           where migration_name='migrations_v2/202612121000_programs_v110_assign_publish_bridge.sql'
         )
         select 1 from plans.program_assign_publish_v110_seed s full join audit a using(layer,id)
         where a.revision_after is distinct from s.revision_before+1 or a.items_added is distinct from s.words
       ) as seeded_audit_exact;
select layer,count(*) from plans.program_assign_publish_v110_seed group by layer order by layer;

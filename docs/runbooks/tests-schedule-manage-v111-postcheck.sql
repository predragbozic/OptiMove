-- Read-only.
select (select count(*) from public.schema_migrations where migration_name='migrations_v2/202612131000_tests_v111_schedule_manage_bridge.sql'
         and checksum='822f6cc61c51aa66bf48639e9d577439d83d38b8b18efe8b7b41a5bd323f2cf3')=1 as v111_exact,
       (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='a09af1e41b096da583fbaf04727fe992' as permission_body_exact,
       public.permission_word_honoured('tests.view') and public.permission_word_honoured('tests.schedule.manage') and public.permission_word_honoured('programs.assign')
         and public.permission_word_honoured('programs.publish') as required_words_staged,
       to_regclass('plans.program_manage_v109_use') is not null
         and to_regclass('plans.program_assign_publish_v110_use') is not null as prior_programs_evidence_preserved,
       ((select count(*)=2 from pg_trigger t
        where t.tgrelid='tests.schedule_manage_bridge_use'::regclass
          and t.tgname in ('schedule_manage_v111_keep_use','schedule_manage_v111_keep_use_truncate')
          and t.tgenabled='O'
          and t.tgfoid=to_regprocedure('tests.keep_schedule_manage_v111_use()'))
       and (select md5(prosrc) from pg_proc
         where oid=to_regprocedure('tests.keep_schedule_manage_v111_use()'))='7d7f5e21af5ec288559ad84e68a66c2d') as first_use_guard_exact,
       (select count(*)=1 and bool_and(first_checked_write_at is null) from tests.schedule_manage_bridge_use) as unused,
       (select bool_and(relrowsecurity) from pg_class where oid in (
         'tests.schedule_manage_bridge_use'::regclass,'tests.schedule_manage_v111_seed'::regclass
       )) as bridge_rls_enabled,
       not exists (
         with expected as (select layer,id,unnest(words) as word from tests.schedule_manage_v111_seed),
         actual as (
           select 'role' as layer,role_id as id,permission_word as word from public.permission_role_items
           union all select 'version',version_id,permission_word from public.permission_club_role_version_items
           union all select 'custom',custom_role_id,permission_word from public.permission_custom_role_items
         )
         (select * from expected except select * from actual)
         union all
         (select * from actual where word = 'tests.schedule.manage' except select * from expected)
       ) as seeded_items_exact,
       not exists (
         with audit as (
           select 'role' as layer,role_id as id,revision_after,items_added from public.permission_role_changes
           where migration_name='migrations_v2/202612131000_tests_v111_schedule_manage_bridge.sql'
           union all select 'version',version_id,revision_after,items_added from public.permission_club_role_version_changes
           where migration_name='migrations_v2/202612131000_tests_v111_schedule_manage_bridge.sql'
           union all select 'custom',custom_role_id,revision_after,items_added from public.permission_custom_role_changes
           where migration_name='migrations_v2/202612131000_tests_v111_schedule_manage_bridge.sql'
         )
         select 1 from tests.schedule_manage_v111_seed s full join audit a using(layer,id)
         where a.revision_after is distinct from s.revision_before+1 or a.items_added is distinct from s.words
       ) as seeded_audit_exact;
select layer,count(*) from tests.schedule_manage_v111_seed group by layer order by layer;

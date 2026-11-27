-- Read-only.
select (select count(*) from public.schema_migrations where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql'
         and checksum='d18d03b6bdfaae33fe6481e4b9a44187ebcf763741b994f1ad473fd2a654d764')=1 as v109_exact,
       (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='087f01e9188b2a8a16e3f748addba19f' as permission_body_exact,
       public.permission_word_honoured('programs.edit')
         and not public.permission_word_honoured('programs.assign')
         and not public.permission_word_honoured('programs.publish') as edit_only_stage,
       ((select t.tgenabled from pg_trigger t
        where t.tgrelid='plans.program_manage_v109_use'::regclass
          and t.tgname='program_manage_v109_keep_use'
          and t.tgfoid=to_regprocedure('plans.keep_program_manage_v109_use()')) = 'O'
       and (select md5(prosrc) from pg_proc
         where oid=to_regprocedure('plans.keep_program_manage_v109_use()'))='f2c169e3ad3329bc06a24d4270c8e924') as first_use_guard_exact,
       (select count(*) from pg_trigger
        where tgrelid='plans.program_edit_v109_assignment_evidence'::regclass and tgenabled='O'
          and (tgname,tgtype) in (('program_edit_v109_assignment_evidence_keep_row',27),('program_edit_v109_assignment_evidence_keep_truncate',34))
          and tgfoid=to_regprocedure('plans.keep_program_edit_v109_assignment_evidence()'))=2
         and (select md5(prosrc) from pg_proc
           where oid=to_regprocedure('plans.keep_program_edit_v109_assignment_evidence()'))='cdb813e4f1ce78028eb63f6adfdf4ee1' as assignment_evidence_guard_exact,
       not exists (
         select 1 from pg_roles
         where rolname in ('anon','authenticated','service_role')
           and has_table_privilege(oid,'plans.program_edit_v109_assignment_evidence','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       ) as assignment_evidence_api_roles_denied,
       not exists(select 1 from plans.program_edit_v109_assignment_evidence) as assignment_evidence_unused,
       not exists(select 1 from plans.program_manage_v109_use) as unused,
       (select bool_and(relrowsecurity) from pg_class where oid in (
         'plans.program_manage_v109_use'::regclass,'plans.program_manage_v109_seed'::regclass,'plans.program_edit_v109_assignment_evidence'::regclass
       )) as bridge_rls_enabled,
       not exists (
         with expected as (select layer,id,unnest(words) as word from plans.program_manage_v109_seed),
         actual as (
           select 'role' as layer,role_id as id,permission_word as word from public.permission_role_items
           union all select 'version',version_id,permission_word from public.permission_club_role_version_items
           union all select 'custom',custom_role_id,permission_word from public.permission_custom_role_items
         )
         (select * from expected except select * from actual)
         union all
         (select * from actual where word in ('programs.edit') except select * from expected)
       ) as seeded_items_exact,
       not exists (
         with audit as (
           select 'role' as layer,role_id as id,revision_after,items_added from public.permission_role_changes
           where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql'
           union all select 'version',version_id,revision_after,items_added from public.permission_club_role_version_changes
           where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql'
           union all select 'custom',custom_role_id,revision_after,items_added from public.permission_custom_role_changes
           where migration_name='migrations_v2/202612111000_programs_v109_edit_bridge.sql'
         )
         select 1 from plans.program_manage_v109_seed s full join audit a using(layer,id)
         where a.revision_after is distinct from s.revision_before+1 or a.items_added is distinct from s.words
       ) as seeded_audit_exact;
select layer,count(*) from plans.program_manage_v109_seed group by layer order by layer;

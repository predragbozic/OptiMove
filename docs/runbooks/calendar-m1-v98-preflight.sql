-- Read-only, before applying v98.
select not exists (select 1 from pg_stat_activity where pid<>pg_backend_pid() and datname=current_database() and backend_type='client backend' and xact_start is not null) as quiet_moment;
select count(*)=3 as required_migrations_present from public.schema_migrations where migration_name in (
  'migrations_v2/202611241000_roles_v92_layers_foundation.sql', 'migrations_v2/202611251000_calendar_v93_event_delete.sql',
  'migrations_v2/202611281000_roles_v96_licence_hierarchy.sql');
select not exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202611301000_calendar_v98_manage_permissions.sql') as v98_absent;
with expected(signature, body_md5) as (values
  ('calendar.lock_event_writer(uuid,character varying,uuid,character varying)', '7ebf1bcf39cbb930fb913d89f25fd406'),
  ('calendar.delete_event(uuid,integer,uuid,character varying,uuid,text,jsonb)', '9ec5c97afeca674dc772f5f8503e21f7'),
  ('calendar.event_deletion_log_before_insert()', 'a5c35d8e6f860d02af596ce0fa9f949c'),
  ('public.permission_word_honoured(text)', '0c47ce1a6b157c1c9205d4f48438a5ac')
)
select signature,body_md5 as expected_md5,md5(p.prosrc) as live_md5,coalesce(md5(p.prosrc)=body_md5,false) as matches
from expected left join pg_proc p on p.oid=to_regprocedure(signature) order by signature;

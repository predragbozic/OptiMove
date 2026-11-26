-- Read-only, compare v98's checksum with the release packet, and every body must match.
select migration_name,checksum from public.schema_migrations where migration_name='migrations_v2/202611301000_calendar_v98_manage_permissions.sql';
select active,first_checked_write_at from calendar.m1_activation where singleton;
select layer,count(*) as seeded from calendar.m1_permission_seed group by layer order by layer;
with expected(signature, body_md5) as (values
  ('calendar.lock_event_writer(uuid,character varying,uuid,character varying)', '000ad562f33c8b1ce6bc283397a19a38'),
  ('calendar.delete_event(uuid,integer,uuid,character varying,uuid,text,jsonb)', '3bdce7b2005fc45748bb794e88220c52'),
  ('calendar.event_deletion_log_before_insert()', '1fea5c273306308d9aee091387268896'),
  ('public.permission_word_honoured(text)', '1fa3aa98df127c791a7abed9ab5e894a'),
  ('calendar.require_m1_cutover(boolean)', 'd81b78d2fa71e78373b94ac457d355a5'),
  ('calendar.record_m1_write()', '6e2087efec66908269aa2ae0e5b297b2'),
  ('calendar.lock_event_writer_basis(uuid,character varying,uuid,character varying)', '7ebf1bcf39cbb930fb913d89f25fd406'),
  ('calendar.lock_m1_owner(character varying,uuid)', '180ccf855e3a4d0ddbf72db65cf820e5'),
  ('calendar.lock_event_writer_checked(uuid,character varying,uuid,character varying,character varying,uuid)', '6dc716ecceeedc6635d52e1d59249d86'),
  ('calendar.lock_settings_writer_checked(uuid,uuid,uuid)', '3058f5b967fbdb3085089829d2ec91cd'),
  ('calendar.lock_questions_switch_checked(uuid,uuid)', '10a6254c761ee2d8de0c2687819bb7af'),
  ('calendar.delete_event_checked(uuid,integer,uuid,character varying,uuid,text,jsonb,character varying,uuid)', '88484b28236e730471996435512fce98')
)
select signature,body_md5 as expected_md5,md5(p.prosrc) as live_md5,coalesce(md5(p.prosrc)=body_md5,false) as matches
from expected left join pg_proc p on p.oid=to_regprocedure(signature) order by signature;

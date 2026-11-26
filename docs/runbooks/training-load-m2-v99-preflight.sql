-- Read-only, before v99.
select not exists (
  select 1 from pg_stat_activity where pid<>pg_backend_pid() and datname=current_database()
    and backend_type='client backend' and xact_start is not null
) as quiet_moment;
select exists (
  select 1 from public.schema_migrations where migration_name='migrations_v2/202611301000_calendar_v98_manage_permissions.sql'
    and checksum='79ed9e61e474d77eb20803c930f9a6e13b7737adb076d2117ce695adafdb5347'
) as approved_v98_present;
select not exists (
  select 1 from public.schema_migrations where migration_name like 'migrations_v2/202612011000%'
) as v99_prefix_free;
select md5(prosrc) = '1fa3aa98df127c791a7abed9ab5e894a' as v98_permission_body_matches
from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)');

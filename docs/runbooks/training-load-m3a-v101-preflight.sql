-- Read-only, before v101.
select not exists (
  select 1 from pg_stat_activity where pid<>pg_backend_pid() and datname=current_database()
    and backend_type='client backend' and xact_start is not null
) as quiet_moment;
select exists (
  select 1 from public.schema_migrations where migration_name='migrations_v2/202612011000_training_load_v99_schedule_manage_bridge.sql'
    and checksum='230d51b45702a291b21e84a60fa3738404d1e4bfeb68124ec9554396d858a401'
) as approved_v99_present;
select not exists (
  select 1 from public.schema_migrations where migration_name like 'migrations_v2/202612031000%'
) as v101_prefix_free;
select md5(prosrc) = '83d0186d6ab02ea435ad5303bea5da0f' as v99_permission_body_matches
from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)');

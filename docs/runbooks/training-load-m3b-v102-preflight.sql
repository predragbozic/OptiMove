-- Read-only, before v102.
select not exists (
  select 1 from pg_stat_activity where pid<>pg_backend_pid() and datname=current_database()
    and backend_type='client backend' and xact_start is not null
) as quiet_moment;
select exists (
  select 1 from public.schema_migrations where migration_name='migrations_v2/202612031000_training_load_v101_roster_manage_bridge.sql'
    and checksum='42f9e366be2073f7edab7da02f68b723e31814e317fce9cb2a119fea51d615ce'
) as approved_v101_present;
select not exists (
  select 1 from public.schema_migrations where migration_name like 'migrations_v2/202612041000%'
) as v102_prefix_free;
select md5(prosrc) = 'a4a7ad447a22d5161bcaa22cc7c25c68' as v101_permission_body_matches
from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)');

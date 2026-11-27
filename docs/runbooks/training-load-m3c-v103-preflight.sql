-- Read-only, before v103.
select not exists (
  select 1 from pg_stat_activity where pid<>pg_backend_pid() and datname=current_database()
    and backend_type='client backend' and xact_start is not null
) as quiet_moment;
select exists (
  select 1 from public.schema_migrations where migration_name='migrations_v2/202612041000_training_load_v102_estimates_manage_bridge.sql'
    and checksum='5966b180e4228650e42a1ed3ef0744f1c092a269fe7608e928955719c07c1c32'
) as approved_v102_present;
select not exists (
  select 1 from public.schema_migrations where migration_name like 'migrations_v2/202612051000%'
) as v103_prefix_free;
select md5(prosrc) = 'bf0ab02eb4dd495ee00b0f19f282820f' as v102_permission_body_matches
from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)');

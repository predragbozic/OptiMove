-- Read-only preflight. Stop before the deploy if a condition is false.
select not exists (
  select 1 from pg_stat_activity where pid<>pg_backend_pid() and datname=current_database()
    and backend_type='client backend' and xact_start is not null
) as quiet_moment;
select exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612051000_training_load_v103_activity_identity_manage_bridge.sql' and checksum='653df87e3c5980a8502edf0df62581f629fe068a3d8eb937489f30c2ebc6a487') as approved_v103_present,
       exists (select 1 from public.schema_migrations where migration_name='migrations_v2/202612061000_training_load_v104_dashboard_page_copy.sql' and checksum='19c89d6c818189ce3a1146998d8ef2aec25b1f8dadb700ac183cd88cc7a461ab') as approved_v104_present;
select not exists (
  select 1 from public.schema_migrations where migration_name like 'migrations_v2/202612071000%'
) as v105_prefix_free;
select coalesce((select md5(prosrc) = 'de24c9ae7db6abf6d1db7f0e6b891b5e' from pg_proc
                 where oid=to_regprocedure('public.permission_word_honoured(text)')),false) as v103_permission_body_matches;

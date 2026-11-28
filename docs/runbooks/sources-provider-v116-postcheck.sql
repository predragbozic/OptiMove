-- Read-only. Require all booleans.
select exists (select from public.schema_migrations
where migration_name = 'migrations_v2/202612181000_training_load_v116_sources_provider_store.sql' and checksum = 'fbb52694dcbdd31fe3e67e2d998b5a612923daff431498a65fb45286b7cf0f11') as exact_v116,
((select count(*) = 1 and bool_and(singleton and not enabled and epoch = 0)
from training_load.source_provider_admission)
and not exists (select from training_load.source_provider_attempts)
and not exists (select from training_load.source_provider_attempt_teams)) as closed_and_empty,
(select count(*) = 3 from pg_trigger t
where (t.tgrelid, t.tgname) in (
  ('training_load.source_provider_admission'::regclass, 'source_provider_admission_keep_closed'),
  ('training_load.source_provider_attempts'::regclass, 'source_provider_attempts_keep_closed'),
  ('training_load.source_provider_attempt_teams'::regclass, 'source_provider_attempt_teams_keep_closed')
) and t.tgenabled = 'O' and t.tgtype = 62
  and t.tgfoid = to_regprocedure('training_load.source_provider_store_closed()')) as guards_enabled,
(select md5(prosrc) from pg_proc
where oid = to_regprocedure('training_load.source_provider_store_closed()')) = '952568303b4b671a17dd04ced6660840' as guard_body_exact,
(select count(*) = 3 and bool_and(relrowsecurity) from pg_class where oid in (
  'training_load.source_provider_admission'::regclass,
  'training_load.source_provider_attempts'::regclass,
  'training_load.source_provider_attempt_teams'::regclass
)) as rls_enabled,
not exists (
  select from pg_roles p
  where p.rolname in ('anon','authenticated','service_role')
    and (
      has_table_privilege(p.oid, 'training_load.source_provider_admission', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
      or has_table_privilege(p.oid, 'training_load.source_provider_attempts', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
      or has_table_privilege(p.oid, 'training_load.source_provider_attempt_teams', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
      or has_function_privilege(p.oid, 'training_load.source_provider_store_closed()', 'EXECUTE')
    )
) as api_acl_closed;

-- All checks should be true. The new writer may add proof only after this check.
select (select count(*) from public.schema_migrations where migration_name='migrations_v2/202612091000_training_load_v107_builder_rpe_copy_attestation.sql' and checksum='569dda46b08f1b44dd0afba14bb486842943643d0f55dabfeebf866e18caa711')=1 as exact_v107,
(select count(*) from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attrelid in ('training_load.builder_rpe_plan_baselines'::regclass,'training_load.builder_rpe_session_baselines'::regclass)
    and a.attname='opening_verified' and a.atttypid='boolean'::regtype and a.attnotnull
    and not a.attisdropped and pg_get_expr(d.adbin,d.adrelid)='false')=2 as both_default_closed,
(select count(*) from pg_constraint where convalidated and (conrelid,conname) in (
  ('training_load.builder_rpe_plan_baselines'::regclass,'builder_rpe_plan_copy_proof_check'),
  ('training_load.builder_rpe_session_baselines'::regclass,'builder_rpe_session_copy_proof_check')
))=2 as both_constraints,
not exists (
  select 1 from (values
    ('training_load.builder_rpe_plan_baselines','builder_rpe_plan_copy_attestation_guard','training_load.guard_builder_rpe_copy_attestation()'),
    ('training_load.builder_rpe_session_baselines','builder_rpe_session_copy_attestation_guard','training_load.guard_builder_rpe_copy_attestation()'),
    ('training_load.builder_rpe_copy_attestation_use','builder_rpe_copy_attestation_use_append_only','training_load.guard_builder_rpe_copy_attestation_use()')
  ) x(tbl,name,fn)
  left join pg_trigger t on t.tgrelid=to_regclass(x.tbl) and t.tgname=x.name
  where t.tgenabled is distinct from 'O' or t.tgfoid is distinct from to_regprocedure(x.fn)
) as all_guards_enabled,
(select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.guard_builder_rpe_copy_attestation()')) is not distinct from 'a98ec2ddd41a81e6ea81b28725095aa6' as writer_body,
(select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.guard_builder_rpe_copy_attestation_use()')) is not distinct from 'e560b266585c26564f17e1b993528453' as use_body;

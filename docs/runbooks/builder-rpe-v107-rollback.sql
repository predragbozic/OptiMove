-- Run only after draining all v107 writers, before any use.
begin;
set local lock_timeout='5s';
do $$ begin
  if not pg_try_advisory_xact_lock(822026) then raise exception 'v107 rollback refused: the migrator is running'; end if;
end $$;
select pg_advisory_xact_lock(hashtextextended('builder-rpe-provenance-v106',0));
lock table training_load.builder_rpe_plan_baselines, training_load.builder_rpe_session_baselines,
  training_load.builder_rpe_copy_attestation_use in access exclusive mode;
do $$
declare v_applied timestamptz;
begin
  select applied_at into v_applied from public.schema_migrations where migration_name='migrations_v2/202612091000_training_load_v107_builder_rpe_copy_attestation.sql' and checksum='7f1f42e052681532a7ce6860f184013ca21490006ff58d3baecf154c24f93f9f';
  if v_applied is null or exists (
    select 1 from public.schema_migrations where migration_name<>'migrations_v2/202612091000_training_load_v107_builder_rpe_copy_attestation.sql'
       and migration_name ~ '^migrations_v2/[0-9]{12}_' and (applied_at>=v_applied or migration_name>'migrations_v2/202612091000_training_load_v107_builder_rpe_copy_attestation.sql')
  ) then
    raise exception 'v107 rollback refused: missing migration, checksum mismatch, or later migration';
  end if;
  if exists (select 1 from training_load.builder_rpe_copy_attestation_use)
      or exists (select 1 from training_load.builder_rpe_plan_baselines where opening_verified)
      or exists (select 1 from training_load.builder_rpe_session_baselines where opening_verified) then
    raise exception 'v107 rollback refuses recorded copy attestation use';
  end if;
  if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.guard_builder_rpe_copy_attestation()')) is distinct from 'a98ec2ddd41a81e6ea81b28725095aa6'
      or (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.guard_builder_rpe_copy_attestation_use()')) is distinct from 'e560b266585c26564f17e1b993528453' then
    raise exception 'v107 rollback refused: the attestation bodies changed';
  end if;
end
$$;
drop trigger builder_rpe_plan_copy_attestation_guard on training_load.builder_rpe_plan_baselines;
drop trigger builder_rpe_session_copy_attestation_guard on training_load.builder_rpe_session_baselines;
drop table training_load.builder_rpe_copy_attestation_use;
drop function training_load.guard_builder_rpe_copy_attestation();
drop function training_load.guard_builder_rpe_copy_attestation_use();
alter table training_load.builder_rpe_plan_baselines drop column opening_verified;
alter table training_load.builder_rpe_session_baselines drop column opening_verified;
delete from public.schema_migrations where migration_name='migrations_v2/202612091000_training_load_v107_builder_rpe_copy_attestation.sql' and checksum='7f1f42e052681532a7ce6860f184013ca21490006ff58d3baecf154c24f93f9f';
commit;

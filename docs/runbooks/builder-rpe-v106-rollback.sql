begin;
set local lock_timeout = '5s';
select pg_advisory_xact_lock(hashtextextended('builder-rpe-provenance-v106', 0));

do $$
begin
  if not exists (select 1 from public.schema_migrations
      where migration_name = 'migrations_v2/202612081000_training_load_v106_builder_rpe_provenance.sql'
        and checksum = '9c32b3f5fb7c1016b1c8d5f1b125952c375bc8d2e9c7285e5f550e6a92717e4f') then
    raise exception 'v106 rollback expected its exact migration record';
  end if;
  if exists (select 1 from public.schema_migrations
      where migration_name ~ '^migrations_v2/[0-9]{12}_'
        and migration_name > 'migrations_v2/202612081000_training_load_v106_builder_rpe_provenance.sql') then
    raise exception 'v106 rollback refuses a later migration';
  end if;
  if exists (select 1 from training_load.builder_rpe_provenance_use)
     or exists (select 1 from training_load.builder_rpe_plan_baselines) then
    raise exception 'v106 rollback refuses recorded Builder provenance';
  end if;
end
$$;

drop table training_load.builder_rpe_session_effects, training_load.builder_rpe_plan_effects,
  training_load.builder_rpe_session_baselines, training_load.builder_rpe_plan_baselines,
  training_load.builder_rpe_provenance_use;

delete from public.schema_migrations where migration_name = 'migrations_v2/202612081000_training_load_v106_builder_rpe_provenance.sql';
commit;

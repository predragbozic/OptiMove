-- Execute on the intended database before applying v107.
select exists (
  select 1 from public.schema_migrations
  where migration_name='migrations_v2/202612081000_training_load_v106_builder_rpe_provenance.sql'
    and checksum='f75a6eb6cc162c39f3e52968424138334fd84b3a9b38aef2407e4de2b8edd808'
) as exact_v106,
not exists (
  select 1 from public.schema_migrations where migration_name='migrations_v2/202612091000_training_load_v107_builder_rpe_copy_attestation.sql'
) as v107_pending,
to_regclass('training_load.builder_rpe_copy_attestation_use') is null as no_attestation_use_table,
(select count(*) from pg_attribute where attrelid in (
  'training_load.builder_rpe_plan_baselines'::regclass,'training_load.builder_rpe_session_baselines'::regclass
) and attname='opening_verified' and not attisdropped)=0 as no_attestation_columns;

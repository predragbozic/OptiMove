-- Read-only. A used marker is legitimate after Builder has served a new draft.
select count(*) = 1 and bool_and(checksum = '9c32b3f5fb7c1016b1c8d5f1b125952c375bc8d2e9c7285e5f550e6a92717e4f') as exact_v106
from public.schema_migrations where migration_name = 'migrations_v2/202612081000_training_load_v106_builder_rpe_provenance.sql';
select count(*) as first_use_rows, min(first_used_at) as first_used_at
from training_load.builder_rpe_provenance_use;
select count(*) as opening_plans from training_load.builder_rpe_plan_baselines;

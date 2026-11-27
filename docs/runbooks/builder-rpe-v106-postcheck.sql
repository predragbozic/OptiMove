-- Read-only. A used marker is legitimate after Builder has served a new draft.
select count(*) = 1 and bool_and(checksum = 'e30e229e234deea8bc866e070b44924674640952521067e4e3322bb1f2b64b53') as exact_v106
from public.schema_migrations where migration_name = 'migrations_v2/202612081000_training_load_v106_builder_rpe_provenance.sql';
select count(*) as first_use_rows, min(first_used_at) as first_used_at
from training_load.builder_rpe_provenance_use;
select count(*) as opening_plans from training_load.builder_rpe_plan_baselines;

-- Read-only. A used marker is legitimate after Builder has served a new draft.
select count(*) = 1 and bool_and(checksum = 'f75a6eb6cc162c39f3e52968424138334fd84b3a9b38aef2407e4de2b8edd808') as exact_v106
from public.schema_migrations where migration_name = 'migrations_v2/202612081000_training_load_v106_builder_rpe_provenance.sql';
select count(*) as first_use_rows, min(first_used_at) as first_used_at
from training_load.builder_rpe_provenance_use;
select count(*) as opening_plans from training_load.builder_rpe_plan_baselines;

select public.permission_word_honoured('programs.rpe_settings') as native_word_staged,
  (select md5(prosrc) from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)'))='ab3c43d4a319567b7f208305a1097fd3' as permission_body_exact;
select layer,count(*) as staged_roles from training_load.builder_rpe_v106_seed group by layer order by layer;

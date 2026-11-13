-- Read-only POST-CHECK for migrations v68 and v69 (MT-D); run after the deploy that applied them (the Rukovodilac, each block in a
-- read-only transaction). Changes nothing. Every boolean column of every block must be true.

-- 1. v68 and v69 are recorded once each, v69 is the last migration.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611131300_training_load_v68_track_choice_scale.sql') = 1 as v68_once,
       (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611131310_training_load_v69_scale_recording_estimates.sql') = 1 as v69_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611131310_training_load_v69_scale_recording_estimates.sql' as v69_last;

-- 2. v68: the scale column and its three CHECKs; v67's guard unchanged.
select exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_track_choices'
                and column_name = 'scale_target_minutes' and data_type = 'numeric') as scale_column,
       exists (select 1 from pg_constraint where conname = 'gpexe_track_choices_scale_range') as scale_range,
       exists (select 1 from pg_constraint where conname = 'gpexe_track_choices_scale_on_track') as scale_on_track,
       exists (select 1 from pg_constraint where conname = 'gpexe_track_choices_one_track_scale') as one_track_scale,
       (select pg_get_constraintdef(oid) from pg_constraint where conname = 'gpexe_track_choices_track_set_fingerprint_check') like '%)*$''%' as fingerprint_one_track,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'validate_gpexe_track_choice') = '909c3c79b14b7bf95992240e2058c39f' as guard_unchanged;

-- 3. v69: the method CHECK takes scale_recording, the basis body is v69's, the provenance guard unchanged.
select (select pg_get_constraintdef(oid) from pg_constraint where conname = 'metric_value_estimates_method_check') like '%scale_recording%' as method_ok,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'estimate_basis_ok') = '1ee471360a969f6895e1e697fa1facc6' as basis_is_v69,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'validate_metric_value_estimate') = 'd4fdb1a813a4560651493af644632ea3' as provenance_guard_unchanged;

-- 4. Nothing scaled yet (holds on the deploy day only; a scale needs ESTIMATES_ENABLED, off), no idle transaction.
select not exists (select 1 from training_load.gpexe_track_choices where scale_target_minutes is not null) as no_scale,
       not exists (select 1 from training_load.metric_value_estimates where method = 'scale_recording') as no_scaled_estimate,
       not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx;

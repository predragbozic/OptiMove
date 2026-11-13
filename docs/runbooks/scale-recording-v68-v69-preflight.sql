-- Read-only PREFLIGHT for migrations v68 and v69 (MT-D, scaling a short recording):
--   migrations_v2/202611131300_training_load_v68_track_choice_scale.sql
--   migrations_v2/202611131310_training_load_v69_scale_recording_estimates.sql
-- Run before the merge (the Rukovodilac, each block in a read-only transaction). Changes nothing. Every boolean column of every
-- block must be true.

-- 1. The server, and the migrations: neither v68 nor v69 recorded, v67 recorded; the last one recorded is listed for the packet.
select current_setting('server_version_num')::int >= 160000 as pg16_or_later,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%_v68_%' or migration_name like 'migrations_v2/%_v69_%') as v68_v69_absent,
       exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611131200_training_load_v67_gpexe_track_choices.sql') as v67_recorded,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 2. v68's preconditions: v67's table with its fingerprint CHECK, no scale column.
select to_regclass('training_load.gpexe_track_choices') is not null as choices_table,
       exists (select 1 from pg_constraint where conrelid = 'training_load.gpexe_track_choices'::regclass
                and conname = 'gpexe_track_choices_track_set_fingerprint_check') as fingerprint_check,
       not exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_track_choices'
                    and column_name = 'scale_target_minutes') as no_scale_column;

-- 3. v69's preconditions: v63's table, its method CHECK and the basis body of v63; the provenance guard is v64's (v69 relies
--    on its sum-only rule and does not replace it).
select to_regclass('training_load.metric_value_estimates') is not null as estimates_table,
       exists (select 1 from pg_constraint where conrelid = 'training_load.metric_value_estimates'::regclass
                and conname = 'metric_value_estimates_method_check') as method_check,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'estimate_basis_ok') = '3e33a4053bbfa06cf21a15ce23903029' as basis_is_v63,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'validate_metric_value_estimate') = 'd4fdb1a813a4560651493af644632ea3' as provenance_guard_is_v64;

-- 4. A quiet moment: no idle transaction, no lock wait. The counts are for the packet (v68 changes no row).
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()) as no_lock_wait,
       (select count(*) from training_load.gpexe_track_choices) as choices,
       (select count(*) from training_load.metric_value_estimates) as estimates;

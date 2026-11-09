-- Read-only POST-CHECK for migration v58 (migrations_v2/202611091100_training_load_v58_import_approval_subset.sql); run after the deploy.
-- Changes nothing. Every block returns rows with ok = true (or the stated counts).

-- 1. v58 is recorded once and is the last migration.
select count(*) = 1 as recorded_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611091100_training_load_v58_import_approval_subset.sql' as is_last
  from public.schema_migrations where migration_name = 'migrations_v2/202611091100_training_load_v58_import_approval_subset.sql';

-- 2. The new trigger body is in force (md5 of prosrc) and the trigger is enabled.
select md5(p.prosrc) as actual_md5, md5(p.prosrc) = 'b27b0872c62dd73c71305dafc5992edd' as ok,
       (select count(*) from pg_trigger t where not t.tgisinternal and t.tgenabled = 'O' and t.tgname = 'gpexe_import_approvals_validate' and t.tgfoid = p.oid) = 1 as trigger_enabled
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'training_load' and p.proname = 'validate_gpexe_import_approval';

-- 3. The two columns and the three CHECKs exist; excluded_athlete_ids is NOT NULL DEFAULT '{}'.
select (select count(*) from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_import_approvals'
         and column_name in ('excluded_athlete_ids', 'subset_hash')) = 2 as two_columns,
       (select is_nullable = 'NO' and column_default like '%{}%' from information_schema.columns
         where table_schema = 'training_load' and table_name = 'gpexe_import_approvals' and column_name = 'excluded_athlete_ids') as set_not_null_default_empty,
       (select count(*) from pg_constraint where conrelid = 'training_load.gpexe_import_approvals'::regclass
         and conname in ('gpexe_import_approvals_excluded_size', 'gpexe_import_approvals_subset_hash_pair', 'gpexe_import_approvals_subset_hash_format')) = 3 as three_checks;

-- 4. Every approval that existed before v58 reads as "nobody left out" (no set, no hash); the deploy itself made no subset approval.
select count(*) filter (where cardinality(excluded_athlete_ids) = 0 and subset_hash is null) as full_approvals,
       count(*) filter (where cardinality(excluded_athlete_ids) > 0) as subset_approvals,
       count(*) filter (where (cardinality(excluded_athlete_ids) = 0) <> (subset_hash is null)) as pairing_violations_expected_zero
  from training_load.gpexe_import_approvals;

-- 5. Nothing is stuck.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx;

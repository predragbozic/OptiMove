-- Read-only PREFLIGHT for migration v58 (migrations_v2/202611091100_training_load_v58_import_approval_subset.sql); run before the deploy
-- that applies it (the Rukovodilac, Supabase SQL Editor, each block in a read-only transaction). Changes nothing. Every block
-- returns rows with ok = true (or the stated facts).

-- 1. The last applied migration is the app-error migration or later (but not v58) and v58 is not recorded.
select (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%')
         >= 'migrations_v2/202611091000_app_error_events.sql' as ok,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611091100_training_load_v58_import_approval_subset.sql') as v58_absent,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%'
                    and migration_name > 'migrations_v2/202611091100_training_load_v58_import_approval_subset.sql') as nothing_after_v58;

-- 2. The trigger function v58 replaces is v33's (md5 of prosrc); the migration refuses to run otherwise.
select count(*) over () = 1 as one_function, md5(p.prosrc) as actual_md5, md5(p.prosrc) = '1b4cc435b11a5b8e462dee4b296bf068' as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'training_load' and p.proname = 'validate_gpexe_import_approval';

-- 3. None of the v58 objects exists yet; the trigger points at the function and is enabled.
select not exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_import_approvals'
                    and column_name in ('excluded_athlete_ids', 'subset_hash')) as no_new_columns,
       not exists (select 1 from pg_constraint where conrelid = 'training_load.gpexe_import_approvals'::regclass
                    and conname in ('gpexe_import_approvals_excluded_size', 'gpexe_import_approvals_subset_hash_pair', 'gpexe_import_approvals_subset_hash_format')) as no_new_constraints,
       (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
         where not t.tgisinternal and t.tgenabled = 'O' and t.tgname = 'gpexe_import_approvals_validate'
           and p.proname = 'validate_gpexe_import_approval') = 1 as trigger_enabled;

-- 4. No approval is in flight and the moment is quiet (ALTER TABLE takes a short lock on the approvals table).
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from training_load.gpexe_import_checks where status = 'running') as no_running_check;

-- 5. The role you run this as is, or is a member of, the owner of the approvals table and of the trigger function.
select pg_has_role(current_user, (select relowner from pg_class where oid = 'training_load.gpexe_import_approvals'::regclass), 'USAGE') as owns_approvals,
       pg_has_role(current_user, (select p.proowner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                   where n.nspname = 'training_load' and p.proname = 'validate_gpexe_import_approval'), 'USAGE') as owns_function;

-- 6. Facts to read: the approvals that exist now all read as "nobody left out" after v58.
select (select count(*) from training_load.gpexe_import_approvals) as approvals,
       (select count(*) from training_load.gpexe_import_candidates where status = 'pending') as pending_candidates;

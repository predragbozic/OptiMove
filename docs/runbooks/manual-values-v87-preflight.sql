-- Preflight of migration v87 (manual values on the roster): migrations_v2/202611221100_training_load_v87_manual_values.sql
-- Read only. Every column must be true before the deploy that applies v87. Run as: psql -v ON_ERROR_STOP=1 -f manual-values-v87-preflight.sql
begin read only;

-- 1. v85 is applied and v87 is not.
select exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611201500_training_load_v85_session_types.sql') as v85_recorded,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611221100_training_load_v87_manual_values.sql') as v87_not_recorded;

-- 2. The bodies v87 replaces are the ones it was written on (its md5 gate refuses any other).
select (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'undo_imported_session') = '67559dabda476298a10f100d13dc74e1' as undo_is_v76,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'undo_imported_session') = 1 as undo_once,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'session_undo_scope') = '4d33a3379faaf918243b8db11de12c81' as scope_is_v63,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training' and p.proname = 'activity_roster_needs_state') = '8016e580c27a56ed97c6711cdf401cd6' as needs_state_is_v26;

-- 3. Nothing of v87 exists yet, and the approvals' pair rule is v59's.
select to_regclass('training_load.metric_manual_values') is null as no_provenance_table,
       not exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'import_deletion_log'
                    and column_name = 'manual_values_removed') as no_log_column,
       not exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_import_approvals'
                    and column_name in ('replaced_manual_athlete_ids', 'chosen_activity_type_key')) as no_approval_columns,
       (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'training_load.gpexe_import_approvals'::regclass
         and conname = 'gpexe_import_approvals_subset_hash_pair') = 'CHECK (((cardinality(excluded_athlete_ids) = 0) = (subset_hash IS NULL)))' as pair_rule_is_v59;

-- 4. Nothing holds a lock that conflicts with the ones v87 takes up front (a long transaction would make the 5 s
--    lock_timeout refuse it): any lock on the deletion log and the approvals (ACCESS EXCLUSIVE), and a writer's lock on the
--    occasions and values (SHARE ROW EXCLUSIVE does not conflict with a reader).
select not exists (select 1 from pg_locks l join pg_class c on c.oid = l.relation
                    join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'training_load' and l.pid <> pg_backend_pid()
                      and (c.relname in ('import_deletion_log', 'gpexe_import_approvals')
                           or (c.relname in ('metric_measurement_occasions', 'metric_values')
                               and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock',
                                              'ExclusiveLock', 'AccessExclusiveLock')))) as tables_not_locked,
       not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and xact_start < now() - interval '1 minute') as no_old_idle_transaction;

commit;

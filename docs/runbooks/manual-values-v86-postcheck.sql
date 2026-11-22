-- Post-check of migration v86 (manual values on the roster): migrations_v2/202611221100_training_load_v86_manual_values.sql
-- Read only. Every column must be true after the deploy that applied v86. Run as: psql -v ON_ERROR_STOP=1 -f manual-values-v86-postcheck.sql
begin read only;

-- 1. v86 is recorded once.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611221100_training_load_v86_manual_values.sql') = 1 as v86_recorded;

-- 2. The bodies in force are v86's.
select (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'undo_imported_session') = '727221b5842fb74b7f4f100411c4b89e' as undo_is_v86,
       (select array_agg(pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'undo_imported_session')
         = array['p_actor uuid, p_team uuid, p_candidate uuid, p_request_key uuid, p_reason text, p_expected_event uuid, p_later_roster_fingerprint text, p_manual_values_fingerprint text'] as undo_one_eight_argument_function,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'session_undo_scope') = 'a68f994cbbe2cbeaadfad5207334ba01' as scope_is_v86,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training' and p.proname = 'activity_roster_needs_state') = '1a64e2ce6d700b742b7383055681774e' as needs_state_is_v86,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'validate_metric_manual_value') = 'e50e495a9447dde50193230603eda742' as guard_is_v86,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'session_undo_manual_log_ok') = '85907d20eef6ff365255eafe31b2598f' as log_shape_is_v86,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'forbid_value_after_manual_provenance') = '9a200df4d7b15331795782dcbf124185' as closed_guard_is_v86;

-- 3. The provenance table, its five triggers (none disabled) and no row yet.
select to_regclass('training_load.metric_manual_values') is not null as provenance_table,
       (select count(*) from pg_trigger t where not t.tgisinternal and t.tgenabled = 'O'
         and ((t.tgrelid = 'training_load.metric_manual_values'::regclass
               and t.tgname in ('metric_manual_values_validate', 'metric_manual_values_protect', 'metric_manual_values_no_truncate'))
              or (t.tgrelid = 'training_load.metric_measurement_occasions'::regclass and t.tgname = 'metric_measurement_occasions_manual_provenance')
              or (t.tgrelid = 'training_load.metric_values'::regclass and t.tgname = 'metric_values_manual_closed'))) = 5 as guards_enabled,
       (select count(*) from training_load.metric_manual_values) = 0 as no_provenance_row_yet;

-- 4. The deletion log and the approvals carry the new columns and rules, and nothing was written to them.
select exists (select 1 from pg_constraint where conrelid = 'training_load.import_deletion_log'::regclass
                and conname = 'import_deletion_log_manual_values_removed_shape') as log_shape_check,
       not exists (select 1 from training_load.import_deletion_log where manual_values_removed is not null) as log_column_empty,
       (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'training_load.gpexe_import_approvals'::regclass
         and conname = 'gpexe_import_approvals_subset_hash_pair') like '%replaced_manual_athlete_ids%chosen_activity_type_key%' as pair_rule_is_v86,
       not exists (select 1 from training_load.gpexe_import_approvals
                    where cardinality(replaced_manual_athlete_ids) > 0 or chosen_activity_type_key is not null) as approval_columns_empty,
       exists (select 1 from pg_constraint where conrelid = 'training_load.gpexe_import_approvals'::regclass
                and conname = 'gpexe_import_approvals_replaced_manual_shape') as replaced_shape_check,
       to_regclass('training_load.gpexe_import_approvals_chosen_type_idx') is not null as chosen_type_index;

-- 5. Nothing is left waiting.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and xact_start < now() - interval '1 minute') as no_old_idle_transaction,
       not exists (select 1 from pg_locks where not granted) as no_lock_wait;

commit;

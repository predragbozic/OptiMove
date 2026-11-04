-- Read-only POST-CHECK for migration v56 (migrations_v2/202611041400_training_load_v56_team_import_switch.sql); run after the deploy.
-- Changes nothing. Every block returns rows with ok = true.

-- 1. v56 is recorded once and is the last migration.
select count(*) = 1 as recorded_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611041400_training_load_v56_team_import_switch.sql' as is_last
  from public.schema_migrations where migration_name = 'migrations_v2/202611041400_training_load_v56_team_import_switch.sql';

-- 2. The new approver body is in force.
select md5(p.prosrc) as actual_md5, md5(p.prosrc) = '09b80cfea087b2c0e7aba47284010412' as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'training_load' and p.proname = 'lock_gpexe_import_approver';

-- 3. The three tables, the four functions, the guards (all enabled) and the widened CHECK.
select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'training_load' and c.relname in ('gpexe_team_import_switch', 'gpexe_team_import_switch_history', 'gpexe_import_prerequisite_records')) = 3 as three_tables,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname in ('team_import_write_guard', 'team_import_actor_basis', 'set_team_import_switch', 'record_import_prerequisite')) = 4 as four_functions,
       (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'training_load' and not t.tgisinternal and t.tgenabled = 'O'
           and t.tgname in ('gpexe_team_import_switch_guard', 'gpexe_team_import_switch_no_truncate', 'gpexe_team_import_switch_history_guard',
                            'gpexe_team_import_switch_history_no_truncate', 'gpexe_import_prerequisite_records_guard', 'gpexe_import_prerequisite_records_no_truncate')) = 6 as six_guards_enabled,
       (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'gpexe_import_approvals_approval_basis_check') like '%club_admin%team_coach%' as check_widened;

-- 4. Nothing is on: no switch row, no history, no record, and no approval with a new basis (until an administrator acts).
select (select count(*) from training_load.gpexe_team_import_switch) as switch_rows,
       (select count(*) from training_load.gpexe_team_import_switch_history) as history_rows,
       (select count(*) from training_load.gpexe_import_prerequisite_records) as record_rows,
       (select count(*) from training_load.gpexe_import_approvals where approval_basis in ('club_admin', 'team_coach')) as new_basis_approvals;

-- 5. No actor/marker leaked and nothing is stuck.
select current_setting('optimove.team_import_tx', true) is null or current_setting('optimove.team_import_tx', true) = '' as no_marker,
       not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx;

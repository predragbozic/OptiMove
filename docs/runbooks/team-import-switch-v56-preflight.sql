-- Read-only PREFLIGHT for migration v56 (migrations_v2/202611041400_training_load_v56_team_import_switch.sql); run before the deploy that
-- applies it (the Rukovodilac, Supabase SQL Editor). Changes nothing. Every block returns rows with ok = true.

-- 1. The last applied migration is v54 or v55 (O7) and v56 is not recorded.
select (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') in
         ('migrations_v2/202611041100_training_load_v54_rights_locks_users_first.sql',
          'migrations_v2/202611041300_training_load_v55_team_dashboards_club_variables.sql') as ok,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611041400_training_load_v56_team_import_switch.sql') as v56_absent;

-- 2. The body in force of lock_gpexe_import_approver is v54's (md5 of prosrc).
select md5(p.prosrc) as actual_md5, md5(p.prosrc) = '9c3bf3edeb1dcca9c5516b77c30e86ee' as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'training_load' and p.proname = 'lock_gpexe_import_approver';

-- 3. None of the v56 objects exists yet, and the approval_basis CHECK is the original one.
select to_regclass('training_load.gpexe_team_import_switch') is null
   and to_regclass('training_load.gpexe_team_import_switch_history') is null
   and to_regclass('training_load.gpexe_import_prerequisite_records') is null as no_v56_table,
       (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'gpexe_import_approvals_approval_basis_check')
         like '%platform_admin%team_grant%' as original_check,
       not exists (select 1 from training_load.gpexe_import_approvals where approval_basis not in ('platform_admin', 'team_grant')) as no_new_basis_rows;

-- 4. No approval is in flight and the moment is quiet.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from training_load.gpexe_import_checks where status = 'running') as no_running_check;

-- 5. The role you run this as is, or is a member of, the owner of the function and of the approvals table
--    (CREATE OR REPLACE and ALTER TABLE need ownership).
select pg_has_role(current_user, p.proowner, 'USAGE') as owns_function,
       pg_has_role(current_user, (select relowner from pg_class where oid = 'training_load.gpexe_import_approvals'::regclass), 'USAGE') as owns_table
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'training_load' and p.proname = 'lock_gpexe_import_approver';

-- 6. The server's import switch (GPEXE_IMPORT_APPLY_ENABLED) is a Render setting and is not read here; v56 changes nothing
--    until a platform administrator records the prerequisites and turns a team on (nothing is on after the migration).

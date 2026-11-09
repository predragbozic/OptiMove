-- Read-only PREFLIGHT for migration v60 (migrations_v2/202611091200_training_load_v60_session_undo_roster_work.sql); run before the deploy that applies it (each block in a read-only
-- transaction). Changes nothing. Every block returns rows with ok = true (or the stated facts).

-- 1. The last applied migration is v59 or later-but-not-v60, and v60 is not recorded.
select (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%')
         >= 'migrations_v2/202611091100_training_load_v59_import_approval_subset.sql' as ok,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611091200_training_load_v60_session_undo_roster_work.sql') as v60_absent,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611091200_training_load_v60_session_undo_roster_work.sql') as nothing_after_v60;

-- 2. The bodies v60 replaces are the ones it expects (md5 of prosrc); the migration refuses to run otherwise.
select x.fn, count(p.oid) = 1 as one_function, md5(max(p.prosrc)) as actual_md5, md5(max(p.prosrc)) = x.expected as ok
  from (values
    ('training_load', 'undo_imported_session', 'ae5aa129708a03a602b9cdc596e1e11a'),
    ('training_load', 'session_undo_scope', 'f605cb502a36a4d8e372373fe1e2207a'),
    ('training', 'protect_activity_roster_request', 'd653da02d80b0e844105c606017917c4'),
    ('training', 'check_activity_athlete_decision', 'd911a55ffeb641ab296488f7faa2569f'),
    ('training', 'protect_activity_completion', '4ad9534602ec7cae22d2e4560b9bdeed'),
    ('training', 'protect_activity_completion_log', '2cd36fa02adf8af1c41436225459d0ad'),
    ('training_load', 'validate_import_deletion_log', 'ccd1157ee00901c66d3bf4c031763bf7')) as x(schema_name, fn, expected)
  left join pg_namespace n on n.nspname = x.schema_name
  left join pg_proc p on p.pronamespace = n.oid and p.proname = x.fn
 group by x.fn, x.expected order by x.fn;

-- 3. None of the v60 objects exists yet, and the old six-argument undo function is the only one.
select not exists (select 1 from information_schema.columns where (table_schema, table_name, column_name) in
         (('training', 'activity_roster_requests', 'origin'), ('training_load', 'import_deletion_log', 'roster_work_removed'))) as no_new_columns,
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'training_load' and p.proname in ('session_undo_roster_work', 'import_deletion_log_roster_work_ok')) as no_new_functions,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'undo_imported_session' and p.pronargs = 6) = 1 as old_signature_only;

-- 4. A quiet moment: nothing in flight, nothing waiting on a lock (v60 takes short locks on the roster and log tables).
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from training_load.gpexe_import_checks where status = 'running') as no_running_check;

-- 5. The role you run this as is, or is a member of, the owner of the tables and of the undo function.
select pg_has_role(current_user, (select relowner from pg_class where oid = 'training.activity_roster_requests'::regclass), 'USAGE') as owns_requests,
       pg_has_role(current_user, (select relowner from pg_class where oid = 'training_load.import_deletion_log'::regclass), 'USAGE') as owns_log,
       pg_has_role(current_user, (select p.proowner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                   where n.nspname = 'training_load' and p.proname = 'undo_imported_session'), 'USAGE') as owns_undo;

-- 6. Facts to read: how much roster work and how many undos exist now (all of the roster work reads as a coach's own after v60).
select (select count(*) from training.activity_roster_requests) as roster_requests,
       (select count(*) from training.activity_athlete_decisions) as decisions,
       (select count(*) from training.activity_completions) as completions,
       (select count(*) from training_load.gpexe_session_undo_requests) as undo_requests,
       (select count(*) from training_load.import_deletion_log) as deletion_log_rows;

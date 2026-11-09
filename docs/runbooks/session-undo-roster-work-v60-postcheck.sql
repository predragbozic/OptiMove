-- Read-only POST-CHECK for migration v60 (migrations_v2/202611091200_training_load_v60_session_undo_roster_work.sql); run after the deploy. Changes nothing.
-- Every block returns rows with ok = true (or the stated counts).

-- 1. v60 is recorded once and is the last migration.
select count(*) = 1 as recorded_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611091200_training_load_v60_session_undo_roster_work.sql' as is_last
  from public.schema_migrations where migration_name = 'migrations_v2/202611091200_training_load_v60_session_undo_roster_work.sql';

-- 2. The new bodies are in force (md5 of prosrc).
select x.fn, count(p.oid) = 1 as one_function, md5(max(p.prosrc)) = x.expected as ok
  from (values
    ('training_load', 'undo_imported_session', '0c4434b062fe401225d1a0e003a98cb5'),
    ('training_load', 'session_undo_scope', '514617da209da9d2703477ef5c4a69dd'),
    ('training_load', 'session_undo_roster_work', 'bde0945274c10d2b415d947e08508805'),
    ('training', 'protect_activity_roster_request', '4549eaa47dc6c6ad34af9a2d548ff173'),
    ('training', 'check_activity_athlete_decision', 'cb038617f44d1e6028825d73f5048c64'),
    ('training', 'protect_activity_completion', '1bd5b84c90536e4a7802e2ed2c3e7229'),
    ('training', 'protect_activity_completion_log', '310479ead5bac4ba0ada834a6c20543c'),
    ('training_load', 'validate_import_deletion_log', '8bc1c58cee9d8a42b9d7bdec06978f5b'),
    ('training_load', 'import_deletion_log_roster_work_ok', '63ef21b28862101fa25979a90ee47202')) as x(schema_name, fn, expected)
  left join pg_namespace n on n.nspname = x.schema_name
  left join pg_proc p on p.pronamespace = n.oid and p.proname = x.fn
 group by x.fn, x.expected order by x.fn;

-- 3. undo_imported_session exists once, with seven arguments (the six-argument version is gone).
select count(*) = 1 as one_function, bool_and(p.pronargs = 7) as seven_args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'training_load' and p.proname = 'undo_imported_session';

-- 4. The two columns exist; origin is NOT NULL default 'roster' with its CHECK; every existing request reads as a coach's own.
select (select count(*) from information_schema.columns where (table_schema, table_name, column_name) in
         (('training', 'activity_roster_requests', 'origin'), ('training_load', 'import_deletion_log', 'roster_work_removed'))) = 2 as two_columns,
       (select is_nullable = 'NO' and column_default like '%roster%' from information_schema.columns
         where table_schema = 'training' and table_name = 'activity_roster_requests' and column_name = 'origin') as origin_not_null_default_roster,
       (select count(*) from pg_constraint where conrelid = 'training.activity_roster_requests'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%origin%') = 1 as origin_check,
       (select count(*) from training.activity_roster_requests where origin <> 'roster') as import_origin_requests_expected_zero;

-- 5. The roster triggers and the deletion-log guard are enabled.
select count(*) = 6 as six_triggers_enabled
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
 where not t.tgisinternal and t.tgenabled = 'O'
   and (c.relname, t.tgname) in (('activity_roster_requests', 'activity_roster_requests_protect'), ('activity_athlete_decisions', 'activity_athlete_decisions_check'),
        ('activity_completions', 'activity_completions_protect'), ('activity_completion_log', 'activity_completion_log_protect'),
        ('activity_completion_log', 'activity_completion_log_rules'), ('import_deletion_log', 'import_deletion_log_validate'));

-- 6. The deploy itself removed nothing and wrote no roster work removal.
select (select count(*) from training_load.import_deletion_log where roster_work_removed is not null) as roster_removals_expected_zero;

-- 7. Nothing is stuck.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx;

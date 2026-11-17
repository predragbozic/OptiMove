-- Read-only PREFLIGHT for migration v76 (migrations_v2/202611171000_training_load_v76_undo_by_importer.sql); run before the deploy that applies it (the Rukovodilac, Supabase SQL
-- Editor, each block in a read-only transaction). Changes nothing. Every block returns ok = true (or the stated facts).

-- 1. v73 is recorded and v76 is not; no migrations_v2 migration sorts after v76. v74 (and any other migration between
--    v73 and v76) may be recorded or not: v76 touches nothing they change.
select exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611151500_app_error_events_v73_request_and_restart.sql') as v73_recorded,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611171000_training_load_v76_undo_by_importer.sql') as v76_absent,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611171000_training_load_v76_undo_by_importer.sql') as nothing_later;

-- 2. The bodies v76 replaces are the ones it expects (md5 of prosrc); the migration refuses to run otherwise.
select e.f as fn, md5(p.prosrc) as actual_md5, md5(p.prosrc) = e.m as ok
  from (values ('undo_imported_session', 'cf208f99e3e4db738670dec2567dc8fc'),
               ('validate_import_deletion_log_v60', '1c949a5f6a8383724ec1836b0ed3dddd')) e(f, m)
  join pg_namespace n on n.nspname = 'training_load' join pg_proc p on p.pronamespace = n.oid and p.proname = e.f
 order by 1;

-- 3. Exactly one authorized_via CHECK, platform_admin only; no v76 object yet; the insert trigger points at the v60 function.
select (select count(*) from pg_constraint where conrelid = 'training_load.import_deletion_log'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) like '%authorized_via%') = 1 as one_check,
       (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'training_load.import_deletion_log'::regclass
         and conname = 'import_deletion_log_authorized_via_check') = 'CHECK (((authorized_via)::text = ''platform_admin''::text))' as check_is_v21s,
       to_regprocedure('training_load.lock_gpexe_session_undo_right(uuid,uuid)') is null as no_right_fn,
       exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                where t.tgrelid = 'training_load.import_deletion_log'::regclass and t.tgname = 'import_deletion_log_validate'
                  and p.proname = 'validate_import_deletion_log_v60' and t.tgenabled = 'O') as trigger_ok;

-- 4. Every existing deletion log row is a platform admin's (the CHECK allows nothing else today).
select not exists (select 1 from training_load.import_deletion_log where authorized_via <> 'platform_admin') as ok,
       (select count(*) from training_load.import_deletion_log) as deletion_log_rows;

-- 5. A quiet moment: no undo in flight (the migration takes the log's ACCESS EXCLUSIVE lock with a 5 s lock_timeout).
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

-- 6. The role you run this as owns (or is a member of the owner of) the deletion log.
select pg_has_role(current_user, (select relowner from pg_class where oid = 'training_load.import_deletion_log'::regclass), 'USAGE') as owns_log;

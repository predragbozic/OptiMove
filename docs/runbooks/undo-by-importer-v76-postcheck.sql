-- Read-only POST-CHECK for migration v76 (migrations_v2/202611171000_training_load_v76_undo_by_importer.sql); run after the deploy that applied it. Changes nothing. Every
-- block returns ok = true.

-- 1. v76 recorded once, and the last migrations_v2 migration.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611171000_training_load_v76_undo_by_importer.sql') = 1 as recorded_once,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611171000_training_load_v76_undo_by_importer.sql') as last;

-- 2. The three v76 bodies (md5 of prosrc).
select e.f as fn, md5(p.prosrc) as actual_md5, md5(p.prosrc) = e.m as ok
  from (values ('undo_imported_session', '67559dabda476298a10f100d13dc74e1'),
               ('validate_import_deletion_log_v60', 'f00bd8533daef19560b07704c87fd4e2'),
               ('lock_gpexe_session_undo_right', '615ac75ce8c7add4094a35d0cf85f00a')) e(f, m)
  join pg_namespace n on n.nspname = 'training_load' join pg_proc p on p.pronamespace = n.oid and p.proname = e.f
 order by 1;

-- 3. The CHECK takes the four bases; the insert trigger is enabled and points at the v60 function (now v76's body).
select (select count(*) from pg_constraint where conrelid = 'training_load.import_deletion_log'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) like '%authorized_via%') = 1 as one_check,
       (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'training_load.import_deletion_log'::regclass
         and conname = 'import_deletion_log_authorized_via_check')
         = 'CHECK (((authorized_via)::text = ANY ((ARRAY[''platform_admin''::character varying, ''team_grant''::character varying, ''club_admin''::character varying, ''team_coach''::character varying])::text[])))' as four_bases,
       exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                where t.tgrelid = 'training_load.import_deletion_log'::regclass and t.tgname = 'import_deletion_log_validate'
                  and p.proname = 'validate_import_deletion_log_v60' and t.tgenabled = 'O') as trigger_ok;

-- 4. Nothing else moved: no idle transaction and no lock wait.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

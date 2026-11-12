-- Read-only POST-CHECK for migration v67 (migrations_v2/202611122300_training_load_v67_gpexe_track_choices.sql); run after the
-- deploy that applied it (the Rukovodilac, each block in a read-only transaction). Changes nothing. Every boolean column of every
-- block must be true.

-- 1. v67 is recorded once and is the last migration.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611122300_training_load_v67_gpexe_track_choices.sql') = 1 as recorded_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611122300_training_load_v67_gpexe_track_choices.sql' as last;

-- 2. The table, its checks, the request unique, the two indexes and the self-reference.
select to_regclass('training_load.gpexe_track_choices') is not null as table_ok,
       exists (select 1 from pg_constraint where conname = 'gpexe_track_choices_track_named') as track_named,
       exists (select 1 from pg_constraint where conname = 'gpexe_track_choices_grant_basis') as grant_basis,
       exists (select 1 from pg_constraint where conname = 'gpexe_track_choices_request' and contype = 'u') as request_unique,
       exists (select 1 from pg_constraint where conrelid = 'training_load.gpexe_track_choices'::regclass and contype = 'u'
                and pg_get_constraintdef(oid) = 'UNIQUE (supersedes_choice_id)') as one_successor,
       to_regclass('training_load.gpexe_track_choices_one_root') is not null as one_root,
       to_regclass('training_load.gpexe_track_choices_athlete_idx') is not null as athlete_idx;

-- 3. The guard and the append-only triggers, enabled; the two functions.
select (select count(*) from pg_trigger t where not t.tgisinternal and t.tgenabled = 'O'
         and t.tgrelid = 'training_load.gpexe_track_choices'::regclass
         and t.tgname in ('gpexe_track_choices_validate', 'gpexe_track_choices_no_update_delete', 'gpexe_track_choices_no_truncate')) = 3 as triggers_ok,
       to_regprocedure('training_load.track_choice_context_actor()') is not null as actor_fn,
       to_regprocedure('training_load.validate_gpexe_track_choice()') is not null as guard_fn,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'lock_gpexe_import_approver') = '09b80cfea087b2c0e7aba47284010412' as approver_unchanged;

-- 4. No choice yet (nothing reads one before MT-B), no idle transaction.
select not exists (select 1 from training_load.gpexe_track_choices) as no_choice,
       not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx;

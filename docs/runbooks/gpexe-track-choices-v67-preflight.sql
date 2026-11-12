-- Read-only PREFLIGHT for migration v67 (migrations_v2/202611122300_training_load_v67_gpexe_track_choices.sql); run before the
-- merge (the Rukovodilac, each block in a read-only transaction). Changes nothing. Every boolean column of every block must be true.

-- 1. The server, and the migrations: none of v67's name recorded; the last one recorded is listed for the packet.
select current_setting('server_version_num')::int >= 160000 as pg16_or_later,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%_v67_%') as v67_absent,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 2. The approver function in force is v56's (v67's precondition), exactly once.
select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'lock_gpexe_import_approver') = 1 as approver_once,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'lock_gpexe_import_approver') = '09b80cfea087b2c0e7aba47284010412' as approver_is_v56;

-- 3. The objects v67 needs exist, and none of its own does.
select to_regclass('training_load.gpexe_team_import_switch') is not null as switch_table,
       to_regclass('training_load.gpexe_import_candidates') is not null as candidates_table,
       to_regclass('training_load.gpexe_import_approvers') is not null as approvers_table,
       to_regprocedure('training_load.forbid_update_delete()') is not null as forbid_fn,
       to_regclass('training_load.gpexe_track_choices') is null as no_table,
       to_regprocedure('training_load.track_choice_context_actor()') is null as no_actor_fn,
       to_regprocedure('training_load.validate_gpexe_track_choice()') is null as no_guard_fn;

-- 4. A quiet moment: no idle transaction, no lock wait.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()) as no_lock_wait;

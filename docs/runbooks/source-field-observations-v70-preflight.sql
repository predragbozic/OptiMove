-- Read-only PREFLIGHT for migration v70 (migrations_v2/202611151200_training_load_v70_source_field_observations.sql); run before the
-- merge (the Rukovodilac, each block in a read-only transaction). Changes nothing. Every boolean column of every block must be true.

-- 1. The server, and the migrations: none of v70's name recorded; the last one recorded is listed for the packet.
select current_setting('server_version_num')::int >= 160000 as pg16_or_later,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%_v70_%') as v70_absent,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 2. The objects v70 needs exist, and none of its own does.
select to_regclass('training_load.gpexe_import_checks') is not null as checks_table,
       to_regclass('training_load.source_credential_connections') is not null as connections_table,
       exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_import_checks'
                and column_name = 'source_connection_id') as check_source_facts,
       to_regprocedure('training_load.source_metric_unit_token_ok(text)') is not null as unit_token_fn,
       to_regclass('training_load.source_field_observations') is null as no_table,
       to_regprocedure('training_load.field_inventory_context_check()') is null as no_context_fn,
       to_regprocedure('training_load.source_field_observations_guard()') is null as no_guard_fn,
       to_regprocedure('training_load.source_field_observations_keep()') is null as no_keep_fn;

-- 3. A quiet moment: no running check (its finalization would meet the new table mid-deploy), no idle transaction, no lock wait.
select not exists (select 1 from training_load.gpexe_import_checks where status = 'running') as no_running_check,
       not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()) as no_lock_wait;

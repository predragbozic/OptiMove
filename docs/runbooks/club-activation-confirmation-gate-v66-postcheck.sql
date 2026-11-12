-- v66 production post-check - READ ONLY. For the *Rukovodilac*, after the
-- owner's joint deploy of J18's 18-3 and 18-4: each numbered block verbatim,
-- in its own read-only transaction that is rolled back.
-- Migration: migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql.
-- Any value other than the expected one means: stop, change nothing, report
-- the block, the column and the value.

-- 1. v66 recorded once, with the repository's checksum, as the last
--    migrations_v2 migration.
--    Expected: v66_rows = 1, v66_checksum_ok = true, later_migrations = 0.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql') as v66_rows,
  (select bool_and(checksum = '0fef63affe37f5c7c90961cb8c90e278ffe7e6ec3432fef418e54011b3d36dc0') from public.schema_migrations
    where migration_name = 'migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql') as v66_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql') as later_migrations;

-- 2. The gate exists with its body, its trigger is enabled and runs last
--    among T4's row triggers before an update, and T4's other guards are
--    unchanged.
--    Expected: gate_body_ok = true, gate_trigger_enabled_ok = true,
--    gate_runs_last_ok = true, t4_triggers = 7, disabled_triggers = 0,
--    update_guard_ok = true, actor_guard_ok = true.
select
  (select md5(p.prosrc) = '0c5ccf731449b49d3988075828f90672' from pg_proc p
    where p.pronamespace = 'training_load'::regnamespace and p.proname = 'source_metric_mapping_versions_confirmation_gate') as gate_body_ok,
  coalesce((select t.tgenabled = 'O' and t.tgtype = 19 from pg_trigger t
    where t.tgrelid = 'training_load.source_metric_mapping_versions'::regclass and t.tgname = 'source_metric_mapping_versions_v66_confirmation_gate'), false) as gate_trigger_enabled_ok,
  (select max(t.tgname::text collate "C") from pg_trigger t
    where t.tgrelid = 'training_load.source_metric_mapping_versions'::regclass and not t.tgisinternal
      and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16 and (t.tgtype & 1) = 1) = 'source_metric_mapping_versions_v66_confirmation_gate' as gate_runs_last_ok,
  (select count(*) from pg_trigger t where t.tgrelid = 'training_load.source_metric_mapping_versions'::regclass and not t.tgisinternal) as t4_triggers,
  (select count(*) from pg_trigger t where t.tgrelid = 'training_load.source_metric_mapping_versions'::regclass and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers,
  (select md5(p.prosrc) = '42fb55a2dd043328079fa9b6f4a2c43e' from pg_proc p
    where p.pronamespace = 'training_load'::regnamespace and p.proname = 'source_metric_mapping_versions_update_guard') as update_guard_ok,
  (select md5(p.prosrc) = '3fabb004253650eb5d0460da786c7883' from pg_proc p
    where p.pronamespace = 'training_load'::regnamespace and p.proname = 'source_metric_mapping_versions_actor_guard') as actor_guard_ok;

-- 3. No row was changed: no confirmation exists yet unless a board save was
--    made since the deploy, and no version changed status in the migration.
--    Expected: nothing; confirmations is information (0 right after the
--    deploy).
select (select count(*) from training_load.source_metric_confirmations) as confirmations;

-- 4. No session is left idle in a transaction and nothing waits for a lock.
--    Expected: idle_in_transaction = 0, waiting_locks = 0.
select
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction,
  (select count(*) from pg_locks l where not l.granted
     and l.database = (select oid from pg_database where datname = current_database())) as waiting_locks;

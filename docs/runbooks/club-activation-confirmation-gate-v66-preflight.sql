-- v66 production preflight - READ ONLY. For the *Rukovodilac*, on the day of
-- the joint deploy of J18's 18-3 and 18-4, under the standing order for
-- migration PRs (docs/ai/metrics-core-plan.md, section 2): each numbered block
-- verbatim through the connector, in its own read-only transaction that is
-- rolled back. The owner may run the same blocks in the Supabase SQL Editor,
-- as the application's DATABASE_URL role.
-- Migration: migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql;
-- contract docs/ai/c112-drag-mapping-contract.md (J18), sections 5.5, 15.3
-- and 15.9 (migration M-B, the gate).
--
-- Run ONE numbered block at a time. Every block is a plain SELECT. Every
-- column named ..._ok must be true and every count the expected one; any
-- other value means: stop, change nothing, report the block, the column and
-- the value.

-- 1. The migration state: the migration before v66 recorded once with the
--    repository's checksum as the last migration; v66 absent.
--    Expected: previous_rows = 1, previous_checksum_ok = true, v66_rows = 0,
--    at_or_after_v66 = 0,
--    last_migration = migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql.
--    (If another migration is merged before v66, this block is re-issued with
--    that migration's name and checksum before the preflight is run.)
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql') as previous_rows,
  (select bool_and(checksum = 'a8cbce20d0c1d168194abaa2753e9281d5ca379668b73fc2177ac5396c1b4ac5') from public.schema_migrations
    where migration_name = 'migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql') as previous_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql') as v66_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql') as at_or_after_v66,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 2. T4's guards are the ones the gate was written on (the migration checks
--    the same md5s and the same trigger set and refuses otherwise).
--    Expected: update_guard_ok = true, actor_guard_ok = true,
--    trigger_set_ok = true.
select
  coalesce((select md5(p.prosrc) = '42fb55a2dd043328079fa9b6f4a2c43e' from pg_proc p
    where p.pronamespace = 'training_load'::regnamespace and p.proname = 'source_metric_mapping_versions_update_guard'), false) as update_guard_ok,
  coalesce((select md5(p.prosrc) = '3fabb004253650eb5d0460da786c7883' from pg_proc p
    where p.pronamespace = 'training_load'::regnamespace and p.proname = 'source_metric_mapping_versions_actor_guard'), false) as actor_guard_ok,
  coalesce((select string_agg(t.tgname::text || ':' || t.tgenabled::text, ',' order by t.tgname::text) from pg_trigger t
    where t.tgrelid = 'training_load.source_metric_mapping_versions'::regclass and not t.tgisinternal)
   = 'source_metric_mapping_versions_insert_guard:O,source_metric_mapping_versions_no_truncate:O,source_metric_mapping_versions_update_guard:O,source_metric_mapping_versions_v35_actor_guard:O,source_metric_mapping_versions_v35_audit_link_insert:O,source_metric_mapping_versions_v35_audit_link_update:O', false) as trigger_set_ok;

-- 3. Nothing v66 creates exists yet; what it reads is there; the migrator's
--    role owns T4 and may create in the schema.
--    Expected: v66_objects = 0, relied_on_ok = true, owns_t4_ok = true,
--    may_create_ok = true.
select
  (select count(*) from pg_proc p where p.pronamespace = 'training_load'::regnamespace and p.proname = 'source_metric_mapping_versions_confirmation_gate')
    + (select count(*) from pg_trigger t where t.tgrelid = 'training_load.source_metric_mapping_versions'::regclass
        and t.tgname = 'source_metric_mapping_versions_v66_confirmation_gate') as v66_objects,
  (to_regclass('training_load.source_metric_confirmations') is not null
    and to_regclass('training_load.source_metric_confirmation_items') is not null
    and to_regclass('training_load.source_metric_mapping_version_copies') is not null
    and exists (select 1 from pg_proc p where p.pronamespace = 'training_load'::regnamespace and p.proname = 'source_metric_current_xmin')) as relied_on_ok,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_mapping_versions'::regclass)) = current_user as owns_t4_ok,
  has_schema_privilege(current_user, 'training_load', 'CREATE') as may_create_ok;

-- 4. The versions the gate will stop: a club's draft or needs_review version
--    of a field without parameters. One with a copy link to an active system
--    version passes the gate and needs nothing. For the others the owner
--    decides, BEFORE the deploy, who disables or activates them; nothing is
--    disabled automatically (contract section 5.9).
--    Expected: waiting_without_link = 0. waiting_with_link is information.
select
  count(*) filter (where not w.linked) as waiting_without_link,
  count(*) filter (where w.linked) as waiting_with_link
  from (select exists (select 1 from training_load.source_metric_mapping_version_copies k
                         join training_load.source_metric_mapping_versions s on s.id = k.system_version_id
                        where k.club_version_id = v.id and s.owner_key = 'system' and s.status = 'active') as linked
          from training_load.source_metric_mapping_versions v
         where v.owner_key <> 'system' and v.parameter_kind = 'none' and v.status in ('draft', 'needs_review')) w;

-- 5. The server does not write a save's values to its log. From this deploy
--    on a save inserts two athletes' values as bind parameters. A REFUSAL: if
--    any column is false there is no deploy until the owner changes the
--    setting, or the save is shown not to pass values as logged parameters.
--    Expected: every column = true. (Read from pg_settings in the base
--    unit: current_setting() prints a unit, as in "64B".)
--      statement_parameters_not_logged_ok: parameters are cut to nothing
--        (log_parameter_max_length = 0), or no statement that carries them is
--        logged (log_statement none or ddl, and no duration-based logging);
--      error_parameters_not_logged_ok: a failing statement's parameters are
--        not logged (log_parameter_max_length_on_error = 0);
--      pgaudit_parameters_not_logged_ok: pgaudit is absent, logs nothing, or
--        does not log parameters;
--      auto_explain_parameters_not_logged_ok: auto_explain is absent, off, or
--        logs no parameters.
select
  ((select setting::int from pg_settings where name = 'log_parameter_max_length') = 0
    or ((select setting from pg_settings where name = 'log_statement') in ('none', 'ddl')
        and (select setting::int from pg_settings where name = 'log_min_duration_statement') = -1
        and (select setting::int from pg_settings where name = 'log_min_duration_sample') = -1)) as statement_parameters_not_logged_ok,
  ((select setting::int from pg_settings where name = 'log_parameter_max_length_on_error') = 0) as error_parameters_not_logged_ok,
  (coalesce(current_setting('pgaudit.log', true), '') in ('', 'none')
    or coalesce(current_setting('pgaudit.log_parameter', true), 'off') = 'off') as pgaudit_parameters_not_logged_ok,
  (coalesce(current_setting('auto_explain.log_min_duration', true), '-1') = '-1'
    or coalesce(current_setting('auto_explain.log_parameter_max_length', true), '-1') = '0') as auto_explain_parameters_not_logged_ok;

-- 6. The same settings as they are, for the record (no expected value).
select current_setting('log_statement') as log_statement,
       current_setting('log_min_duration_statement') as log_min_duration_statement,
       current_setting('log_min_duration_sample') as log_min_duration_sample,
       current_setting('log_parameter_max_length') as log_parameter_max_length,
       current_setting('log_parameter_max_length_on_error') as log_parameter_max_length_on_error,
       current_setting('pgaudit.log', true) as pgaudit_log,
       current_setting('pgaudit.log_parameter', true) as pgaudit_log_parameter,
       current_setting('auto_explain.log_min_duration', true) as auto_explain_log_min_duration,
       current_setting('auto_explain.log_parameter_max_length', true) as auto_explain_log_parameter_max_length;

-- 7. A quiet moment. v66 takes SHARE ROW EXCLUSIVE on T4 and waits for a
--    writer of T4 up to the runner's lock_timeout (30 s); a wait that runs out
--    fails the migration with SQLSTATE 55P03, nothing applied, the old
--    instance serving, and the deploy is repeated at a quiet moment.
--    Expected: t4_writers = 0, idle_in_transaction = 0.
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation = 'training_load.source_metric_mapping_versions'::regclass
      and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')) as t4_writers,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;

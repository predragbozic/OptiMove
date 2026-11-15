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

-- 1. The migration state: v66 absent; the two migrations it relies on
--    recorded once each with the repository's checksum. v66 sorts BEFORE
--    four later migrations of other tracks that reach production first; the
--    runner applies by file name and takes v66 all the same. Tolerated after
--    v66, by exact name, each with its checksum where it is recorded:
--      v67 (MT-A, track choices)            - required, on production;
--      v68 and v69 (MT-D, scale recording)  - expected (deployed before v66);
--      v70 (App health, AH-1)               - optional (before or after v66).
--    None of them touches T4 or reads the gate. ANY OTHER migration after
--    v66 is a refusal.
--    Expected: v65_rows = 1, v65_checksum_ok = true, v67_rows = 1,
--    v67_checksum_ok = true, v68_rows = 1, v69_rows = 1, v70_rows = 0 or 1,
--    later_checksums_ok = true, v66_rows = 0, other_after_v66 = 0;
--    last_migration is the latest of those recorded (v69's name, or v70's).
--    v68_rows or v69_rows = 0 is not a refusal of the gate; it means the
--    deploy order changed and is reported before going on.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql') as v65_rows,
  (select bool_and(checksum = 'a8cbce20d0c1d168194abaa2753e9281d5ca379668b73fc2177ac5396c1b4ac5') from public.schema_migrations
    where migration_name = 'migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql') as v65_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611131200_training_load_v67_gpexe_track_choices.sql') as v67_rows,
  (select bool_and(checksum = '9f9b7d2529230c436d3b5f8b7e3db451bd3c81bca75514a54329bcc2cd1147cd') from public.schema_migrations
    where migration_name = 'migrations_v2/202611131200_training_load_v67_gpexe_track_choices.sql') as v67_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611131300_training_load_v68_track_choice_scale.sql') as v68_rows,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611131310_training_load_v69_scale_recording_estimates.sql') as v69_rows,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql') as v70_rows,
  (select coalesce(bool_and(m.checksum = k.checksum), true)
     from public.schema_migrations m
     join (values ('migrations_v2/202611131300_training_load_v68_track_choice_scale.sql', '8beaef9bcead25c53d1109903be5e8d5c0e5b1ac7cfa70e9217a4a6b20bca815'),
                  ('migrations_v2/202611131310_training_load_v69_scale_recording_estimates.sql', '98a11f69314c235244e9b7efbb1e6a7f5233bae6c93c0a1148b838cdcc736391'),
                  ('migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql', '858045833f49ed0ba59e2acec57d20e4ece762d7b1107490a7dc450659677d60')) as k(migration_name, checksum)
       on k.migration_name = m.migration_name) as later_checksums_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql') as v66_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql'
    and migration_name not in ('migrations_v2/202611131200_training_load_v67_gpexe_track_choices.sql',
                               'migrations_v2/202611131300_training_load_v68_track_choice_scale.sql',
                               'migrations_v2/202611131310_training_load_v69_scale_recording_estimates.sql',
                               'migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql')) as other_after_v66,
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
--    RUN THIS BLOCK AS THE APPLICATION'S DATABASE_URL ROLE: the values are
--    those of the session that asks, and the last column says whether any
--    role or database carries an override the asking session would not see.
--    Expected: every column = true. (Read from pg_settings in the base
--    unit: current_setting() prints a unit, as in "64B". A setting of an
--    extension that is not loaded reads as NULL or as an empty text; both
--    count as not set.)
--      statement_parameters_not_logged_ok: parameters are cut to nothing
--        (log_parameter_max_length = 0), or no statement that carries them is
--        logged (log_statement none or ddl, no duration-based logging and no
--        sampled transaction);
--      error_parameters_not_logged_ok: a failing statement's parameters are
--        not logged (log_parameter_max_length_on_error = 0);
--      pgaudit_parameters_not_logged_ok: pgaudit does not log parameters, or
--        logs nothing at all (neither by class nor by its object-audit role);
--      auto_explain_parameters_not_logged_ok: auto_explain is absent or off;
--        or it logs no parameters and no verbose plan (a verbose plan can
--        carry a parameter as a constant); or its threshold
--        (auto_explain.log_min_duration, in ms) is ABOVE 5000, the statement
--        bound of the save's value-carrying statements
--        (VALUE_STATEMENT_TIMEOUT_MS, backend/src/sourceMetricBoardSaveService.js):
--        such a statement is cancelled at 5000 ms, and auto_explain explains
--        only a statement that finished. Its sample rate and its nested-
--        statement setting do not change that (a trigger's statements run
--        inside the same bound); block 6 prints them and the threshold;
--      plans_not_printed_ok: no debug_print_* setting prints a statement's
--        plan or parse tree, which carry its constants;
--      no_role_or_database_override_ok: no ALTER ROLE / ALTER DATABASE ... SET
--        of any of these settings exists (a session of another role would
--        log differently from what this block reads). One override is not
--        counted: log_statement=none, which only REDUCES logging (the
--        platform's own admin roles carry it); any other value or setting is
--        still false.
select
  ((select setting::int from pg_settings where name = 'log_parameter_max_length') = 0
    or ((select setting from pg_settings where name = 'log_statement') in ('none', 'ddl')
        and (select setting::int from pg_settings where name = 'log_min_duration_statement') = -1
        and (select setting::int from pg_settings where name = 'log_min_duration_sample') = -1
        and (select setting::float8 from pg_settings where name = 'log_transaction_sample_rate') = 0)) as statement_parameters_not_logged_ok,
  ((select setting::int from pg_settings where name = 'log_parameter_max_length_on_error') = 0) as error_parameters_not_logged_ok,
  (coalesce(nullif(current_setting('pgaudit.log_parameter', true), ''), 'off') = 'off'
    or (coalesce(nullif(current_setting('pgaudit.log', true), ''), '') in ('', 'none')
        and coalesce(nullif(current_setting('pgaudit.role', true), ''), '') = '')) as pgaudit_parameters_not_logged_ok,
  (coalesce(nullif(current_setting('auto_explain.log_min_duration', true), ''), '-1') = '-1'
    or (coalesce(nullif(current_setting('auto_explain.log_parameter_max_length', true), ''), '-1') = '0'
        and coalesce(nullif(current_setting('auto_explain.log_verbose', true), ''), 'off') = 'off')
    or coalesce((select case when setting ~ '^[0-9]+$' then setting::bigint end from pg_settings where name = 'auto_explain.log_min_duration'), -1) > 5000) as auto_explain_parameters_not_logged_ok,
  (not exists (select 1 from pg_settings where name in ('debug_print_parse', 'debug_print_rewritten', 'debug_print_plan') and setting = 'on')) as plans_not_printed_ok,
  (not exists (select 1 from pg_db_role_setting s, unnest(s.setconfig) as cfg
                where cfg ~ '^(log_statement|log_min_duration_|log_parameter_max_length|log_transaction_sample_rate|debug_print_|pgaudit\.|auto_explain\.)'
                  and cfg <> 'log_statement=none')) as no_role_or_database_override_ok;

-- 6. The same settings as they are, and who asked, for the record (no
--    expected value). Not covered by block 5, stated: the connection pooler's
--    own statement log, if it keeps one; and a value inside an error's own
--    text - a failing CHECK prints its row unless log_error_verbosity is
--    terse. v65's guards refuse every such row of the confirmation tables
--    first, with fixed texts (its migration header), so no value is expected
--    there.
select current_user as asked_as,
       current_setting('log_statement') as log_statement,
       current_setting('log_min_duration_statement') as log_min_duration_statement,
       current_setting('log_min_duration_sample') as log_min_duration_sample,
       current_setting('log_transaction_sample_rate') as log_transaction_sample_rate,
       current_setting('log_parameter_max_length') as log_parameter_max_length,
       current_setting('log_parameter_max_length_on_error') as log_parameter_max_length_on_error,
       current_setting('log_error_verbosity') as log_error_verbosity,
       current_setting('pgaudit.log', true) as pgaudit_log,
       current_setting('pgaudit.role', true) as pgaudit_role,
       current_setting('pgaudit.log_parameter', true) as pgaudit_log_parameter,
       current_setting('auto_explain.log_min_duration', true) as auto_explain_log_min_duration,
       current_setting('auto_explain.log_parameter_max_length', true) as auto_explain_log_parameter_max_length,
       current_setting('auto_explain.log_verbose', true) as auto_explain_log_verbose,
       (select setting from pg_settings where name = 'auto_explain.log_min_duration') as auto_explain_log_min_duration_ms,
       5000 as value_statement_bound_ms,
       current_setting('auto_explain.sample_rate', true) as auto_explain_sample_rate,
       current_setting('auto_explain.log_nested_statements', true) as auto_explain_log_nested_statements,
       current_setting('auto_explain.log_analyze', true) as auto_explain_log_analyze,
       (select coalesce(string_agg(coalesce(r.rolname, 'all roles') || coalesce(' in ' || d.datname, '') || ': ' || cfg, '; ' order by r.rolname, cfg), '')
          from pg_db_role_setting s left join pg_roles r on r.oid = s.setrole left join pg_database d on d.oid = s.setdatabase, unnest(s.setconfig) as cfg
         where cfg ~ '^(log_statement|log_min_duration_|log_parameter_max_length|log_transaction_sample_rate|debug_print_|pgaudit\.|auto_explain\.)') as logging_overrides;

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

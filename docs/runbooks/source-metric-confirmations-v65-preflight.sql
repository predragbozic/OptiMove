-- v65 production preflight - READ ONLY. For the *Rukovodilac*, on the day of
-- the merge of J18's 18-1 pull request, under the standing order for
-- migration PRs (docs/ai/metrics-core-plan.md, section 2): each numbered block
-- verbatim through the connector, in its own read-only transaction that is
-- rolled back (section 2, step 5). The owner may run the same blocks in the
-- Supabase SQL Editor, as the application's DATABASE_URL role (the one the
-- migrator uses).
-- Migration: migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql;
-- contract docs/ai/c112-drag-mapping-contract.md (J18), sections 5 and 15.3
-- (migration M-A).
--
-- Run ONE numbered block at a time: the editor shows only the result of the
-- last statement it ran. Every block is a plain SELECT, so nothing is written
-- and no transaction is left open. The expected values are in the comments;
-- any other value means: stop, change nothing, report the block, the column
-- and the value.
--
-- The deploy follows block 8 at once: v65 takes T8 with NOWAIT, so a T8 that
-- is busy at that moment fails the migration with nothing applied, and the
-- deploy is repeated at a quiet moment. Block 10 is information for 18-3, not
-- a condition of this deploy.

-- 1. PostgreSQL 15 or later, as v41 already needs (v65 also needs numeric
--    infinity, PostgreSQL 14, and sha256(), PostgreSQL 11).
--    Expected: pg15_or_later = true.
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 150000 as pg15_or_later;

-- 2. The migration state: the migration before v65 recorded once with the
--    repository's checksum; v65 absent and nothing recorded at or after its
--    name (the migrator runs files in name order).
--    Expected: previous_rows = 1, previous_checksum_ok = true, v65_rows = 0,
--    at_or_after_v65 = 0, and
--    last_migration = migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql.
--    (If another migration is merged before v65, this block is re-issued with
--    that migration's name and checksum before the preflight is run.)
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql') as previous_rows,
  (select bool_and(checksum = '278870571b4a1641fbfee652a15ecdc4045de999ca81f083513638e9ad71c4e1') from public.schema_migrations
    where migration_name = 'migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql') as previous_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql') as v65_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql') as at_or_after_v65,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. The four bodies v65 replaces are the ones in force: v52's
--    source_metric_audit_row_ok and source_metric_audit_actor_guard, v48's
--    source_metric_audit_insert_guard and v50's
--    source_metric_audit_revision_guard (the migration checks the same md5s
--    and refuses otherwise; the rollback restores exactly these bodies).
--    Expected: every column = true.
select
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_audit_row_ok') as row_ok_is_v52,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_audit_actor_guard') as actor_guard_is_v52,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_audit_insert_guard') as insert_guard_is_v48,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_audit_revision_guard') as revision_guard_is_v50
  from (values
          ('source_metric_audit_row_ok', 'a43a63c2d248cbaf71302468429acb85'),
          ('source_metric_audit_actor_guard', '94cf466bfa765a1a03f7d290a3ce154a'),
          ('source_metric_audit_insert_guard', '157c1ba1be40aaaa6cf5884542919c11'),
          ('source_metric_audit_revision_guard', '16c87e61856986987a4794412c9e6dc2')) as want(name, digest)
  left join pg_proc p on p.proname = want.name and p.pronamespace = 'training_load'::regnamespace;

-- 4. T8's action CHECK is v34's (sixteen actions) and T8's table comment is
--    v34's text (the migration refuses on the CHECK; the rollback restores
--    both verbatim).
--    Expected: action_check_is_v34 = true, comment_is_v34 = true.
select
  coalesce((select pg_get_constraintdef(oid) = 'CHECK ((action = ANY (ARRAY[''source_metric_create''::text, ''source_metric_revision_create''::text, ''source_metric_unit_verified''::text, ''source_metric_meaning_verified''::text, ''source_metric_revision_activate''::text, ''source_metric_revision_retire''::text, ''source_metric_retire''::text, ''mapping_create''::text, ''mapping_version_create''::text, ''mapping_status''::text, ''mapping_version_replaced''::text, ''activation_start''::text, ''activation_end''::text, ''unit_conversion_create''::text, ''unit_conversion_retire''::text, ''source_instance_end''::text])))'
              from pg_constraint where conrelid = 'training_load.source_metric_audit'::regclass
               and conname = 'source_metric_audit_action_check'), false) as action_check_is_v34,
  coalesce(obj_description('training_load.source_metric_audit'::regclass, 'pg_class')
    = 'v34 (D10, T8): append-only record of every source metric, mapping, activation, unit conversion and source instance operation. No metadata column; reason and evidence_ref are bounded, format-checked and never name an athlete or carry a value.', false) as comment_is_v34;

-- 5. Nothing v65 creates exists yet (a name it would collide with), every
--    trigger of T8 is enabled, and the objects it relies on are there by
--    name.
--    Expected: v65_tables = 0, v65_functions = 0, v65_audit_objects = 0,
--    disabled_triggers = 0, t8_triggers = 7, replaced_functions = 4,
--    relied_on_functions = 7.
select
  (select count(*) from pg_class c where c.relnamespace = 'training_load'::regnamespace
     and c.relname in ('source_metric_confirmations', 'source_metric_confirmation_sessions', 'source_metric_confirmation_items')) as v65_tables,
  (select count(*) from pg_proc p where p.pronamespace = 'training_load'::regnamespace
     and (p.proname like 'source\_metric\_confirmation%' or p.proname in ('source_metric_display_unit_ok', 'remove_expired_confirmation_values'))) as v65_functions,
  (select count(*) from pg_attribute where attrelid = 'training_load.source_metric_audit'::regclass and attname = 'confirmation_id' and not attisdropped)
    + (select count(*) from pg_constraint where conrelid = 'training_load.source_metric_audit'::regclass
        and conname in ('source_metric_audit_confirmation_fk', 'source_metric_audit_confirmation_iff', 'source_metric_audit_erased_reason_check'))
    + (select count(*) from pg_class c where c.relnamespace = 'training_load'::regnamespace and c.relname = 'source_metric_audit_v65_confirmation_once') as v65_audit_objects,
  (select count(*) from pg_trigger t where t.tgrelid = 'training_load.source_metric_audit'::regclass and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers,
  (select count(*) from pg_trigger t where t.tgrelid = 'training_load.source_metric_audit'::regclass and not t.tgisinternal) as t8_triggers,
  (select count(*) from pg_proc p where p.pronamespace = 'training_load'::regnamespace
     and p.proname in ('source_metric_audit_row_ok', 'source_metric_audit_actor_guard', 'source_metric_audit_insert_guard', 'source_metric_audit_revision_guard')) as replaced_functions,
  (select count(*) from pg_proc p where p.pronamespace = 'training_load'::regnamespace
     and p.proname in ('source_metric_context_actor', 'source_metric_current_xmin', 'source_metric_actor_basis', 'source_metric_binding_club',
                       'source_metric_value_matches', 'source_metric_append_only', 'source_metric_no_truncate')) as relied_on_functions;

-- 6. The migrator's role may do it: it owns T8 (the column, the CHECKs, the
--    index, the comment) and the four functions it replaces, and may create
--    in the training_load schema.
--    Expected: owns_t8 = true, owned_functions = 4, may_create = true.
select
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_audit'::regclass)) = current_user as owns_t8,
  (select count(*) from pg_proc p where p.pronamespace = 'training_load'::regnamespace
     and p.proname in ('source_metric_audit_row_ok', 'source_metric_audit_actor_guard', 'source_metric_audit_insert_guard', 'source_metric_audit_revision_guard')
     and pg_get_userbyid(p.proowner) = current_user) as owned_functions,
  has_schema_privilege(current_user, 'training_load', 'CREATE') as may_create;

-- 7. No database- or role-level default for the actor setting or the purge
--    marker.
--    Expected: setting_defaults = 0.
select count(*) as setting_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%' or cfg like 'optimove.source_metric_confirmation_purge=%';

-- 8. A quiet moment. v65 takes SHARE ROW EXCLUSIVE on T4, then, through its
--    new foreign keys, on public.clubs, public.teams, public.users, the source
--    connections and bindings, the import checks and the source revisions,
--    each waiting for a writer of that table up to the runner's lock_timeout.
--    Only then it takes ACCESS EXCLUSIVE on T8 with NOWAIT, so any lock on T8
--    at that moment (a reader included: the Mappings screen, a replay, every
--    mapping write) fails it at once. No check and no identity load is
--    running, and no session is idle in a transaction.
--    Expected: t8_locks = 0, t4_writers = 0, fk_table_writers = 0,
--    running_checks = 0, running_identity_loads = 0, idle_in_transaction = 0. A non-zero lock
--    count that is gone when the block is run again a few seconds later was an
--    ordinary short read or write, not a blocker; the deploy then follows the
--    clean run at once.
--    A role without pg_read_all_stats sees only its own role's sessions' state
--    in pg_stat_activity, so idle_in_transaction counts the application role's
--    sessions (the only expected writer); pg_locks is not limited that way, and
--    is read for this database only (a relation id is unique per database).
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation = 'training_load.source_metric_audit'::regclass) as t8_locks,
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation = 'training_load.source_metric_mapping_versions'::regclass
      and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')) as t4_writers,
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation in ('public.clubs'::regclass, 'public.teams'::regclass, 'public.users'::regclass,
                         'training_load.source_credential_connections'::regclass, 'training_load.source_team_bindings'::regclass,
                         'training_load.gpexe_import_checks'::regclass, 'training_load.source_metric_definition_versions'::regclass)
      and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')) as fk_table_writers,
  (select count(*) from training_load.gpexe_import_checks where status = 'running') as running_checks,
  (select count(*) from training_load.gpexe_athlete_identity_requests where status = 'running') as running_identity_loads,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;

-- 9. A sanity line: no T8 row carries one of the three actions v65 adds (v34's
--    CHECK refuses them, so a non-zero count means the CHECK was dropped at
--    some point: stop and report).
--    Expected: new_action_rows = 0.
select count(*) as new_action_rows
  from training_load.source_metric_audit
 where action in ('mapping_confirmation', 'confirmation_values_expired', 'confirmation_values_erased');

-- 10. Information, not a condition of v65 (nothing writes a value before
--     J18's 18-3): how the server logs statements. From 18-3 on, a save
--     inserts two athletes' values with bind parameters; a server that logs
--     statements with their parameters would write those values to its log.
--     Expected: nothing; report the four values to the *Rukovodilac* for
--     18-3.
select current_setting('log_statement') as log_statement,
       current_setting('log_min_duration_statement') as log_min_duration_statement,
       current_setting('log_parameter_max_length') as log_parameter_max_length,
       current_setting('log_parameter_max_length_on_error') as log_parameter_max_length_on_error;

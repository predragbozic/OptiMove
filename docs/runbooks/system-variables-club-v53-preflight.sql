-- v53 production preflight - READ ONLY. For the *Rukovodilac*, on the day of
-- the merge of the phase 7i-B1 pull request, under the standing order for
-- migration PRs (docs/ai/metrics-core-plan.md, section 2): each numbered block
-- verbatim through the connector, in its own read-only transaction that is
-- rolled back (section 2, step 5). The owner may run the same blocks in the
-- Supabase SQL Editor, as the application's DATABASE_URL role (the one the
-- migrator uses).
-- Migration: migrations_v2/202611041000_training_load_v53_system_variables_club.sql;
-- contract docs/ai/phase7i-system-variables-club-contract.md (J15), section 7.
--
-- Run ONE numbered block at a time: the editor shows only the result of the
-- last statement it ran. Every block is a plain SELECT, so nothing is written
-- and no transaction is left open. The expected values are in the comments;
-- any other value means: stop, change nothing, report the block, the column
-- and the value.
--
-- The deploy follows block 8 at once (J15 section 7.6): v53 takes the request
-- table ACCESS EXCLUSIVE and T5 SHARE ROW EXCLUSIVE, both NOWAIT, so a busy
-- table at that moment fails the migration with nothing applied, and the
-- deploy is repeated at a quiet moment.

-- 1. PostgreSQL 15 or later, as v41 already needs.
--    Expected: pg15_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 150000 as pg15_or_later;

-- 2. The migration state: v52 (phase 7h, the last migrations_v2 migration)
--    recorded once with the repository's checksum; v53 absent and nothing
--    recorded at or after its name (the migrator runs files in name order).
--    Expected: v52_rows = 1, v52_checksum_ok = true, v53_rows = 0,
--    at_or_after_v53 = 0, and last_migration sorts before v53's name (v52, or
--    a later migration merged before v53; on 2026-11-04
--    migrations_v2/202611031200_exercise_english_content.sql).
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql') as v52_rows,
  (select bool_and(checksum = 'b2648244871d6460e5803219bf8de16aa2d83eed5fc6de0f029843a27e180918') from public.schema_migrations
    where migration_name = 'migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql') as v52_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611041000_training_load_v53_system_variables_club.sql') as v53_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202611041000_training_load_v53_system_variables_club.sql') as at_or_after_v53,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. The two bodies v53 replaces are the ones in force: v36's request insert
--    guard and v48's T5 insert guard (the migration checks the same md5s and
--    refuses otherwise; the rollback restores exactly these bodies).
--    Expected: request_guard_is_v36 = true, t5_guard_is_v48 = true.
select
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'metric_variable_requests_insert_guard') as request_guard_is_v36,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_activations_insert_guard') as t5_guard_is_v48
  from (values
          ('metric_variable_requests_insert_guard', 'ae5bf5e22620546a83cf955b8b1d9a9d'),
          ('source_metric_activations_insert_guard', 'e47f75d4a7a6c63659a19491db97d678')) as want(name, digest)
  left join pg_proc p on p.proname = want.name and p.pronamespace = 'training_load'::regnamespace;

-- 4. The request table is as v36, v38 and v45 left it: v45's operation CHECK,
--    v38's version_iff, v36's one-create index and v38's insert trigger (the
--    migration refuses otherwise; the rollback restores them).
--    Expected: every column = true.
select
  coalesce((select pg_get_constraintdef(oid) = 'CHECK ((operation = ANY (ARRAY[''variable_create''::text, ''variable_version_create''::text, ''variable_rename''::text, ''variable_archive''::text, ''variable_restore''::text, ''variable_icon''::text])))'
              from pg_constraint where conrelid = 'training_load.metric_variable_requests'::regclass
               and conname = 'metric_variable_requests_operation_check'), false) as operation_check_is_v45,
  coalesce((select pg_get_constraintdef(oid) = 'CHECK (((metric_definition_version_id IS NOT NULL) = (operation = ANY (ARRAY[''variable_create''::text, ''variable_version_create''::text]))))'
              from pg_constraint where conrelid = 'training_load.metric_variable_requests'::regclass
               and conname = 'metric_variable_requests_version_iff'), false) as version_iff_is_v38,
  coalesce((select indexdef = 'CREATE UNIQUE INDEX metric_variable_requests_one_create_per_definition ON training_load.metric_variable_requests USING btree (metric_definition_id) WHERE (operation = ''variable_create''::text)'
              from pg_indexes where schemaname = 'training_load' and indexname = 'metric_variable_requests_one_create_per_definition'), false) as index_is_v36,
  coalesce((select pg_get_triggerdef(t.oid) = 'CREATE TRIGGER metric_variable_requests_insert_guard BEFORE INSERT ON training_load.metric_variable_requests FOR EACH ROW WHEN ((new.operation = ANY (ARRAY[''variable_create''::text, ''variable_version_create''::text]))) EXECUTE FUNCTION training_load.metric_variable_requests_insert_guard()'
              from pg_trigger t where t.tgrelid = 'training_load.metric_variable_requests'::regclass
               and t.tgname = 'metric_variable_requests_insert_guard'), false) as trigger_is_v38;

-- 5. Nothing v53 creates exists yet (no collision), and every trigger of the
--    request table and T5 is enabled.
--    Expected: new_tables = 0, new_functions = 0, operation_id_column = 0,
--    disabled_triggers = 0.
select
  (select count(*) from pg_class c where c.relnamespace = 'training_load'::regnamespace
     and c.relname in ('metric_definition_copies', 'source_metric_mapping_version_copies', 'metric_definition_club_hides')) as new_tables,
  (select count(*) from pg_proc p where p.pronamespace = 'training_load'::regnamespace
     and p.proname in ('club_variable_rows_append_only', 'metric_definition_copies_insert_guard', 'metric_definition_copies_request_link', 'source_metric_mapping_version_copies_insert_guard', 'source_metric_mapping_version_copies_audit_link', 'metric_definition_club_hides_insert_guard', 'metric_definition_club_hides_update_guard', 'metric_definition_club_hides_xact_link')) as new_functions,
  (select count(*) from information_schema.columns
    where table_schema = 'training_load' and table_name = 'metric_variable_requests' and column_name = 'operation_id') as operation_id_column,
  (select count(*) from pg_trigger t
    where t.tgrelid in ('training_load.metric_variable_requests'::regclass, 'training_load.source_metric_mapping_activations'::regclass)
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 6. The migrator's role may do it: it owns the request table (its column,
--    CHECKs, index and trigger), T5 (its lock) and the two functions it
--    replaces, and may create in the schema.
--    Expected: owns_requests = true, owns_t5 = true, owned_functions = 2,
--    may_create = true.
select
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.metric_variable_requests'::regclass)) = current_user as owns_requests,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_mapping_activations'::regclass)) = current_user as owns_t5,
  (select count(*) from pg_proc p where p.pronamespace = 'training_load'::regnamespace
     and p.proname in ('metric_variable_requests_insert_guard', 'source_metric_activations_insert_guard')
     and pg_get_userbyid(p.proowner) = current_user) as owned_functions,
  has_schema_privilege(current_user, 'training_load', 'CREATE') as may_create;

-- 7. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 8. A quiet moment. v53 takes ACCESS EXCLUSIVE on the request table with
--    NOWAIT, so any lock on it (a reader included: the Variables screen, a
--    rename, an archive) fails it at once; then SHARE ROW EXCLUSIVE on T5 with
--    NOWAIT, which a writer (ROW EXCLUSIVE or stronger: S1, S2, A1, A2, an
--    Unbind's end) fails at once. The new tables' foreign keys then take SHARE
--    ROW EXCLUSIVE on public.clubs, public.users, metric_definitions,
--    metric_definition_versions and T4 within the runner's lock_timeout. No
--    check and no identity load is running, and no session is idle in a
--    transaction. The import switch must be off (a Render variable, not
--    readable here: confirm it on Render before the deploy).
--    Expected: request_locks = 0, t5_writers = 0, fk_target_writers = 0,
--    running_checks = 0, running_identity_loads = 0, idle_in_transaction = 0.
--    A non-zero lock count that is gone when the block is run again a few
--    seconds later was an ordinary short read or write, not a blocker; the
--    deploy then follows the clean run at once.
--    A role without pg_read_all_stats sees only its own role's sessions' state
--    in pg_stat_activity, so idle_in_transaction counts the application role's
--    sessions (the only expected writer); pg_locks is not limited that way, and
--    is read for this database only (a relation id is unique per database).
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation = 'training_load.metric_variable_requests'::regclass) as request_locks,
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation = 'training_load.source_metric_mapping_activations'::regclass
      and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')) as t5_writers,
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation in ('public.clubs'::regclass, 'public.users'::regclass, 'training_load.metric_definitions'::regclass,
                         'training_load.metric_definition_versions'::regclass, 'training_load.source_metric_mapping_versions'::regclass)
      and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')) as fk_target_writers,
  (select count(*) from training_load.gpexe_import_checks where status = 'running') as running_checks,
  (select count(*) from training_load.gpexe_athlete_identity_requests where status = 'running') as running_identity_loads,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;

-- 9. Read only, for the owner (J15 section 7.6): the active system variables
--    a copy would refuse with copy_source_unsupported, by reason. Any value is
--    acceptable; report the counts.
--    Expected: any numbers (reported with the preflight).
select
  count(*) filter (where v.value_type <> 'numeric') as not_numeric,
  count(*) filter (where v.value_type = 'numeric' and (v.unit is null or not training_load.source_metric_unit_token_ok(v.unit))) as unit_not_token,
  count(*) filter (where v.value_type = 'numeric' and v.condition_description is not null) as with_condition_to_review,
  count(*) filter (where exists (select 1 from training_load.metric_definition_scope_capabilities sc where sc.metric_definition_id = d.id and sc.scope_level = 'day')) as day_level,
  count(*) filter (where not exists (select 1 from training_load.metric_definition_scope_capabilities sc where sc.metric_definition_id = d.id)) as no_levels,
  count(*) as active_system_variables
  from training_load.metric_definitions d
  join training_load.metric_definition_versions v on v.id = d.current_version_id
 where d.owner_scope = 'system' and d.state = 'active';

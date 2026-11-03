-- v52 production preflight - READ ONLY. For the *Rukovodilac*, on the day of
-- the merge of the phase 7h pull request (7h-B), under the standing order for
-- migration PRs (docs/ai/metrics-core-plan.md, section 2): each numbered block
-- verbatim through the connector, in its own read-only transaction that is
-- rolled back (section 2, step 5). The owner may run the same blocks in the
-- Supabase SQL Editor, as the application's DATABASE_URL role (the one the
-- migrator uses).
-- Migration: migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql;
-- contract docs/ai/phase7h-club-admin-mappings-contract.md (J14), section 6.
--
-- Run ONE numbered block at a time: the editor shows only the result of the
-- last statement it ran. Every block is a plain SELECT, so nothing is written
-- and no transaction is left open. The expected values are in the comments;
-- any other value means: stop, change nothing, report the block, the column
-- and the value.
--
-- The deploy follows block 8 at once (J14 section 6.3): v52 takes T4 with
-- NOWAIT, so a T4 that is busy at that moment fails the migration with nothing
-- applied, and the deploy is repeated at a quiet moment.

-- 1. PostgreSQL 15 or later, as v41 already needs.
--    Expected: pg15_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 150000 as pg15_or_later;

-- 2. The migration state: v51 (the calendar's settings, the last
--    migrations_v2 migration) recorded once with the repository's checksum;
--    v52 absent and nothing recorded at or after its name (the migrator runs
--    files in name order).
--    Expected: v51_rows = 1, v51_checksum_ok = true, v52_rows = 0,
--    at_or_after_v52 = 0, and
--    last_migration = migrations_v2/202611011900_calendar_v51_settings.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611011900_calendar_v51_settings.sql') as v51_rows,
  (select bool_and(checksum = 'b727cb0f74bb8bc41ee816c33995f1ab3df721ebac7bf77b861fd9e9b9f38cff') from public.schema_migrations
    where migration_name = 'migrations_v2/202611011900_calendar_v51_settings.sql') as v51_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql') as v52_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql') as at_or_after_v52,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. The four bodies v52 replaces are the ones in force: v34's T4 update guard
--    and v48's source_metric_audit_row_ok, source_metric_audit_actor_guard and
--    source_metric_activations_update_guard (the migration checks the same
--    md5s and refuses otherwise; the rollback restores exactly these bodies).
--    Expected: every column = true.
select
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_mapping_versions_update_guard') as t4_guard_is_v34,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_audit_row_ok') as row_ok_is_v48,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_audit_actor_guard') as actor_guard_is_v48,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_activations_update_guard') as t5_guard_is_v48
  from (values
          ('source_metric_mapping_versions_update_guard', '4b64be0b9bed0368cb9bae9fc6d53b17'),
          ('source_metric_audit_row_ok', '764f4ad70de273a443be84bc9bebd87a'),
          ('source_metric_audit_actor_guard', '3622725a1b0d454767704b2021db731c'),
          ('source_metric_activations_update_guard', 'f4ce8781c0f1797663064cd4e5c63929')) as want(name, digest)
  left join pg_proc p on p.proname = want.name and p.pronamespace = 'training_load'::regnamespace;

-- 4. T4's two basis CHECKs are v34's (platform_admin only) and T4's table
--    comment is v34's text (the migration refuses on the CHECKs; the rollback
--    restores both and the comment verbatim).
--    Expected: activated_check_is_v34 = true, disabled_check_is_v34 = true,
--    comment_is_v34 = true.
select
  coalesce((select pg_get_constraintdef(oid) = 'CHECK (((activated_basis IS NULL) OR (activated_basis = ''platform_admin''::text)))'
              from pg_constraint where conrelid = 'training_load.source_metric_mapping_versions'::regclass
               and conname = 'source_metric_mapping_versions_activated_basis_check'), false) as activated_check_is_v34,
  coalesce((select pg_get_constraintdef(oid) = 'CHECK (((disabled_basis IS NULL) OR (disabled_basis = ''platform_admin''::text)))'
              from pg_constraint where conrelid = 'training_load.source_metric_mapping_versions'::regclass
               and conname = 'source_metric_mapping_versions_disabled_basis_check'), false) as disabled_check_is_v34,
  coalesce(obj_description('training_load.source_metric_mapping_versions'::regclass, 'pg_class')
    = 'v34 (D6, T4): one approved, immutable way to turn one source revision into one canonical version. Created as draft only after the unit is proven; draft -> needs_review -> active -> disabled; only a platform admin activates or disables. parameter_fingerprint is computed by the database.', false) as comment_is_v34;

-- 5. Every trigger of T4, T5 and T8 is enabled, and the objects v52 relies on
--    are there by name: it creates no table, column, trigger or index, so it
--    cannot collide with one; it drops and re-adds T4's two named CHECKs and
--    replaces four functions in place.
--    Expected: disabled_triggers = 0, t4_triggers = 6, t5_triggers = 5,
--    t8_triggers = 7, basis_checks = 2, replaced_functions = 4.
select
  (select count(*) from pg_trigger t
    where t.tgrelid in ('training_load.source_metric_mapping_versions'::regclass,
                        'training_load.source_metric_mapping_activations'::regclass,
                        'training_load.source_metric_audit'::regclass)
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers,
  (select count(*) from pg_trigger t where t.tgrelid = 'training_load.source_metric_mapping_versions'::regclass and not t.tgisinternal) as t4_triggers,
  (select count(*) from pg_trigger t where t.tgrelid = 'training_load.source_metric_mapping_activations'::regclass and not t.tgisinternal) as t5_triggers,
  (select count(*) from pg_trigger t where t.tgrelid = 'training_load.source_metric_audit'::regclass and not t.tgisinternal) as t8_triggers,
  (select count(*) from pg_constraint where conrelid = 'training_load.source_metric_mapping_versions'::regclass
     and conname in ('source_metric_mapping_versions_activated_basis_check', 'source_metric_mapping_versions_disabled_basis_check')) as basis_checks,
  (select count(*) from pg_proc p where p.pronamespace = 'training_load'::regnamespace
     and p.proname in ('source_metric_mapping_versions_update_guard', 'source_metric_audit_row_ok',
                       'source_metric_audit_actor_guard', 'source_metric_activations_update_guard')) as replaced_functions;

-- 6. The migrator's role may do it: it owns T4 (the CHECK swap and the
--    comment), T5 and T8 (their locks) and the four functions it replaces.
--    Expected: owns_t4 = true, owns_t5 = true, owns_t8 = true,
--    owned_functions = 4.
select
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_mapping_versions'::regclass)) = current_user as owns_t4,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_mapping_activations'::regclass)) = current_user as owns_t5,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_audit'::regclass)) = current_user as owns_t8,
  (select count(*) from pg_proc p where p.pronamespace = 'training_load'::regnamespace
     and p.proname in ('source_metric_mapping_versions_update_guard', 'source_metric_audit_row_ok',
                       'source_metric_audit_actor_guard', 'source_metric_activations_update_guard')
     and pg_get_userbyid(p.proowner) = current_user) as owned_functions;

-- 7. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 8. A quiet moment. v52 takes ACCESS EXCLUSIVE on T4 with NOWAIT, so any lock
--    on T4 (a reader included: the Mappings screen, A1, A2, S1, S2, the
--    importer's FOR SHARE read) fails it at once; then SHARE ROW EXCLUSIVE on
--    T5 and T8, which waits for a writer (ROW EXCLUSIVE or stronger) up to the
--    runner's lock_timeout. No check and no identity load is running, and no
--    session is idle in a transaction. The import switch must be off (it is a
--    Render variable, not readable here: confirm it on Render before the
--    deploy).
--    Expected: t4_locks = 0, t5_t8_writers = 0, running_checks = 0,
--    running_identity_loads = 0, idle_in_transaction = 0. A non-zero lock
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
      and l.relation = 'training_load.source_metric_mapping_versions'::regclass) as t4_locks,
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation in ('training_load.source_metric_mapping_activations'::regclass, 'training_load.source_metric_audit'::regclass)
      and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')) as t5_t8_writers,
  (select count(*) from training_load.gpexe_import_checks where status = 'running') as running_checks,
  (select count(*) from training_load.gpexe_athlete_identity_requests where status = 'running') as running_identity_loads,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;

-- 9. A sanity line: no row of the kinds only phase 7h can write (the
--    rollback refuses once one exists). Before v52 the CHECKs and the guards
--    refuse every one of them, so a non-zero count here means a trigger was
--    disabled at some point: stop and report. The club_admin rows phase 7d and
--    M2 already write (mapping_create, mapping_version_create,
--    draft -> needs_review, activation_start, activation_end with admin_ended)
--    are not counted.
--    Expected: t4_club_transitions = 0, t8_club_transitions = 0,
--    t5_club_version_ends = 0, t8_club_version_end_rows = 0.
select
  (select count(*) from training_load.source_metric_mapping_versions
    where activated_basis = 'club_admin' or disabled_basis = 'club_admin') as t4_club_transitions,
  (select count(*) from training_load.source_metric_audit
    where basis = 'club_admin'
      and ((action = 'mapping_status' and to_status in ('active', 'disabled')) or action = 'mapping_version_replaced')) as t8_club_transitions,
  (select count(*) from training_load.source_metric_mapping_activations
    where ended_basis = 'club_admin' and end_reason in ('mapping_version_replaced', 'mapping_version_disabled')) as t5_club_version_ends,
  (select count(*) from training_load.source_metric_audit a
     join training_load.source_metric_mapping_activations m on m.id = a.activation_id
    where a.action = 'activation_end' and a.basis = 'club_admin'
      and m.end_reason in ('mapping_version_replaced', 'mapping_version_disabled')) as t8_club_version_end_rows;

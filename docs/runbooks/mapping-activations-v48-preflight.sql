-- v48 production preflight - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), on the day of the merge and deploy of the phase 7d pull request
-- (migrations_v2/202610301900_training_load_v48_mapping_activations.sql;
-- contract docs/ai/phase7d-mapping-activations-contract.md, section 6.4).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. PostgreSQL 15 or later, as v41 already needs.
--    Expected: pg15_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 150000 as pg15_or_later;

-- 2. The migration state: v47 recorded once with the repository's checksum and
--    the last migrations_v2 migration; v48 absent and nothing recorded at or
--    after its name (the migrator runs files in name order).
--    Expected: v47_rows = 1, v47_checksum_ok = true, v48_rows = 0,
--    at_or_after_v48 = 0, and
--    last_migration = migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql') as v47_rows,
  (select bool_and(checksum = '665ef79f74689eb19fa8a41fad84268c17029aa38c322adaac2f88b841dabd66') from public.schema_migrations
    where migration_name = 'migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql') as v47_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301900_training_load_v48_mapping_activations.sql') as v48_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202610301900_training_load_v48_mapping_activations.sql') as at_or_after_v48,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. The six bodies v48 replaces are the ones in force (the rollback restores
--    exactly these): v34's two T5 guards, v34's source_metric_audit_row_ok and
--    source_metric_audit_insert_guard, v35's source_metric_audit_actor_guard
--    and v47's source_metric_audit_revision_guard.
--    Expected: every column = true.
select
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_activations_insert_guard') as t5_insert_guard_is_v34,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_activations_update_guard') as t5_update_guard_is_v34,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_audit_row_ok') as audit_row_ok_is_v34,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_audit_insert_guard') as audit_insert_guard_is_v34,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_audit_actor_guard') as audit_actor_guard_is_v35,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_audit_revision_guard') as audit_revision_guard_is_v47
  from (values
          ('source_metric_activations_insert_guard', '952419fb6e5ca1622186d1f8e41e5655'),
          ('source_metric_activations_update_guard', '99a66865f2be42bd1405638e7e969629'),
          ('source_metric_audit_row_ok', 'c429d9d9803d6246ac0f933d852efea9'),
          ('source_metric_audit_insert_guard', 'd50ee5b8a41ef998b30f1ecb4bb8b108'),
          ('source_metric_audit_actor_guard', 'edff9dc1d2b8b2f7911544b712c0bca2'),
          ('source_metric_audit_revision_guard', '3bb6d69a0b1a54dda8ca0e1a9c5319be')) as want(name, digest)
  left join pg_proc p on p.proname = want.name and p.pronamespace = 'training_load'::regnamespace;

-- 4. HARD ASSERTION: no T5 activation and no activation audit row exists (no
--    writer existed before phase 7d; the rollback refuses once one does).
--    Expected: activations = 0, activation_audit_rows = 0, safe_to_merge = true.
select
  (select count(*) from training_load.source_metric_mapping_activations) as activations,
  (select count(*) from training_load.source_metric_audit where action in ('activation_start', 'activation_end')) as activation_audit_rows,
  (select count(*) from training_load.source_metric_mapping_activations) = 0
    and (select count(*) from training_load.source_metric_audit where action in ('activation_start', 'activation_end')) = 0 as safe_to_merge;

-- 5. Every team binding's connection is club-owned with an owner club (the
--    *Rukovodilac*'s note (iii): v48 refuses a start on any other binding, so
--    one would refuse in production with no visible reason).
--    Expected: bindings_without_club = 0; bindings_total any value.
select
  count(*) filter (where c.owner_scope is distinct from 'club' or c.owner_club_id is null) as bindings_without_club,
  count(*) as bindings_total
  from training_load.source_team_bindings b
  left join training_load.source_credential_connections c on c.id = b.connection_id;

-- 6. No v48 object exists yet (no name collision), and T5's two basis CHECKs
--    are v34's.
--    Expected: v48_functions = 0, v48_triggers = 0, v48_index = 0,
--    basis_checks_are_v34 = true.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('source_metric_binding_club', 'source_metric_activations_start_link', 'source_metric_activations_end_link')) as v48_functions,
  (select count(*) from pg_trigger t where t.tgrelid = 'training_load.source_metric_mapping_activations'::regclass and t.tgname like '%_v48_%') as v48_triggers,
  (select count(*) from pg_class where relname = 'source_metric_audit_v48_activation_once') as v48_index,
  (select count(*) from pg_constraint c where c.conrelid = 'training_load.source_metric_mapping_activations'::regclass
      and ((c.conname = 'source_metric_activations_activated_basis_check'
            and pg_get_constraintdef(c.oid) = 'CHECK ((activated_basis = ''platform_admin''::text))')
        or (c.conname = 'source_metric_activations_ended_basis_check'
            and pg_get_constraintdef(c.oid) = 'CHECK (((ended_basis IS NULL) OR (ended_basis = ''platform_admin''::text)))'))) = 2 as basis_checks_are_v34;

-- 7. The migrator's role may do it: CREATE on the schema (three functions), and
--    ownership of both tables (the CHECKs, the triggers and the index); every
--    trigger of the two tables is enabled.
--    Expected: schema_create = true, owns_activations = true, owns_audit = true,
--    disabled_triggers = 0.
select
  has_schema_privilege(current_user, 'training_load', 'CREATE') as schema_create,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_mapping_activations'::regclass)) = current_user as owns_activations,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_audit'::regclass)) = current_user as owns_audit,
  (select count(*) from pg_trigger t
    where t.tgrelid in ('training_load.source_metric_mapping_activations'::regclass, 'training_load.source_metric_audit'::regclass)
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 8. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 9. A quiet moment: v48 takes ACCESS EXCLUSIVE on the activations (so every
--    read of them - an A1 or A2, the revision lifecycle, a T6 guard - waits for
--    its short run) and SHARE ROW EXCLUSIVE on the audit table, so no other
--    session holds a lock on either table, and none is idle in a transaction.
--    Expected: table_locks = 0, idle_in_transaction = 0. A non-zero
--    table_locks that is gone when the block is run again a few seconds later
--    was an ordinary short read or write, not a blocker.
--    A role without pg_read_all_stats sees only its own role's sessions' state in
--    pg_stat_activity, so idle_in_transaction counts the application role's
--    sessions (the only expected writer); pg_locks is not limited that way, and
--    is read for this database only (a relation id is unique per database).
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation in ('training_load.source_metric_mapping_activations'::regclass, 'training_load.source_metric_audit'::regclass)) as table_locks,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;

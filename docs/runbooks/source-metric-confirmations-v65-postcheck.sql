-- v65 production post-check - READ ONLY. For the *Rukovodilac*, after the
-- owner's deploy of J18's 18-1 pull request (step 6 of the standing order for
-- migration PRs, docs/ai/metrics-core-plan.md, section 2): each numbered block
-- verbatim through the connector, in its own read-only transaction that is
-- rolled back (section 2, step 5). The owner may run the same blocks in the
-- Supabase SQL Editor.
-- Migration: migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql;
-- contract docs/ai/c112-drag-mapping-contract.md (J18), sections 5 and 15.3
-- (migration M-A).
--
-- Run ONE numbered block at a time. Every block is a plain SELECT. Any value
-- other than the expected one means: stop, change nothing, report the block,
-- the column and the value.

-- 1. v65 recorded once, with the repository's checksum, as the last
--    migrations_v2 migration.
--    Expected: v65_rows = 1, v65_checksum_ok = true, later_migrations = 0.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql') as v65_rows,
  (select bool_and(checksum = '9af6bdc3ea9fc96f0955492dd5e3ce17552bd3a8d735c4b5f563625ceca6f8d7') from public.schema_migrations
    where migration_name = 'migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql') as v65_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql') as later_migrations;

-- 2. The four bodies v65 replaced are v65's (the rollback refuses unless they
--    are).
--    Expected: bodies_v65 = 4.
select count(*) filter (where md5(p.prosrc) = want.digest) as bodies_v65
  from (values
          ('source_metric_audit_row_ok', '0ef48fd391a5380f70c92d96f47f894a'),
          ('source_metric_audit_actor_guard', 'b1b324ff092858d677a6635893646b1c'),
          ('source_metric_audit_insert_guard', 'cbfa726d60658dbba0198ab97192219e'),
          ('source_metric_audit_revision_guard', 'c2e8814af337acb6a2355b77a0bc1b1e')) as want(name, digest)
  join pg_proc p on p.proname = want.name and p.pronamespace = 'training_load'::regnamespace;

-- 3. The three tables, T8's new column, its three constraints and its index
--    exist; T8's action CHECK lists nineteen actions; T8's comment is v65's.
--    Expected: tables = 3, audit_column = 1, audit_constraints = 3,
--    audit_index = 1, action_check_is_v65 = true, comment_is_v65 = true.
select
  (select count(*) from pg_class c where c.relnamespace = 'training_load'::regnamespace and c.relkind = 'r'
     and c.relname in ('source_metric_confirmations', 'source_metric_confirmation_sessions', 'source_metric_confirmation_items')) as tables,
  (select count(*) from pg_attribute where attrelid = 'training_load.source_metric_audit'::regclass and attname = 'confirmation_id' and not attisdropped) as audit_column,
  (select count(*) from pg_constraint where conrelid = 'training_load.source_metric_audit'::regclass and convalidated
     and conname in ('source_metric_audit_confirmation_fk', 'source_metric_audit_confirmation_iff', 'source_metric_audit_erased_reason_check')) as audit_constraints,
  (select count(*) from pg_indexes where schemaname = 'training_load' and indexname = 'source_metric_audit_v65_confirmation_once') as audit_index,
  coalesce((select pg_get_constraintdef(oid) = 'CHECK ((action = ANY (ARRAY[''source_metric_create''::text, ''source_metric_revision_create''::text, ''source_metric_unit_verified''::text, ''source_metric_meaning_verified''::text, ''source_metric_revision_activate''::text, ''source_metric_revision_retire''::text, ''source_metric_retire''::text, ''mapping_create''::text, ''mapping_version_create''::text, ''mapping_status''::text, ''mapping_version_replaced''::text, ''activation_start''::text, ''activation_end''::text, ''unit_conversion_create''::text, ''unit_conversion_retire''::text, ''source_instance_end''::text, ''mapping_confirmation''::text, ''confirmation_values_expired''::text, ''confirmation_values_erased''::text])))'
              from pg_constraint where conrelid = 'training_load.source_metric_audit'::regclass
               and conname = 'source_metric_audit_action_check'), false) as action_check_is_v65,
  coalesce(obj_description('training_load.source_metric_audit'::regclass, 'pg_class')
    = 'v34 (D10, T8): append-only record of every source metric, mapping, activation, unit conversion and source instance operation, and from v65 of every confirmation and of an acting user''s removal of its values. No metadata column; reason and evidence_ref are bounded, format-checked and never name an athlete or carry a value; confirmation_id is a typed link, never a value.', false) as comment_is_v65;

-- 4. Every trigger of the three tables and of T8 is there by name, enabled,
--    and calls its function (v65 created eleven; T8 keeps its seven).
--    Expected: expected_enabled = 18, triggers_total = 18.
select
  (select count(*)
     from (values
             ('source_metric_confirmations', 'source_metric_confirmations_insert_guard', 'source_metric_confirmations_insert_guard'),
             ('source_metric_confirmations', 'source_metric_confirmations_append_only', 'source_metric_append_only'),
             ('source_metric_confirmations', 'source_metric_confirmations_no_truncate', 'source_metric_no_truncate'),
             ('source_metric_confirmations', 'source_metric_confirmations_commit_link', 'source_metric_confirmations_commit_link'),
             ('source_metric_confirmation_sessions', 'source_metric_confirmation_sessions_insert_guard', 'source_metric_confirmation_sessions_insert_guard'),
             ('source_metric_confirmation_sessions', 'source_metric_confirmation_sessions_append_only', 'source_metric_append_only'),
             ('source_metric_confirmation_sessions', 'source_metric_confirmation_sessions_no_truncate', 'source_metric_no_truncate'),
             ('source_metric_confirmation_items', 'source_metric_confirmation_items_insert_guard', 'source_metric_confirmation_items_insert_guard'),
             ('source_metric_confirmation_items', 'source_metric_confirmation_items_update_guard', 'source_metric_confirmation_items_update_guard'),
             ('source_metric_confirmation_items', 'source_metric_confirmation_items_no_truncate', 'source_metric_no_truncate'),
             ('source_metric_confirmation_items', 'source_metric_confirmation_items_removal_link', 'source_metric_confirmation_items_removal_link'),
             ('source_metric_audit', 'source_metric_audit_append_only', 'source_metric_append_only'),
             ('source_metric_audit', 'source_metric_audit_insert_guard', 'source_metric_audit_insert_guard'),
             ('source_metric_audit', 'source_metric_audit_no_truncate', 'source_metric_no_truncate'),
             ('source_metric_audit', 'source_metric_audit_v35_actor_guard', 'source_metric_audit_actor_guard'),
             ('source_metric_audit', 'source_metric_audit_v37_revision_guard', 'source_metric_audit_revision_guard'),
             ('source_metric_audit', 'source_metric_audit_v43_replacement_link', 'source_metric_audit_replacement_link'),
             ('source_metric_audit', 'source_metric_audit_v43_transition_facts', 'source_metric_audit_transition_facts')) as want(rel, tgname, proname)
     join pg_trigger t on t.tgname = want.tgname and not t.tgisinternal and t.tgenabled = 'O'
     join pg_class c on c.oid = t.tgrelid and c.relname = want.rel and c.relnamespace = 'training_load'::regnamespace
     join pg_proc p on p.oid = t.tgfoid and p.proname = want.proname) as expected_enabled,
  (select count(*) from pg_trigger t
    where t.tgrelid in ('training_load.source_metric_confirmations'::regclass,
                        'training_load.source_metric_confirmation_sessions'::regclass,
                        'training_load.source_metric_confirmation_items'::regclass,
                        'training_load.source_metric_audit'::regclass)
      and not t.tgisinternal) as triggers_total;

-- 5. Nothing is written yet: no confirmation, no session, no row, and no T8
--    row of a confirmation (no code writes them before J18's 18-3; the
--    rollback refuses once one exists).
--    Expected: confirmations = 0, sessions = 0, items = 0, audit_rows = 0.
select
  (select count(*) from training_load.source_metric_confirmations) as confirmations,
  (select count(*) from training_load.source_metric_confirmation_sessions) as sessions,
  (select count(*) from training_load.source_metric_confirmation_items) as items,
  (select count(*) from training_load.source_metric_audit
    where confirmation_id is not null
       or action in ('mapping_confirmation', 'confirmation_values_expired', 'confirmation_values_erased')) as audit_rows;

-- 6. Nothing left behind: no session holds a lock on T4, T8 or the three
--    tables, nobody holds the migrator's advisory lock 822026, and no session
--    is idle in a transaction.
--    Expected: table_locks = 0, migrator_lock = 0, idle_in_transaction = 0. A
--    non-zero table_locks that is gone a few seconds later was an ordinary
--    read of the running application, not a leftover.
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation in ('training_load.source_metric_mapping_versions'::regclass,
                         'training_load.source_metric_audit'::regclass,
                         'training_load.source_metric_confirmations'::regclass,
                         'training_load.source_metric_confirmation_sessions'::regclass,
                         'training_load.source_metric_confirmation_items'::regclass)) as table_locks,
  (select count(*) from pg_locks l
    where l.locktype = 'advisory' and l.classid = 0 and l.objid = 822026 and l.objsubid = 1
      and l.database = (select oid from pg_database where datname = current_database())) as migrator_lock,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;

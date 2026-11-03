-- v52 production post-check - READ ONLY. For the *Rukovodilac*, after the
-- owner's deploy of the phase 7h pull request (7h-B; step 6 of the standing
-- order for migration PRs, docs/ai/metrics-core-plan.md, section 2), before
-- any club admin activates, replaces or disables a version: each numbered
-- block verbatim through the connector, in its own read-only transaction that
-- is rolled back (section 2, step 5). The owner may run the same blocks in the
-- Supabase SQL Editor.
-- Migration: migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql;
-- contract docs/ai/phase7h-club-admin-mappings-contract.md (J14), section 6.
--
-- Run ONE numbered block at a time. Every block is a plain SELECT. Any value
-- other than the expected one means: stop, change nothing, report the block,
-- the column and the value.

-- 1. v52 recorded once, with the repository's checksum, as the last
--    migrations_v2 migration.
--    Expected: v52_rows = 1, v52_checksum_ok = true, later_migrations = 0.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql') as v52_rows,
  (select bool_and(checksum = 'b2648244871d6460e5803219bf8de16aa2d83eed5fc6de0f029843a27e180918') from public.schema_migrations
    where migration_name = 'migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql') as v52_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql') as later_migrations;

-- 2. The four bodies v52 replaced are v52's (the rollback refuses unless they
--    are).
--    Expected: bodies_v52 = 4.
select count(*) filter (where md5(p.prosrc) = want.digest) as bodies_v52
  from (values
          ('source_metric_mapping_versions_update_guard', '42fb55a2dd043328079fa9b6f4a2c43e'),
          ('source_metric_audit_row_ok', 'a43a63c2d248cbaf71302468429acb85'),
          ('source_metric_activations_update_guard', 'c99759084f7be3febe084bf421aa7002'),
          ('source_metric_audit_actor_guard', '94cf466bfa765a1a03f7d290a3ce154a')) as want(name, digest)
  join pg_proc p on p.proname = want.name and p.pronamespace = 'training_load'::regnamespace;

-- 3. T4's two basis CHECKs admit club_admin, and T4's table comment is v52's
--    text.
--    Expected: activated_check_is_v52 = true, disabled_check_is_v52 = true,
--    comment_is_v52 = true.
select
  coalesce((select pg_get_constraintdef(oid) = 'CHECK (((activated_basis IS NULL) OR (activated_basis = ANY (ARRAY[''platform_admin''::text, ''club_admin''::text]))))'
              from pg_constraint where conrelid = 'training_load.source_metric_mapping_versions'::regclass
               and conname = 'source_metric_mapping_versions_activated_basis_check'), false) as activated_check_is_v52,
  coalesce((select pg_get_constraintdef(oid) = 'CHECK (((disabled_basis IS NULL) OR (disabled_basis = ANY (ARRAY[''platform_admin''::text, ''club_admin''::text]))))'
              from pg_constraint where conrelid = 'training_load.source_metric_mapping_versions'::regclass
               and conname = 'source_metric_mapping_versions_disabled_basis_check'), false) as disabled_check_is_v52,
  coalesce(obj_description('training_load.source_metric_mapping_versions'::regclass, 'pg_class')
    = 'v34 (D6, T4): one approved, immutable way to turn one source revision into one canonical version. Created as draft only after the unit is proven; draft -> needs_review -> active -> disabled; activated or disabled by a platform admin and, for a club mapping''s version, also by its club''s active admin (v52, C108, J14). parameter_fingerprint is computed by the database.', false) as comment_is_v52;

-- 4. Every trigger of T4, T5 and T8 is there by name, enabled, and calls the
--    function it called before v52 (v52 replaced bodies, never a trigger).
--    Expected: expected_enabled = 18, triggers_total = 18.
select
  (select count(*)
     from (values
             ('source_metric_mapping_versions', 'source_metric_mapping_versions_insert_guard', 'source_metric_mapping_versions_insert_guard'),
             ('source_metric_mapping_versions', 'source_metric_mapping_versions_no_truncate', 'source_metric_no_truncate'),
             ('source_metric_mapping_versions', 'source_metric_mapping_versions_update_guard', 'source_metric_mapping_versions_update_guard'),
             ('source_metric_mapping_versions', 'source_metric_mapping_versions_v35_actor_guard', 'source_metric_mapping_versions_actor_guard'),
             ('source_metric_mapping_versions', 'source_metric_mapping_versions_v35_audit_link_insert', 'source_metric_mapping_versions_audit_link'),
             ('source_metric_mapping_versions', 'source_metric_mapping_versions_v35_audit_link_update', 'source_metric_mapping_versions_audit_link'),
             ('source_metric_mapping_activations', 'source_metric_activations_insert_guard', 'source_metric_activations_insert_guard'),
             ('source_metric_mapping_activations', 'source_metric_activations_no_truncate', 'source_metric_no_truncate'),
             ('source_metric_mapping_activations', 'source_metric_activations_update_guard', 'source_metric_activations_update_guard'),
             ('source_metric_mapping_activations', 'source_metric_activations_v48_audit_link_end', 'source_metric_activations_end_link'),
             ('source_metric_mapping_activations', 'source_metric_activations_v48_audit_link_start', 'source_metric_activations_start_link'),
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
    where t.tgrelid in ('training_load.source_metric_mapping_versions'::regclass,
                        'training_load.source_metric_mapping_activations'::regclass,
                        'training_load.source_metric_audit'::regclass)
      and not t.tgisinternal) as triggers_total;

-- 5. No row of the kinds only phase 7h can write yet (this post-check runs
--    before the first club admin's activation, replacement or disable; the
--    rollback refuses once one exists).
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

-- 6. Nothing left behind: no session holds a lock on T4, T5 or T8, nobody
--    holds the migrator's advisory lock 822026, and no session is idle in a
--    transaction.
--    Expected: table_locks = 0, migrator_lock = 0, idle_in_transaction = 0. A
--    non-zero table_locks that is gone a few seconds later was an ordinary
--    read of the running application, not a leftover.
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation in ('training_load.source_metric_mapping_versions'::regclass,
                         'training_load.source_metric_mapping_activations'::regclass,
                         'training_load.source_metric_audit'::regclass)) as table_locks,
  (select count(*) from pg_locks l
    where l.locktype = 'advisory' and l.classid = 0 and l.objid = 822026 and l.objsubid = 1
      and l.database = (select oid from pg_database where datname = current_database())) as migrator_lock,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;

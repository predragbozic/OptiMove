-- v50 production post-check - READ ONLY. For the *Rukovodilac*, after its
-- deploy of the phase 7g pull request (step 6 of the standing order for
-- migration PRs, docs/ai/metrics-core-plan.md, section 2), before any source
-- instance is ended: each numbered block verbatim through the connector, in a
-- read-only transaction that is rolled back (section 2, step 5). The owner may
-- run the same blocks in the Supabase SQL Editor.
-- Migration: migrations_v2/202610311200_training_load_v50_source_instance_end.sql;
-- contract docs/ai/phase7g-source-instance-end-contract.md, section 6.
--
-- Run ONE numbered block at a time. Every block is a plain SELECT. Any value
-- other than the expected one means: stop, change nothing, report the block,
-- the column and the value.

-- 1. v50 recorded once, with the repository's checksum, as the last
--    migrations_v2 migration.
--    Expected: v50_rows = 1, v50_checksum_ok = true, later_migrations = 0.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610311200_training_load_v50_source_instance_end.sql') as v50_rows,
  (select bool_and(checksum = '19827e52b91364d1ee86201642b27a8e81570b231925d42edd69034a0685e6e6') from public.schema_migrations
    where migration_name = 'migrations_v2/202610311200_training_load_v50_source_instance_end.sql') as v50_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610311200_training_load_v50_source_instance_end.sql') as later_migrations;

-- 2. The three function bodies are v50's: the revision guard it replaced and
--    the two it added.
--    Expected: bodies_v50 = 3.
select count(*) filter (where md5(p.prosrc) = want.digest) as bodies_v50
  from (values
          ('source_metric_audit_revision_guard', '16c87e61856986987a4794412c9e6dc2'),
          ('metric_source_connections_state_guard', 'dc5df075b4836478bb8005acec15f212'),
          ('metric_source_connections_end_link', '587a3aab90a9d7109a503bb7d0e5c8b5')) as want(name, digest)
  join pg_proc p on p.proname = want.name and p.pronamespace = 'training_load'::regnamespace;

-- 3. The state guard: enabled, BEFORE UPDATE (tgtype 19), not deferrable, with
--    its WHEN clause; the audit link: enabled, deferrable and initially
--    deferred, AFTER UPDATE (tgtype 17); each calling its v50 function.
--    Expected: guard_ok = true, link_ok = true.
select
  exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
           where t.tgrelid = 'training_load.metric_source_connections'::regclass and t.tgenabled = 'O'
             and t.tgname = 'metric_source_connections_v50_state_guard' and t.tgtype = 19 and not t.tgdeferrable
             and t.tgqual is not null and p.proname = 'metric_source_connections_state_guard') as guard_ok,
  exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
           where t.tgrelid = 'training_load.metric_source_connections'::regclass and t.tgenabled = 'O'
             and t.tgname = 'metric_source_connections_v50_audit_link_end' and t.tgtype = 17
             and t.tgdeferrable and t.tginitdeferred and p.proname = 'metric_source_connections_end_link') as link_ok;

-- 4. The once-index is valid, ready and unique.
--    Expected: index_ok = true.
select coalesce((select i.indisvalid and i.indisready and i.indisunique from pg_index i
                  where i.indexrelid = to_regclass('training_load.source_metric_audit_v50_instance_end_once')), false) as index_ok;

-- 5. No source instance ended yet (this post-check runs before the first one).
--    Expected: instance_end_rows = 0, inactive_keyed = 0.
select
  (select count(*) from training_load.source_metric_audit where action = 'source_instance_end') as instance_end_rows,
  (select count(*) from training_load.metric_source_connections where source_host_key is not null and state = 'inactive') as inactive_keyed;

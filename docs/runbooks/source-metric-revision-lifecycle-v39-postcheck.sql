-- v39 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), after the deploy of the phase 4 merge served /api/health with ok: true.
-- v40 is deployed with v39; its own post-check is
-- docs/runbooks/source-metric-text-rules-v40-postcheck.sql.
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. The migration record: v39 recorded exactly once with the repository's
--    checksum; v40, deployed with it, the only later migration; v38 still
--    recorded once with its checksum.
--    Expected: v39_rows = 1, v39_checksum_ok = true, later_rows = 1,
--    last_migration = migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql,
--    v38_rows = 1, v38_checksum_ok = true.
--    (If v40 was removed after its fail-closed refusal - the recovery of the v40
--    runbook section -: later_rows = 0 and last_migration is v39's own name.)
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql') as v39_rows,
  (select bool_and(checksum = '3e77aa69c91d9558cd3983a3fdb2279b39367aa4800c6c029cca6bbeec8b3196') from public.schema_migrations
    where migration_name = 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql') as v39_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql') as v38_rows,
  (select bool_and(checksum = '30ca41f33d3aa35f4fb9e7c1a652a2f572d9475a1666cfa3a5e593e0b6cc79cc') from public.schema_migrations
    where migration_name = 'migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql') as v38_checksum_ok;

-- 2. The three functions: v37's two guards now carry v39's bodies (each holds a
--    sentence only v39 writes), and v39's audit link exists.
--    Expected: actor_guard_is_v39 = true, audit_guard_is_v39 = true, lifecycle_link = 1.
select
  (select bool_and(position('a seed marker is written only by a seeding migration' in p.prosrc) > 0)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_revisions_actor_guard') as actor_guard_is_v39,
  (select bool_and(position('the revision change already has its audit row' in p.prosrc) > 0)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_audit_revision_guard') as audit_guard_is_v39,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_revisions_lifecycle_link') as lifecycle_link;

-- 3. The two v39 triggers exist on the revisions table, are enabled, and are
--    deferrable and initially deferred; v37's three triggers are still there and
--    enabled (two of them now run v39's bodies).
--    Expected: v39_triggers = 2, v39_triggers_enabled = 2, v39_deferred_links = 2,
--    missing_triggers = {} (empty), v37_triggers_enabled = 3.
with expected(name) as (values
  ('source_metric_revisions_v39_audit_link_insert'), ('source_metric_revisions_v39_audit_link_state')),
found as (
  select t.tgname as name, t.tgenabled, t.tgdeferrable, t.tginitdeferred
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid and c.relname = 'source_metric_definition_versions'
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'training_load'
   where t.tgname in (select name from expected))
select
  (select count(*) from found) as v39_triggers,
  (select count(*) from found where tgenabled = 'O') as v39_triggers_enabled,
  (select count(*) from found where tgdeferrable and tginitdeferred) as v39_deferred_links,
  array(select e.name from expected e where e.name not in (select name from found) order by 1) as missing_triggers,
  (select count(*) from pg_trigger t
    where t.tgenabled = 'O'
      and t.tgname in ('source_metric_revisions_v37_actor_guard', 'source_metric_revisions_v37_audit_link', 'source_metric_audit_v37_revision_guard')) as v37_triggers_enabled;

-- 4. The v39 index exists, is valid and is unique.
--    Expected: v39_indexes = 1, v39_indexes_valid = 1, v39_unique_once = 1.
select count(*) as v39_indexes,
       count(*) filter (where i.indisvalid and i.indisready) as v39_indexes_valid,
       count(*) filter (where i.indisunique) as v39_unique_once
  from pg_class ic
  join pg_namespace n on n.oid = ic.relnamespace and n.nspname = 'training_load'
  join pg_index i on i.indexrelid = ic.oid
 where ic.relname = 'source_metric_audit_v39_revision_once';

-- 5. Every trigger of the two guarded tables is enabled (v34's, v35's and v37's
--    beside v39's).
--    Expected: revision_triggers = 6, audit_triggers = 5, disabled_triggers = 0.
select
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname = 'source_metric_definition_versions' and not t.tgisinternal) as revision_triggers,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname = 'source_metric_audit' and not t.tgisinternal) as audit_triggers,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('source_metric_definition_versions', 'source_metric_audit')
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 6. The seeded revisions are unchanged and nothing was written by the
--    lifecycle yet (run right after the deploy, before any admin uses the new
--    routes; later, lifecycle_revisions and lifecycle_rows count real acts).
--    Expected: revisions = 9, seeded_unproven = 9, lifecycle_revisions = 0, lifecycle_rows = 0.
select
  (select count(*) from training_load.source_metric_definition_versions) as revisions,
  (select count(*) from training_load.source_metric_definition_versions
    where seed_migration is not null and state = 'active' and evidence_status = 'observed'
      and source_unit is null and source_bound_unit is null and bound_operator is null
      and unit_verified_at is null and meaning_verified_at is null) as seeded_unproven,
  (select count(*) from training_load.source_metric_definition_versions
    where created_by_user_id is not null or activated_by_user_id is not null or retired_by_user_id is not null) as lifecycle_revisions,
  (select count(*) from training_load.source_metric_audit
    where action in ('source_metric_revision_create', 'source_metric_revision_activate', 'source_metric_revision_retire')) as lifecycle_rows;

-- 7. No database- or role-level default for the actor setting, and no actor set
--    in this session.
--    Expected: actor_defaults = 0, no_session_actor = true.
select
  (select count(*) from pg_db_role_setting s, unnest(s.setconfig) as cfg
    where cfg like 'optimove.source_metric_actor=%') as actor_defaults,
  coalesce(current_setting('optimove.source_metric_actor', true), '') = '' as no_session_actor;

-- 8. No write in flight on the two tables: no lock on them held by another
--    session of this database, no session idle in a transaction.
--    Expected: table_locks = 0, idle_in_transaction = 0. table_locks counts
--    every lock, an ordinary read's included: a non-zero value that is gone
--    when the block is run again a few seconds later was a short read or
--    write, not a finding.
--    A role without pg_read_all_stats sees only its own role's sessions' state in
--    pg_stat_activity, so idle_in_transaction counts the application role's
--    sessions (the only expected writer); pg_locks is not limited that way, and
--    is read for this database only (a relation id is unique per database).
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation in ('training_load.source_metric_definition_versions'::regclass, 'training_load.source_metric_audit'::regclass)) as table_locks,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;

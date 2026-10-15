-- v37 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), after the deploy of the M2b merge served /api/health with ok: true.
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. The migration record: v37 recorded exactly once with the repository's
--    checksum, and it is the last migration; v36 is still recorded once with
--    its checksum.
--    Expected: v37_rows = 1, v37_checksum_ok = true, later_rows = 0,
--    last_migration = migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql,
--    v36_rows = 1, v36_checksum_ok = true.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql') as v37_rows,
  (select bool_and(checksum = 'f8e7488bd37ecfdbea02a20a3f51912b4d296a99b6a8ce085df94be80986882a') from public.schema_migrations
    where migration_name = 'migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql') as v37_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql') as v36_rows,
  (select bool_and(checksum = '33d6e165c052c9b77335358a4f1d10ebd16858454c2621a2b55c77a1b1b3be04') from public.schema_migrations
    where migration_name = 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql') as v36_checksum_ok;

-- 2. The three v37 functions exist in training_load.
--    Expected: v37_functions = 3, missing_functions = {} (empty).
with expected(name) as (values
  ('source_metric_revisions_actor_guard'), ('source_metric_audit_revision_guard'), ('source_metric_revisions_audit_link'))
select
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname in (select name from expected)) as v37_functions,
  array(select e.name from expected e where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'training_load' and p.proname = e.name) order by 1) as missing_functions;

-- 3. The three v37 triggers exist on their own tables and are enabled; the
--    audit link is deferrable and initially deferred.
--    Expected: v37_triggers = 3, v37_triggers_enabled = 3, v37_deferred_links = 1,
--    missing_triggers = {} (empty).
with expected(tbl, name, deferred) as (values
  ('source_metric_definition_versions', 'source_metric_revisions_v37_actor_guard', false),
  ('source_metric_definition_versions', 'source_metric_revisions_v37_audit_link', true),
  ('source_metric_audit', 'source_metric_audit_v37_revision_guard', false)),
found as (
  select e.name, e.deferred, t.tgenabled, t.tgdeferrable, t.tginitdeferred
    from expected e
    join pg_class c on c.relname = e.tbl
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'training_load'
    join pg_trigger t on t.tgrelid = c.oid and t.tgname = e.name)
select
  (select count(*) from found) as v37_triggers,
  (select count(*) from found where tgenabled = 'O') as v37_triggers_enabled,
  (select count(*) from found where deferred and tgdeferrable and tginitdeferred) as v37_deferred_links,
  array(select e.name from expected e where e.name not in (select name from found) order by 1) as missing_triggers;

-- 4. The v37 index exists and is valid.
--    Expected: v37_index = 1, v37_index_valid = 1.
select count(*) as v37_index,
       count(*) filter (where i.indisvalid and i.indisready) as v37_index_valid
  from pg_class ic
  join pg_namespace n on n.oid = ic.relnamespace and n.nspname = 'training_load'
  join pg_index i on i.indexrelid = ic.oid
 where ic.relname = 'source_metric_audit_v37_revision_idx';

-- 5. Every trigger of the two guarded tables is enabled (v34's and v35's
--    beside v37's).
--    Expected: revision_triggers = 4, audit_triggers = 5, disabled_triggers = 0.
select
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname = 'source_metric_definition_versions' and not t.tgisinternal) as revision_triggers,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname = 'source_metric_audit' and not t.tgisinternal) as audit_triggers,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('source_metric_definition_versions', 'source_metric_audit')
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 6. No source field was confirmed: the nine seeded revisions keep no proof and
--    no verification audit row exists (C91: no confirmation of a production
--    field before the revision lifecycle exists and the evidence is merged).
--    Expected: revisions = 9, seeded_unproven = 9, verification_rows = 0.
select
  (select count(*) from training_load.source_metric_definition_versions) as revisions,
  (select count(*) from training_load.source_metric_definition_versions
    where seed_migration is not null and state = 'active' and evidence_status = 'observed'
      and source_unit is null and source_bound_unit is null and bound_operator is null
      and unit_verified_at is null and meaning_verified_at is null) as seeded_unproven,
  (select count(*) from training_load.source_metric_audit
    where action in ('source_metric_unit_verified', 'source_metric_meaning_verified')) as verification_rows;

-- 7. No database- or role-level default for the actor setting, and no actor set
--    in this session.
--    Expected: actor_defaults = 0, no_session_actor = true.
select
  (select count(*) from pg_db_role_setting s, unnest(s.setconfig) as cfg
    where cfg like 'optimove.source_metric_actor=%') as actor_defaults,
  coalesce(current_setting('optimove.source_metric_actor', true), '') = '' as no_session_actor;

-- 8. No write in flight on the two tables: no lock on them held by another
--    session of this database, no session idle in a transaction.
--    Expected: table_locks = 0, idle_in_transaction = 0.
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

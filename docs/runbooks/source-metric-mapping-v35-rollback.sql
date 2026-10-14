-- Rollback of migration v35 (the database actor guards of the source metric
-- mapping writes):
-- migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/source-metric-mapping-v35.test.mjs: apply ->
-- rollback -> the v34 catalog again -> re-apply, and every refusal below).
-- Before it is run anywhere real: a fresh restore-verified backup exists; the
-- deployed commit no longer contains the v35 migration file (otherwise the
-- migrator applies v35 again at the next start); the application code may be
-- either the M2 service with the actor setting (which v34 simply ignores) or
-- the one before it; and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- v35 adds functions, triggers and two partial indexes on the audit table: no
-- column, table or data. It removes them and the v35 record. Rows written under v35 stay valid under
-- v34, so no data blocks it. It refuses, changing nothing, when
--   * v35 is not recorded on the database;
--   * any migrations_v2 migration newer than v35 is recorded;
--   * the v35 functions, triggers and indexes are not exactly the ones v35
--     created (one is missing, or a trigger is disabled) - a changed state is a use
--     of its own, and the way forward is a new migration.
-- After the rollback the database refuses no T3 / T4 / T8 write that v34
-- accepts: the actor guards and the audit link are gone.
--
-- One transaction: everything or nothing. Waits are bounded: a stalled
-- transaction that holds one of the tables makes this script fail after 5 s.
-- Run it as one script that stops at the first error
-- (psql -v ON_ERROR_STOP=1 -f ...): after a refusal the open transaction is
-- aborted and nothing is changed.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql') then
    raise exception 'v35 rollback refused: v35 is not recorded on this database';
  end if;
end $$;

-- The order of the M2 writes: mappings, versions, audit.
lock table training_load.source_metric_mappings, training_load.source_metric_mapping_versions,
  training_load.source_metric_audit in access exclusive mode;

do $$
declare
  v35 constant text := 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql';
  reasons text[] := '{}';
  newer text;
  missing text;
  disabled text;
begin
  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name like 'migrations_v2/%' and migration_name > v35;
  if newer is not null then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  select string_agg(f.name, ', ' order by f.name) into missing
    from unnest(array[
      'source_metric_context_actor', 'source_metric_actor_basis', 'source_metric_current_xmin',
      'source_metric_mappings_actor_guard', 'source_metric_mapping_versions_actor_guard', 'source_metric_audit_actor_guard',
      'source_metric_mappings_audit_link', 'source_metric_mapping_versions_audit_link']) as f(name)
   where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'training_load' and p.proname = f.name);
  if missing is not null then
    reasons := array_append(reasons, 'the v35 functions are not all present');
  end if;
  select string_agg(t.name, ', ' order by t.name) into missing
    from unnest(array[
      'source_metric_mappings_v35_actor_guard', 'source_metric_mappings_v35_audit_link',
      'source_metric_mapping_versions_v35_actor_guard', 'source_metric_mapping_versions_v35_audit_link_insert',
      'source_metric_mapping_versions_v35_audit_link_update', 'source_metric_audit_v35_actor_guard']) as t(name)
   where not exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'training_load' and g.tgname = t.name and not g.tgisinternal);
  if missing is not null then
    reasons := array_append(reasons, 'the v35 triggers are not all present');
  end if;
  select string_agg(i.name, ', ' order by i.name) into missing
    from unnest(array['source_metric_audit_v35_mapping_create_idx', 'source_metric_audit_v35_version_idx']) as i(name)
   where not exists (select 1 from pg_indexes where schemaname = 'training_load' and indexname = i.name);
  if missing is not null then
    reasons := array_append(reasons, 'the v35 indexes are not all present');
  end if;
  select string_agg(g.tgname, ', ' order by g.tgname) into disabled
    from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'training_load' and g.tgname like '%\_v35\_%' and g.tgenabled <> 'O';
  if disabled is not null then
    reasons := array_append(reasons, 'a v35 trigger is disabled');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v35 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

drop trigger source_metric_audit_v35_actor_guard on training_load.source_metric_audit;
drop trigger source_metric_mapping_versions_v35_audit_link_update on training_load.source_metric_mapping_versions;
drop trigger source_metric_mapping_versions_v35_audit_link_insert on training_load.source_metric_mapping_versions;
drop trigger source_metric_mapping_versions_v35_actor_guard on training_load.source_metric_mapping_versions;
drop trigger source_metric_mappings_v35_audit_link on training_load.source_metric_mappings;
drop trigger source_metric_mappings_v35_actor_guard on training_load.source_metric_mappings;

drop function training_load.source_metric_mapping_versions_audit_link();
drop function training_load.source_metric_mappings_audit_link();
drop function training_load.source_metric_audit_actor_guard();
drop function training_load.source_metric_mapping_versions_actor_guard();
drop function training_load.source_metric_mappings_actor_guard();
drop function training_load.source_metric_current_xmin();
drop function training_load.source_metric_actor_basis(uuid, uuid);
drop function training_load.source_metric_context_actor();

drop index training_load.source_metric_audit_v35_version_idx;
drop index training_load.source_metric_audit_v35_mapping_create_idx;

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql';

commit;

-- Rollback of migration v37 (the database guards of the source-field evidence
-- confirmations, M2b):
-- migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/source-field-verification-m2b.test.mjs: apply ->
-- rollback -> the v36 catalog again -> re-apply, and every refusal below).
-- Before it is run anywhere real: a fresh restore-verified backup exists; the
-- deployed commit no longer contains the v37 migration file (otherwise the
-- migrator applies v37 again at the next start) nor the M2b routes that write
-- the verifications; and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- v37 adds three functions, three triggers (one of them a deferred constraint
-- trigger) and two indexes; no table, column or data. It removes them and the
-- v37 record. It refuses, changing nothing, when
--   * v37 is not recorded on the database;
--   * any migrations_v2 migration newer than v37 is recorded;
--   * any verification exists - a revision with a proven unit or meaning, or a
--     source_metric_unit_verified / source_metric_meaning_verified audit row
--     (C96: once a confirmation exists the way forward is a new migration,
--     never this script);
--   * the v37 functions, triggers or indexes are not exactly the ones v37
--     created (one is missing, or a trigger is disabled).
--
-- One transaction: everything or nothing. Waits are bounded: a transaction
-- that holds one of the two tables makes this script fail after 5 s. Dropping
-- a trigger or an index takes ACCESS EXCLUSIVE on its table until the COMMIT,
-- so reads of the two tables wait for that moment too; run it at a quiet
-- moment. Run it as one script that stops at the first error
-- (psql -v ON_ERROR_STOP=1 -f ...): after a refusal the open transaction is
-- aborted and nothing is changed.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql') then
    raise exception 'v37 rollback refused: v37 is not recorded on this database';
  end if;
end $$;

-- The checks read the two tables under the lock that keeps a new verification out.
lock table training_load.source_metric_definition_versions, training_load.source_metric_audit in share row exclusive mode;

do $$
declare
  v37 constant text := 'migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql';
  reasons text[] := '{}';
  newer text;
  missing text;
  disabled text;
begin
  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name like 'migrations_v2/%' and migration_name > v37;
  if newer is not null then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if exists (select 1 from training_load.source_metric_definition_versions
              where unit_verified_at is not null or meaning_verified_at is not null)
     or exists (select 1 from training_load.source_metric_audit
                 where action in ('source_metric_unit_verified', 'source_metric_meaning_verified')) then
    reasons := array_append(reasons, 'source metric verifications exist');
  end if;
  select string_agg(f.name, ', ' order by f.name) into missing
    from unnest(array['source_metric_revisions_actor_guard', 'source_metric_audit_revision_guard',
                      'source_metric_revisions_audit_link']) as f(name)
   where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'training_load' and p.proname = f.name);
  if missing is not null then
    reasons := array_append(reasons, 'the v37 functions are not all present');
  end if;
  select string_agg(t.name, ', ' order by t.name) into missing
    from (values ('source_metric_definition_versions', 'source_metric_revisions_v37_actor_guard'),
                 ('source_metric_definition_versions', 'source_metric_revisions_v37_audit_link'),
                 ('source_metric_audit', 'source_metric_audit_v37_revision_guard')) as t(tbl, name)
   where not exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'training_load' and c.relname = t.tbl and g.tgname = t.name);
  if missing is not null then
    reasons := array_append(reasons, 'the v37 triggers are not all present');
  end if;
  select string_agg(g.tgname, ', ' order by g.tgname) into disabled
    from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'training_load' and g.tgname like '%\_v37\_%' and g.tgenabled <> 'O';
  if disabled is not null then
    reasons := array_append(reasons, 'a v37 trigger is disabled');
  end if;
  if to_regclass('training_load.source_metric_audit_v37_revision_idx') is null
     or to_regclass('training_load.source_metric_audit_v37_verification_once') is null then
    reasons := array_append(reasons, 'the v37 indexes are not all present');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v37 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

drop trigger source_metric_revisions_v37_audit_link on training_load.source_metric_definition_versions;
drop trigger source_metric_revisions_v37_actor_guard on training_load.source_metric_definition_versions;
drop trigger source_metric_audit_v37_revision_guard on training_load.source_metric_audit;
drop function training_load.source_metric_revisions_audit_link();
drop function training_load.source_metric_revisions_actor_guard();
drop function training_load.source_metric_audit_revision_guard();
drop index training_load.source_metric_audit_v37_verification_once;
drop index training_load.source_metric_audit_v37_revision_idx;

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql';

commit;

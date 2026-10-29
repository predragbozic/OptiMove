-- Rollback of migration v43 (the audit of a mapping version's transitions;
-- phase 7b, C104):
-- migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/source-metric-mapping-transitions-7b.test.mjs:
-- apply -> rollback -> the v42 catalog, comments included, exactly -> re-apply,
-- and every refusal below). Before it is run anywhere real: a fresh
-- restore-verified backup exists; the deployed commit no longer contains the
-- v43 migration file (otherwise the migrator applies v43 again at the next
-- start); and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- A rollback of v43 needs no revert of the phase 7b code, and the reverse
-- (J8, section 7): the code writes rows that satisfy G1 and G2, and without
-- them its routes work unchanged - G1 and G2 are backstops only.
--
-- v43 adds two triggers on training_load.source_metric_audit and their two
-- functions; no table, column, constraint, index or data, and no other
-- function changed. This script drops exactly those four objects and removes
-- the v43 record; it changes no row. Every audit row written while v43 was
-- applied stays as it is (no rule ever checks a written row again). It
-- refuses, changing nothing, when
--   * the migrator is running (it holds the advisory lock 822026 of
--     backend/src/migrate.js; this script takes the same lock for its own
--     transaction, without waiting);
--   * v43 is not recorded on the database, or any later migrations_v2
--     migration is;
--   * a v43 function or trigger is missing, or a v43 trigger is disabled.
--
-- One transaction: everything or nothing. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f source-metric-mapping-transitions-v43-rollback.sql
-- (the script carries its own BEGIN and COMMIT, so no --single-transaction).
-- After a refusal the transaction is aborted and nothing is changed. Waits are
-- bounded: a transaction that holds the audit table makes this script fail
-- after 5 s.
begin;
set local lock_timeout = '5s';

-- The migrator's lock (MIGRATION_LOCK_KEY in backend/src/migrate.js), for this
-- transaction: no deploy can apply or record a migration while v43 is undone.
do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v43 rollback refused: the migrator is running';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql') then
    raise exception 'v43 rollback refused: v43 is not recorded on this database';
  end if;
end $$;

-- The table lock before the checks: no audit row is written, and no trigger of
-- T8 changes, until the COMMIT.
lock table training_load.source_metric_audit in share row exclusive mode;

do $$
declare
  v43 constant text := 'migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql';
  reasons text[] := '{}';
begin
  if exists (select 1 from public.schema_migrations
              where migration_name like 'migrations_v2/%' and migration_name > v43) then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load'
         and p.proname in ('source_metric_audit_replacement_link', 'source_metric_audit_transition_facts')) <> 2 then
    reasons := array_append(reasons, 'a v43 function is missing');
  end if;
  if (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'training_load' and c.relname = 'source_metric_audit'
         and t.tgname in ('source_metric_audit_v43_replacement_link', 'source_metric_audit_v43_transition_facts')) <> 2 then
    reasons := array_append(reasons, 'a v43 trigger is missing');
  elsif exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'training_load' and c.relname = 'source_metric_audit'
                   and t.tgname in ('source_metric_audit_v43_replacement_link', 'source_metric_audit_v43_transition_facts')
                   and t.tgenabled <> 'O') then
    reasons := array_append(reasons, 'a v43 trigger is disabled');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v43 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

drop trigger source_metric_audit_v43_transition_facts on training_load.source_metric_audit;
drop trigger source_metric_audit_v43_replacement_link on training_load.source_metric_audit;
drop function training_load.source_metric_audit_transition_facts();
drop function training_load.source_metric_audit_replacement_link();

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql';

commit;

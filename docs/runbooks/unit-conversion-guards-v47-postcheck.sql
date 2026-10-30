-- v47 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), after the deploy of the phase 7c merge served /api/health with
-- ok: true (contract docs/ai/phase7c-unit-conversions-contract.md,
-- section 6.8).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. The migration record: v47 recorded exactly once with the repository's
--    checksum, and it is the last migration; v46 still recorded once.
--    Expected: v47_rows = 1, v47_checksum_ok = true, later_rows = 0,
--    last_migration = migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql,
--    v46_rows = 1.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql') as v47_rows,
  (select bool_and(checksum = '665ef79f74689eb19fa8a41fad84268c17029aa38c322adaac2f88b841dabd66') from public.schema_migrations
    where migration_name = 'migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql') as v47_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301300_training_load_v46_classification_icons.sql') as v46_rows;

-- 2. The function bodies are the ones v47 wrote (the md5 of each body): the
--    audit guard with its conversion branch, the normal form, the actor guard
--    and the two links.
--    Expected: every column true.
select
  (select md5(p.prosrc) = '3bb6d69a0b1a54dda8ca0e1a9c5319be' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_audit_revision_guard') as revision_guard_is_v47,
  (select md5(p.prosrc) = 'cd6056ccebf68439981713f0088878a3' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_factor_pair_normal') as factor_pair_normal_is_v47,
  (select md5(p.prosrc) = 'b2e27ee88a0f616d7541c5c3824d9c61' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'unit_conversions_actor_guard') as actor_guard_is_v47,
  (select md5(p.prosrc) = '892e082e3b3cbcdbb716bf13a1ad3799' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'unit_conversions_create_link') as create_link_is_v47,
  (select md5(p.prosrc) = 'f2cc95ae491c31393435b1e8248badd0' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'unit_conversions_retire_link') as retire_link_is_v47;

-- 3. The three v47 triggers on unit_conversions, enabled, each calling its own
--    function: the actor guard a BEFORE INSERT OR UPDATE ROW trigger (tgtype
--    23), not deferrable; the two links AFTER ROW constraint triggers,
--    deferrable and initially deferred, on INSERT (tgtype 5) and on UPDATE
--    (tgtype 17), each with a WHEN clause.
--    Expected: three rows (tgname | tgtype | tgdeferrable | tginitdeferred |
--    tgenabled | calls_v47_function | has_when) -
--    unit_conversions_v47_actor_guard       | 23 | false | false | O | true | false
--    unit_conversions_v47_audit_link_insert |  5 | true  | true  | O | true | true
--    unit_conversions_v47_audit_link_retire | 17 | true  | true  | O | true | true
select t.tgname, t.tgtype, t.tgdeferrable, t.tginitdeferred, t.tgenabled,
       t.tgfoid = (case t.tgname when 'unit_conversions_v47_actor_guard' then 'training_load.unit_conversions_actor_guard()'::regprocedure
                                 when 'unit_conversions_v47_audit_link_insert' then 'training_load.unit_conversions_create_link()'::regprocedure
                                 else 'training_load.unit_conversions_retire_link()'::regprocedure end) as calls_v47_function,
       t.tgqual is not null as has_when
  from pg_trigger t
 where t.tgrelid = 'training_load.unit_conversions'::regclass and t.tgname like 'unit_conversions_v47_%'
 order by t.tgname;

-- 4. The once-index valid, and both CHECKs present and validated.
--    Expected: index_valid = true, checks_validated = 2.
select
  (select i.indisvalid from pg_index i where i.indexrelid = 'training_load.source_metric_audit_v47_conversion_once'::regclass) as index_valid,
  (select count(*) from pg_constraint c where c.conrelid = 'training_load.unit_conversions'::regclass
      and c.conname in ('unit_conversions_units_are_tokens', 'unit_conversions_factors_normal_form') and c.convalidated) as checks_validated;

-- 5. The rows as in the preflight (blocks 4 and 5): v47 writes none.
--    Expected: rows_total, seed_rows, api_rows and retired_rows equal to the
--    preflight's block 4 (unless a conversion was written through the API
--    since the deploy, which then shows here and in conversion_audit_rows);
--    conversion_audit_rows = api_rows + retired_rows.
select
  (select count(*) from training_load.unit_conversions) as rows_total,
  (select count(*) from training_load.unit_conversions where seed_migration is not null) as seed_rows,
  (select count(*) from training_load.unit_conversions where created_by_user_id is not null) as api_rows,
  (select count(*) from training_load.unit_conversions where state = 'retired') as retired_rows,
  (select count(*) from training_load.source_metric_audit where action in ('unit_conversion_create', 'unit_conversion_retire')) as conversion_audit_rows;

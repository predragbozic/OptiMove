-- v47 production preflight - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), on the day of the merge and deploy of the phase 7c pull request
-- (migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql;
-- contract docs/ai/phase7c-unit-conversions-contract.md, section 6.8).
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

-- 2. The migration state: v46 recorded once with the repository's checksum,
--    and v39 too (v47 replaces v39's body of the audit guard); v47 absent and
--    nothing recorded at or after its name (the migrator runs files in name
--    order).
--    Expected: v46_rows = 1, v46_checksum_ok = true, v39_rows = 1,
--    v39_checksum_ok = true, v47_rows = 0, at_or_after_v47 = 0, and
--    last_migration = migrations_v2/202610301300_training_load_v46_classification_icons.sql
--    (or a later migration of another schema whose name sorts before v47's).
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301300_training_load_v46_classification_icons.sql') as v46_rows,
  (select bool_and(checksum = 'b0390376d6ed2e01a4a1b216c120e29ce7d34d31d41e27fd313904b3cdef4e80') from public.schema_migrations
    where migration_name = 'migrations_v2/202610301300_training_load_v46_classification_icons.sql') as v46_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql') as v39_rows,
  (select bool_and(checksum = '3e77aa69c91d9558cd3983a3fdb2279b39367aa4800c6c029cca6bbeec8b3196') from public.schema_migrations
    where migration_name = 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql') as v39_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql') as v47_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql') as at_or_after_v47,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. The body in force of the audit guard is v39's (the rollback restores this
--    body, and the post-check shows v47's), and no v47 object exists yet (no
--    name collision).
--    Expected: revision_guard_is_v39 = true, v47_functions = 0, v47_triggers = 0,
--    v47_constraints = 0, v47_index = 0.
select
  (select md5(p.prosrc) = '43993e2f07a299c01c08b50e71ca46d8'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_audit_revision_guard') as revision_guard_is_v39,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('source_metric_factor_pair_normal', 'unit_conversions_actor_guard', 'unit_conversions_create_link', 'unit_conversions_retire_link')) as v47_functions,
  (select count(*) from pg_trigger t where t.tgrelid = 'training_load.unit_conversions'::regclass and t.tgname like 'unit_conversions_v47_%') as v47_triggers,
  (select count(*) from pg_constraint c where c.conrelid = 'training_load.unit_conversions'::regclass
      and c.conname in ('unit_conversions_units_are_tokens', 'unit_conversions_factors_normal_form')) as v47_constraints,
  (select count(*) from pg_class where relname = 'source_metric_audit_v47_conversion_once') as v47_index;

-- 4. HARD ASSERTION: every existing conversion passes both new rules - its two
--    units are unit tokens and its factor pair is in D5's full normal form -
--    so v47 applies (it refuses, changing nothing, otherwise). The rule is
--    spelled out here, since v47's own function does not exist yet. The counts
--    after it are information: the post-check (block 5) shows them again.
--    Expected: refused_rows = 0, safe_to_merge = true; rows_total, seed_rows,
--    api_rows and retired_rows any value (today: 4, 4, 0, 0 - the v34 seed).
with c as (
  select from_unit, to_unit, scale, scale_divisor, seed_migration, created_by_user_id, state,
         training_load.source_metric_unit_token_ok(from_unit) and training_load.source_metric_unit_token_ok(to_unit) as units_ok,
         scale > 0 and scale_divisor > 0
           and (scale_divisor = 1
                or (scale = 1 and (with recursive d(n) as (
                                      select replace(trim_scale(scale_divisor)::text, '.', '')::numeric
                                      union all
                                      select case when mod(n, 2) = 0 then div(n, 2) else div(n, 5) end from d
                                       where mod(n, 2) = 0 or mod(n, 5) = 0)
                                    select min(n) <> 1 from d))) as normal_ok
    from training_load.unit_conversions)
select
  count(*) filter (where not (units_ok and normal_ok)) as refused_rows,
  count(*) filter (where not (units_ok and normal_ok)) = 0 as safe_to_merge,
  count(*) as rows_total,
  count(*) filter (where seed_migration is not null) as seed_rows,
  count(*) filter (where created_by_user_id is not null) as api_rows,
  count(*) filter (where state = 'retired') as retired_rows
  from c;

-- 5. No unit conversion audit row exists (no writer of these actions exists
--    before v47: v39's guard refuses them).
--    Expected: conversion_audit_rows = 0.
select count(*) as conversion_audit_rows
  from training_load.source_metric_audit where action in ('unit_conversion_create', 'unit_conversion_retire');

-- 6. The migrator's role may do it: CREATE on the schema (four functions), and
--    ownership of both tables (the CHECKs, the triggers and the index); every
--    trigger of the two tables is enabled.
--    Expected: schema_create = true, owns_conversions = true, owns_audit = true,
--    disabled_triggers = 0.
select
  has_schema_privilege(current_user, 'training_load', 'CREATE') as schema_create,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.unit_conversions'::regclass)) = current_user as owns_conversions,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_audit'::regclass)) = current_user as owns_audit,
  (select count(*) from pg_trigger t
    where t.tgrelid in ('training_load.unit_conversions'::regclass, 'training_load.source_metric_audit'::regclass)
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 7. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 8. A quiet moment: v47 takes ACCESS EXCLUSIVE on unit_conversions (so every
--    read of it - GET /conversions, a mapping version's draft, an activation -
--    waits for its short run) and SHARE ROW EXCLUSIVE on the audit table, so no
--    other session holds a lock on either table, and none is idle in a
--    transaction.
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
      and l.relation in ('training_load.unit_conversions'::regclass, 'training_load.source_metric_audit'::regclass)) as table_locks,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;

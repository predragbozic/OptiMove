-- Rollback of migration v40 (Q10 part B, the database twins of the Metrics
-- Core admin text rules):
-- migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/source-revision-lifecycle-v39.test.mjs: v39 and
-- v40 applied -> this script -> the v39 catalog again -> v40 re-applied; and
-- after the lifecycle wrote revisions). Before it is run anywhere real: a
-- fresh restore-verified backup exists; the deployed commit no longer
-- contains the v40 migration file (otherwise the migrator applies v40 again
-- at the next start); and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- It is only for a v40 that is recorded. A v40 whose fail-closed DO block
-- refused at deploy is never recorded (its transaction rolled back): there is
-- nothing to roll back, and the recovery is in the v40 runbook section.
--
-- v40 replaces the two v34 text functions; no table, column, index or
-- trigger. This script restores the two v34 bodies verbatim and removes the
-- v40 record. The new rule only refused, so no row depends on it, and v34's
-- lists are a subset of v40's: whatever v39's state, it can run, also after
-- the lifecycle has written revisions. It refuses, changing nothing, when
--   * v40 is not recorded on the database;
--   * any migrations_v2 migration newer than v40 is recorded.
--
-- One transaction: everything or nothing. Run it as one script that stops at
-- the first error (psql -v ON_ERROR_STOP=1 -f ...): after a refusal the open
-- transaction is aborted and nothing is changed.
begin;
set local lock_timeout = '5s';

do $$
declare
  v40 constant text := 'migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v40) then
    raise exception 'v40 rollback refused: v40 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v40) then
    raise exception 'v40 rollback refused: later migrations are applied';
  end if;
end $$;

-- v34's two function bodies, verbatim (migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql).
create or replace function training_load.source_metric_text_ok(v text, max_len integer) returns boolean
  language sql immutable as $$
    select coalesce(v = btrim(v)
       and char_length(v) between 1 and max_len
       and v !~ '[\x01-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]', false)
  $$;

create or replace function training_load.source_metric_unit_token_ok(v text) returns boolean
  language sql immutable as $$
    select coalesce(char_length(v) between 1 and 30
       and v !~ '[\s|=\x01-\x1f\x7f-\x9f\u00a0\u00ad\u061c\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]', false)
  $$;

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql';

commit;

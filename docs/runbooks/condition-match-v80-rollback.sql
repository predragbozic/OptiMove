-- Rollback of migration v80 (a column without parameters matched to a variable with a condition):
-- migrations_v2/202611201100_training_load_v80_condition_match.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/condition-match-v80.test.mjs:
-- apply -> rollback -> the catalog before v80 exactly -> re-apply, on a database built by the migrations and on one built from
-- the legacy schema snapshot). Before it is run anywhere real: a fresh restore-verified backup exists; the deployed commit no
-- longer contains the v80 migration file (otherwise the migrator applies v80 again at the next start); and the owner approved
-- this database specifically (.claude/rules/database-safety.md).
--
-- v80 replaced no body of an earlier migration, so the rollback only removes what v80 added: the two triggers and their
-- functions, the two shape functions, the confirmations table, the five columns, and the v80 record. It changes no row of any
-- other table. It refuses, changing nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v80 is not recorded;
--   * a later training_load (Metrics Core) migration is recorded (it may build on v80's columns; another track's does not count);
--   * a mapping version carries a condition rule, an activation records a match, or a confirmation of an event setting exists
--     (dropping them would lose what an import was matched with; end and remove them through the service first, or keep v80).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f condition-match-v80-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v80 rollback refused: the migrator is running';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611201100_training_load_v80_condition_match.sql') then
    raise exception 'v80 rollback refused: v80 is not recorded';
  end if;
  -- A later Metrics Core migration may build on v80's columns: roll it back first. Another track's (the calendar's) does not.
  if exists (select 1 from public.schema_migrations
              where migration_name > 'migrations_v2/202611201100_training_load_v80_condition_match.sql'
                and migration_name like 'migrations_v2/%training_load%') then
    raise exception 'v80 rollback refused: a later training_load migration is recorded';
  end if;
end $$;

-- The three tables before the checks below (the migration's order, then the confirmations), so no rule, match or
-- confirmation can be written between the checks and the drops (the Independent's LOW-2 on PR #659).
lock table training_load.source_metric_mapping_versions, training_load.source_metric_mapping_activations,
           training_load.source_metric_event_setting_confirmations in access exclusive mode;

do $$
begin
  if exists (select 1 from training_load.source_metric_mapping_versions where condition_rule is not null) then
    raise exception 'v80 rollback refused: a mapping version carries a condition rule';
  end if;
  if exists (select 1 from training_load.source_metric_mapping_activations
              where matched_condition is not null or matched_source_range is not null or matched_threshold_set_id is not null or matched_at is not null) then
    raise exception 'v80 rollback refused: an activation records a match';
  end if;
  if exists (select 1 from training_load.source_metric_event_setting_confirmations) then
    raise exception 'v80 rollback refused: a confirmation of an event setting exists';
  end if;
end $$;

-- Versions before activations (the writers' own order and v80's).
drop trigger source_metric_mapping_versions_condition_guard on training_load.source_metric_mapping_versions;
drop trigger source_metric_mapping_activations_match_guard on training_load.source_metric_mapping_activations;
drop table training_load.source_metric_event_setting_confirmations;
drop function training_load.source_metric_event_setting_confirmations_guard();
drop function training_load.source_metric_mapping_versions_condition_guard();
drop function training_load.source_metric_mapping_activations_match_guard();
drop function training_load.condition_rule_fits(jsonb, jsonb);
drop function training_load.condition_rule_shape_ok(jsonb);
alter table training_load.source_metric_mapping_versions drop column condition_rule;
alter table training_load.source_metric_mapping_activations
  drop column matched_condition,
  drop column matched_source_range,
  drop column matched_threshold_set_id,
  drop column matched_at;

delete from public.schema_migrations where migration_name = 'migrations_v2/202611201100_training_load_v80_condition_match.sql';

commit;

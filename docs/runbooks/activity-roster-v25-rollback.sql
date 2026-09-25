-- Rollback of migration v25 (Phase 5a1, session roster foundation):
-- migrations_v2/202609251000_training_load_v25_activity_roster_foundation.sql
--
-- Not a migration and never run automatically. Rehearsed on a disposable copy
-- (see docs/runbooks/activity-roster-v25.md). Before it is run anywhere real:
--   * the application is back on a commit WITHOUT Phase 5a1 (the roster route
--     and the GPEXE approval's observations need these tables);
--   * a fresh, restore-verified backup exists;
--   * the owner approved this database specifically.
-- It removes the membership history recorded since v25, every source
-- observation and, once 5a2 exists, every coach decision and completion. A
-- roll-forward fix is preferred whenever one is possible.
--
-- One transaction: everything or nothing.
begin;

drop trigger if exists athlete_memberships_record_period on public.athlete_memberships;
drop trigger if exists athlete_memberships_protect_identity on public.athlete_memberships;
drop function if exists public.record_athlete_membership_period();
drop function if exists public.protect_athlete_membership_identity();

drop table if exists training.activity_source_observations;
drop function if exists training.check_activity_source_observation();
drop function if exists training.protect_activity_source_observation();

drop table if exists training.activity_completion_log;
drop function if exists training.protect_activity_completion_log();
drop table if exists training.activity_completions;
drop function if exists training.protect_activity_completion();

drop table if exists training.activity_athlete_decisions;
drop function if exists training.check_activity_athlete_decision_links();
drop function if exists training.check_activity_athlete_decision();
drop table if exists training.activity_roster_requests;
drop function if exists training.protect_activity_roster_request();

drop table if exists training.participation_reasons;
drop function if exists training.protect_participation_reason();

drop function if exists training.assert_canonical_team_activity(uuid, uuid, text);
drop function if exists training.lock_activity_decider(uuid, uuid, varchar);
drop function if exists training.activity_roster(uuid);

drop table if exists public.athlete_membership_periods;
drop function if exists public.protect_athlete_membership_period();
drop function if exists training.roster_history_no_truncate();

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202609251000_training_load_v25_activity_roster_foundation.sql';

commit;

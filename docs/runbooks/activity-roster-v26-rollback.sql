-- Rollback of migration v26 (Phase 5a2, roster decisions, completion and the
-- automatic needs review):
-- migrations_v2/202609252000_training_load_v26_activity_roster_decisions.sql
--
-- Not a migration and never run automatically. Rehearsed on a disposable copy
-- (backend/tests/activity-roster-5a2.test.mjs, "migration v26: apply,
-- rollback, apply again"). Before it is run anywhere real:
--   * the application is back on a commit WITHOUT Phase 5a2 (the roster write
--     routes need v26's functions; without v26 a completion would no longer
--     be downgraded by later changes);
--   * a fresh, restore-verified backup exists;
--   * the owner approved this database specifically.
-- It removes only functions, triggers and one index, and restores the v25
-- definition of training.lock_activity_decider. Every row stays: coach
-- decisions, requests, completions and their log remain as history and the
-- v25 roster read keeps reading them. A session left "complete" is then no
-- longer downgraded by a trigger; the read's fingerprint comparison (v25,
-- 5a1) still reports it as needs review / input_changed when its inputs
-- changed. A roll-forward fix is preferred whenever one is possible.
--
-- One transaction: everything or nothing.
begin;

drop trigger if exists activity_athlete_decisions_one_current_in_alias_set on training.activity_athlete_decisions;
drop trigger if exists activity_completion_log_rules on training.activity_completion_log;
drop trigger if exists activity_completions_audited on training.activity_completions;
drop trigger if exists activity_completions_rules on training.activity_completions;
drop index if exists training.activity_completion_log_revision_idx;

drop trigger if exists athlete_membership_periods_roster_update on public.athlete_membership_periods;
drop trigger if exists athlete_membership_periods_roster_insert on public.athlete_membership_periods;
drop trigger if exists activity_source_observations_roster_update on training.activity_source_observations;
drop trigger if exists activity_source_observations_roster_insert on training.activity_source_observations;
drop trigger if exists activities_roster_update on training.activities;
drop trigger if exists activity_participants_roster_update on training.activity_participants;
drop trigger if exists activity_metric_event_links_roster_update on training.activity_metric_event_links;
drop trigger if exists activity_metric_event_links_roster_insert on training.activity_metric_event_links;
drop trigger if exists activity_participant_metric_links_roster_update on training.activity_participant_metric_participant_links;
drop trigger if exists activity_participant_metric_links_roster_insert on training.activity_participant_metric_participant_links;
drop trigger if exists metric_source_identities_roster_update on training_load.metric_source_identities;
drop trigger if exists metric_measurement_occasions_roster_update on training_load.metric_measurement_occasions;
drop trigger if exists metric_measurement_occasions_roster_insert on training_load.metric_measurement_occasions;
drop trigger if exists activity_athlete_decisions_roster_change on training.activity_athlete_decisions;

drop function if exists training.check_activity_athlete_decision_alias_set();
drop function if exists training.check_activity_completion_log_rules();
drop function if exists training.check_activity_completion_audited();
drop function if exists training.check_activity_completion_rules();
drop function if exists training.roster_on_period_change();
drop function if exists training.roster_sessions_in_interval(uuid, timestamptz, timestamptz);
drop function if exists training.roster_on_observation_update();
drop function if exists training.roster_on_observation_insert();
drop function if exists training.roster_on_activity_update();
drop function if exists training.roster_on_participant_update();
drop function if exists training.roster_on_event_link_update();
drop function if exists training.roster_on_event_link_insert();
drop function if exists training.roster_on_participant_link_update();
drop function if exists training.roster_on_participant_link_insert();
drop function if exists training.roster_on_source_identity_update();
drop function if exists training.roster_on_occasion_update();
drop function if exists training.roster_on_occasion_insert();
drop function if exists training.roster_on_decision_insert();
drop function if exists training.roster_record_change(uuid[], uuid[], varchar, uuid, uuid, boolean, text);
drop function if exists training.activity_roster_needs_state(uuid);
drop function if exists training.lock_roster_completions(uuid[], boolean);
drop function if exists training.lock_roster_team(uuid, boolean);

-- v26 redefined lock_activity_decider (club held for every basis); put the
-- v25 definition back.
create or replace function training.lock_activity_decider(p_user_id uuid, p_team_id uuid, p_basis varchar)
returns varchar as $fn$
declare
  v_club_id uuid;
begin
  if p_basis is null or p_basis not in ('team_coach', 'club_admin', 'platform_admin') then
    raise exception 'lock_activity_decider: unknown basis %', p_basis using errcode = 'invalid_parameter_value';
  end if;
  select club_id into v_club_id from public.teams where id = p_team_id and coalesce(is_active, true) for share;
  if not found then
    raise exception 'user % may not decide on the roster of team %', p_user_id, p_team_id using errcode = 'insufficient_privilege';
  end if;
  if p_basis = 'team_coach' then
    perform 1 from public.user_team_roles r join public.users u on u.id = r.user_id
     where r.user_id = p_user_id and r.team_id = p_team_id and r.role = 'team_coach' and r.is_active = true and u.is_active = true
       for share of r, u;
  elsif p_basis = 'club_admin' then
    perform 1 from public.user_club_roles r join public.users u on u.id = r.user_id
      join public.clubs c on c.id = r.club_id
     where r.user_id = p_user_id and r.club_id = v_club_id and r.role = 'club_admin' and r.is_active = true
       and u.is_active = true and coalesce(c.is_active, true)
       for share of r, u, c;
  else
    perform 1 from public.user_global_roles r join public.users u on u.id = r.user_id
     where r.user_id = p_user_id and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
       for share of r, u;
  end if;
  if not found then
    raise exception 'user % may not decide on the roster of team % as %', p_user_id, p_team_id, p_basis using errcode = 'insufficient_privilege';
  end if;
  return p_basis;
end;
$fn$ language plpgsql;

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202609252000_training_load_v26_activity_roster_decisions.sql';

commit;

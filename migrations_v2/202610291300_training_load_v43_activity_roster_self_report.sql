-- Training Load v43 — a self-report activity has no roster.
-- Owner decision 2026-10-29 (option A), after the behaviour was reproduced
-- through the real routes on a disposable database the same day.
--
-- Why. An athlete's own RPE result for a planned session is materialized as
-- ONE team-owned activity per athlete and logical session
-- (backend/src/trainingActivityMaterialize.js, materializeNaturalKeyActivity:
-- origin 'planned_session', one participant, lifecycle 'confirmed'; the same
-- function gives origin 'external_assignment' to the coach's /materialize of
-- one external assignment). A team training with 20 RPE results is therefore
-- 20 such activities. (An athlete's RPE for an EXTERNAL schedule is different:
-- training.materialize_activity_group_from_external_occurrence(), v4, makes
-- ONE activity per occurrence with a participant for every assignee — one
-- participant only when the occurrence has one assignee.) v25's
-- training.activity_roster() lists every member of the owner team on the
-- session day for ANY team-owned activity, and v26's
-- activity_roster_needs_state() counts only api_import / csv_import values as
-- measured, so on each of those activities the whole team — the athlete who
-- gave the RPE included — read "Unknown / needs a state", and the Roster tab
-- opened by itself on every one of them. There is nothing to decide on such an
-- activity: it is one athlete's own report, not the team's session.
--
-- Rule. A team-owned activity has a roster unless it is a self-report
-- activity: origin 'planned_session' or 'external_assignment', at most one
-- canonical participant across its alias set, AND no measured value (an
-- effective api_import / csv_import metric value in
-- training.canonical_activity_results(), the one definition of "measured" the
-- roster uses, ADR-001). Measured imports ('api_import', 'source_import') and
-- coach-created ('manual') team activities keep their roster unchanged
-- whatever their participant count (a GPEXE session in which one athlete was
-- measured still needs the team's roster completed). Merges in either
-- direction keep that promise: a self-report participant merged into a
-- measured one leaves the self-report activity superseded, addressed through
-- its canonical activity as every roster function already expects; a measured
-- participant merged into a self-report participant leaves the self-report
-- activity canonical with measured values on it, and the third condition then
-- gives it a roster. A self-report activity that came to hold a second
-- canonical participant (a reparent) has a roster again, and its RPE athletes
-- then read "Unknown" as they do today; so does an external occurrence with
-- two or more assignees — one activity for the whole event, which keeps its
-- roster as the team's event, its RPE athletes reading "Unknown" as before.
-- Both are the boundary of this rule, left to the team-session model (one
-- activity per team training, a result counting as participation) that is
-- designed together with the central calendar.
--
-- What changes. One new function, training.activity_has_roster(uuid), and a
-- new definition of training.activity_roster(uuid) that returns no rows for a
-- self-report activity. Every consumer inherits the rule through that one
-- function: the roster read and its commands (backend/src/activityRoster.js,
-- which also answers 409 roster_not_applicable through the same function),
-- activity_roster_needs_state() (v26), the decision insert rule (v25: the
-- athlete must be on the roster), the source-observation insert rule (v25) and
-- the completion rules (v26: a non-empty roster in which nobody needs a
-- state). No table, column, index or trigger changes and no row is written.
-- training.roster_record_change() (v26) is unchanged: on a self-report
-- activity the application inserts no decision (the read refuses first) and
-- the database refuses one (v25: the athlete must be on the roster) as well
-- as a 'complete' completion (v26: a non-empty roster), so the application
-- creates no completion row for one. Rows a coach recorded on such an
-- activity before v43 are kept untouched (see the runbook's post-check).
--
-- Rollback: docs/runbooks/activity-roster-v43-rollback.sql — restores the v25
-- definition of activity_roster(), drops activity_has_roster(), and refuses
-- once a later migration is recorded.

-- ---------------------------------------------------------------------------
-- 1. Whether an activity has a roster at all.
-- ---------------------------------------------------------------------------
-- p_activity_id is the canonical activity, as every roster function expects.
-- NULL for an id that does not exist (callers coalesce to false). The CASE
-- keeps the participant count and the measured-value check to activities of a
-- self-report origin, so an imported or manual team activity costs one row
-- read; a self-report activity holds one athlete's facts, so the
-- canonical_activity_results() call is small.
create function training.activity_has_roster(p_activity_id uuid)
returns boolean as $$
  select a.owner_scope = 'team'
     and not (
       case when a.origin in ('planned_session', 'external_assignment')
            then (select count(*)
                    from training.activity_participants p
                   where p.merge_status = 'canonical'
                     and p.activity_id in (select x.activity_id from training.activity_alias_ids(a.id) x)) <= 1
                 and not exists (select 1
                                   from training.canonical_activity_results(a.id) x
                                  where x.fact_kind = 'metric_value'
                                    and x.detail ->> 'entryMethod' in ('api_import', 'csv_import'))
            else false
       end
     )
    from training.activities a
   where a.id = p_activity_id;
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- 2. The roster, empty for a self-report activity.
-- ---------------------------------------------------------------------------
-- The v25 definition with one more condition on the activity: the body is
-- otherwise identical (members of the owner team whose period covers the
-- session start, or overlaps the local day without a start time; one row per
-- athlete; left_at as before). Empty for an activity that is not team-owned
-- and, from v43, for a self-report activity.
create or replace function training.activity_roster(p_activity_id uuid)
returns table (athlete_id uuid, member_from timestamptz, member_to timestamptz, left_at timestamptz) as $$
  with a as (
    select owner_team_id, started_at,
           (occurred_local_date::timestamp at time zone timezone_snapshot) as day_start,
           ((occurred_local_date + 1)::timestamp at time zone timezone_snapshot) as day_end
      from training.activities
     where id = p_activity_id and owner_scope = 'team'
       and coalesce(training.activity_has_roster(id), false)
  ),
  team_periods as (
    select p.athlete_id, p.valid_from, p.valid_to
      from a join public.athlete_membership_periods p
        on p.team_id = a.owner_team_id and p.membership_type = 'team'
  ),
  covering as (
    select tp.athlete_id, tp.valid_from, tp.valid_to
      from team_periods tp cross join a
     where case when a.started_at is not null
                then tp.valid_from <= a.started_at and a.started_at < coalesce(tp.valid_to, 'infinity')
                else tp.valid_from < a.day_end and coalesce(tp.valid_to, 'infinity') > a.day_start
           end
  )
  select c.athlete_id,
         min(c.valid_from),
         case when bool_or(c.valid_to is null) then null else max(c.valid_to) end,
         (select case when bool_or(tp.valid_to is null) then null else max(tp.valid_to) end
            from team_periods tp where tp.athlete_id = c.athlete_id)
    from covering c
   group by c.athlete_id;
$$ language sql stable;

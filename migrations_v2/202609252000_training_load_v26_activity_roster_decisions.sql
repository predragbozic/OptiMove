-- Training Load v26 — session roster decisions, completion and the automatic
-- "needs review" (Phase 5a2).
--
-- Contract: docs/ai/phase5a-discovery-and-contract.md (sections 3.3, 3.4,
-- 3.6 and 11 "As built in 5a2"). v25 created the tables; this migration adds
-- only functions, triggers and one index. No table, column or row of v25 is
-- changed, so the v25 roster read keeps working unchanged.
--
-- What it adds:
--   1. Two lock keys and their helpers:
--        training.lock_roster_team(team, exclusive)          -- membership changes (shared) vs Complete (exclusive)
--        training.lock_roster_completions(ids[], exclusive)  -- every roster input writer (shared) vs Complete (exclusive)
--      A writer whose change can alter a roster takes the SHARED lock of the
--      canonical activity (and a membership change the shared lock of the
--      team) before it looks at the completion row. Complete takes both
--      EXCLUSIVE before it recomputes the roster: a change that is not yet
--      committed is either waited for (then seen) or waits for Complete
--      (then downgrades it). This closes the window in which a change
--      committed next to a Complete would leave "complete" standing, also
--      for a session whose completion row does not exist yet.
--   2. training.roster_record_change(...) — the one place that turns a
--      roster change into a completion change: complete -> needs_review
--      (cause recorded, revision + 1, one log row); needs_review gains a new
--      cause (revision + 1, one log row) or, for a cause it already carries,
--      nothing (no duplicate log row for the same kind of change);
--      not_complete (or no row) is left alone, except for a coach decision,
--      which always bumps the revision and creates the row on the first one.
--      It never refuses anything: it has no business rule that could block
--      the writer. A technical failure inside it (a broken log insert, a
--      lock error) fails the writer's statement and so the writer's whole
--      transaction — a change never commits next to a "complete" it did not
--      downgrade.
--   3. Statement-level AFTER triggers (transition tables, so one fan-out per
--      statement locks its completion rows in ascending activity id) on every
--      input of section 3.4 of the contract:
--        coach decisions                                   -> decision_changed
--        occasions: insert; effectiveness change           -> measurement_changed
--        metric_source_identities.current_occasion_id      -> measurement_changed
--        participant <-> metric participant links          -> link_changed
--        activity <-> metric event links                   -> link_changed
--        activity_participants.activity_id (reparent)      -> roster_changed (source and target)
--        activity_participants merge_status (merge)        -> activity_merged
--        activities.superseded_by_activity_id              -> activity_merged (the survivor)
--        activities started_at / occurred_local_date / timezone_snapshot -> roster_changed
--        source observations: open / resolve               -> record_unusable | change_pending
--        membership periods opened or closed over a completed session of the team -> roster_changed
--      A guard (optimove.roster_change_active) stops re-entry.
--   4. Audit and integrity that raw SQL cannot bypass:
--      - every completion revision has exactly one log row (unique index on
--        (activity_id, revision), and a deferred check at commit);
--      - a log row describes the completion row as it is when written, its
--        from_status is the previous revision's to_status, and each cause
--        allows only its own transitions;
--      - "completed" and "reopened" carry the request, the user and the
--        basis, and the basis is re-checked (lock_activity_decider);
--      - a completion row is created at revision 1 and becomes complete only
--        over a non-empty roster where nobody needs a state
--        (training.activity_roster_needs_state, the SQL twin of the JS
--        derivation in backend/src/activityRoster.js);
--      - a new decision leaves no other current decision of the athlete in
--        the activity's alias set.
--
-- Lock order of every roster command (backend/src/activityRosterCommands.js):
--   1. lock_activity_decider  (team, role, user[, club] rows FOR SHARE)
--   2. the team import advisory lock (gpexeImportWriter.lockTeamForImport)
--   3. Complete only: lock_roster_team(team, exclusive)
--   4. the alias set's activity rows FOR KEY SHARE, ascending
--      (a merge or reparent takes them FOR UPDATE first, so it cannot run
--      between our canonical check and our writes, and it never waits for a
--      completion lock we hold while we wait for its activity row)
--   5. Complete only: lock_roster_completions(canonical, exclusive)
--   6. completion rows FOR UPDATE, ascending activity id
--   7. request-key lookup, checks, writes (decisions, then the request row).
-- Writers reach 5 (shared) and 6 from their own position: an import after
-- its team lock, a reparent/merge after its activity rows, a link writer
-- after its activity row, a membership change after its membership row and
-- lock_roster_team(shared). None of them takes 1-4 after 5/6, so there is no
-- cycle.

-- ---------------------------------------------------------------------------
-- 1. Lock keys.
-- ---------------------------------------------------------------------------
create function training.lock_roster_team(p_team_id uuid, p_exclusive boolean) returns void as $$
begin
  if p_team_id is null then
    return;
  end if;
  if p_exclusive then
    perform pg_advisory_xact_lock(hashtextextended('activity-roster-team:' || p_team_id::text, 26));
  else
    perform pg_advisory_xact_lock_shared(hashtextextended('activity-roster-team:' || p_team_id::text, 26));
  end if;
end;
$$ language plpgsql;

create function training.lock_roster_completions(p_activity_ids uuid[], p_exclusive boolean) returns void as $$
declare
  v_id uuid;
begin
  for v_id in select distinct x from unnest(p_activity_ids) x where x is not null order by 1 loop
    if p_exclusive then
      perform pg_advisory_xact_lock(hashtextextended('activity-roster-completion:' || v_id::text, 26));
    else
      perform pg_advisory_xact_lock_shared(hashtextextended('activity-roster-completion:' || v_id::text, 26));
    end if;
  end loop;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 2. Who still needs a state (SQL twin of deriveAthleteState's needs_state
--    group, backend/src/activityRoster.js): a roster athlete whose current
--    decisions in the alias set disagree, or who has neither a current
--    decision other than 'cleared' nor an effective measured value.
-- ---------------------------------------------------------------------------
create function training.activity_roster_needs_state(p_canonical_activity_id uuid)
returns table (athlete_id uuid) as $$
  with r as (
    select athlete_id from training.activity_roster(p_canonical_activity_id)
  ),
  d as (
    select d.athlete_id, d.decision_kind, coalesce(d.reason_key, '') as reason_key
      from training.activity_athlete_decisions d
     where d.activity_id in (select activity_id from training.activity_alias_ids(p_canonical_activity_id))
       and d.superseded_by_decision_id is null
  ),
  m as (
    select distinct x.athlete_id
      from training.canonical_activity_results(p_canonical_activity_id) x
     where x.fact_kind = 'metric_value' and x.detail ->> 'entryMethod' in ('api_import', 'csv_import')
  )
  select r.athlete_id
    from r
   where ((select count(*) from d where d.athlete_id = r.athlete_id) > 1
          and (select count(distinct (d.decision_kind, d.reason_key)) from d where d.athlete_id = r.athlete_id) > 1)
      or (not exists (select 1 from d where d.athlete_id = r.athlete_id and d.decision_kind <> 'cleared')
          and not exists (select 1 from m where m.athlete_id = r.athlete_id));
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- 3. The one place a roster change becomes a completion change.
-- ---------------------------------------------------------------------------
-- p_activity_ids / p_athlete_ids are aligned (athlete may be null). Any id is
-- resolved to its canonical activity; only team-owned activities count.
-- p_decision: a coach decision (always bumps, creates the row).
create function training.roster_record_change(
  p_activity_ids uuid[], p_athlete_ids uuid[], p_cause varchar, p_performed_by uuid, p_request_id uuid,
  p_decision boolean, p_source text
) returns void as $$
declare
  v_ids uuid[];
  v_id uuid;
  v_team uuid;
  c record;
  v_status varchar;
  v_causes text[];
  v_detail jsonb;
begin
  if current_setting('optimove.roster_change_active', true) = 'on' then
    return;
  end if;
  select coalesce(array_agg(distinct a.id order by a.id), '{}')
    into v_ids
    from unnest(p_activity_ids) x
    join training.activities a on a.id = training.resolve_canonical_activity_id(x)
   where x is not null and a.owner_scope = 'team';
  if cardinality(v_ids) = 0 then
    return;
  end if;

  perform set_config('optimove.roster_change_active', 'on', true);
  perform training.lock_roster_completions(v_ids, false);
  foreach v_id in array v_ids loop
    select coalesce(jsonb_agg(distinct t.athlete_id order by t.athlete_id) filter (where t.athlete_id is not null), '[]'::jsonb)
      into v_detail
      from unnest(p_activity_ids, p_athlete_ids) as t(activity_id, athlete_id)
     where t.activity_id is not null and training.resolve_canonical_activity_id(t.activity_id) = v_id;
    v_detail := jsonb_build_object('athleteIds', v_detail, 'source', p_source);

    select * into c from training.activity_completions where activity_id = v_id for update;
    if not found then
      if p_decision then
        select owner_team_id into v_team from training.activities where id = v_id;
        insert into training.activity_completions (activity_id, owner_team_id, status, revision)
        values (v_id, v_team, 'not_complete', 1);
        insert into training.activity_completion_log (activity_id, request_id, revision, from_status, to_status, cause, performed_by_user_id, detail)
        values (v_id, p_request_id, 1, 'not_complete', 'not_complete', p_cause, p_performed_by, v_detail);
      end if;
      continue;
    end if;

    if c.status = 'complete' then
      v_status := 'needs_review';
      v_causes := array[p_cause]::text[];
    elsif c.status = 'needs_review' then
      v_status := 'needs_review';
      if p_cause = any(c.needs_review_causes) then
        if not p_decision then
          continue;
        end if;
        v_causes := c.needs_review_causes;
      else
        v_causes := c.needs_review_causes || p_cause::text;
      end if;
    else
      if not p_decision then
        continue;
      end if;
      v_status := 'not_complete';
      v_causes := '{}';
    end if;

    update training.activity_completions
       set status = v_status, revision = c.revision + 1, needs_review_causes = v_causes,
           completed_by_user_id = null, completed_by_basis = null, completed_at = null, input_fingerprint = null
     where activity_id = v_id;
    insert into training.activity_completion_log (activity_id, request_id, revision, from_status, to_status, cause, performed_by_user_id, detail)
    values (v_id, p_request_id, c.revision + 1, c.status, v_status, p_cause, p_performed_by,
            v_detail || case when c.status = 'complete'
                             then jsonb_build_object('completedByUserId', c.completed_by_user_id, 'completedAt', c.completed_at)
                             else '{}'::jsonb end);
  end loop;
  perform set_config('optimove.roster_change_active', '', true);
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 4. The inputs (statement-level; one fan-out per statement).
-- ---------------------------------------------------------------------------

-- 4a. Coach decisions: every decision row bumps the revision of its
-- activity once per request (a bulk request is one INSERT statement).
create function training.roster_on_decision_insert() returns trigger as $$
declare
  g record;
begin
  for g in
    select activity_id, request_id, decided_by_user_id, array_agg(athlete_id order by athlete_id) as athletes
      from new_rows
     group by activity_id, request_id, decided_by_user_id
     order by activity_id, request_id
  loop
    perform training.roster_record_change(
      array_fill(g.activity_id, array[cardinality(g.athletes)]), g.athletes, 'decision_changed',
      g.decided_by_user_id, g.request_id, true, 'decision');
  end loop;
  return null;
end;
$$ language plpgsql;

create trigger activity_athlete_decisions_roster_change
  after insert on training.activity_athlete_decisions
  referencing new table as new_rows
  for each statement execute function training.roster_on_decision_insert();

-- Occasion -> the activities whose confirmed participant links point at its
-- metric participant (a link written later is caught by 4d).
create function training.roster_on_occasion_insert() returns trigger as $$
declare
  v_acts uuid[];
  v_aths uuid[];
begin
  select array_agg(ap.activity_id), array_agg(ap.athlete_id) into v_acts, v_aths
    from (select distinct event_participant_id from new_rows) o
    join training.activity_participant_metric_participant_links l
      on l.metric_event_participant_id = o.event_participant_id and l.link_status = 'confirmed'
    join training.activity_participants ap on ap.id = l.activity_participant_id;
  if v_acts is not null then
    perform training.roster_record_change(v_acts, v_aths, 'measurement_changed', null, null, false, 'occasion_insert');
  end if;
  return null;
end;
$$ language plpgsql;

create trigger metric_measurement_occasions_roster_insert
  after insert on training_load.metric_measurement_occasions
  referencing new table as new_rows
  for each statement execute function training.roster_on_occasion_insert();

create function training.roster_on_occasion_update() returns trigger as $$
declare
  v_acts uuid[];
  v_aths uuid[];
begin
  select array_agg(ap.activity_id), array_agg(ap.athlete_id) into v_acts, v_aths
    from (select distinct n.event_participant_id
            from new_rows n join old_rows o on o.id = n.id
           where n.import_conflict_status is distinct from o.import_conflict_status
              or n.superseded_by_occasion_id is distinct from o.superseded_by_occasion_id
              or n.event_participant_id is distinct from o.event_participant_id) ch
    join training.activity_participant_metric_participant_links l
      on l.metric_event_participant_id = ch.event_participant_id and l.link_status = 'confirmed'
    join training.activity_participants ap on ap.id = l.activity_participant_id;
  if v_acts is not null then
    perform training.roster_record_change(v_acts, v_aths, 'measurement_changed', null, null, false, 'occasion_update');
  end if;
  return null;
end;
$$ language plpgsql;

create trigger metric_measurement_occasions_roster_update
  after update on training_load.metric_measurement_occasions
  referencing old table as old_rows new table as new_rows
  for each statement execute function training.roster_on_occasion_update();

-- 4b. The current occasion of a source identity (old and new).
create function training.roster_on_source_identity_update() returns trigger as $$
declare
  v_acts uuid[];
  v_aths uuid[];
begin
  select array_agg(ap.activity_id), array_agg(ap.athlete_id) into v_acts, v_aths
    from (select o.current_occasion_id as occasion_id
            from old_rows o join new_rows n on n.id = o.id
           where n.current_occasion_id is distinct from o.current_occasion_id
          union
          select n.current_occasion_id
            from old_rows o join new_rows n on n.id = o.id
           where n.current_occasion_id is distinct from o.current_occasion_id) ch
    join training_load.metric_measurement_occasions occ on occ.id = ch.occasion_id
    join training.activity_participant_metric_participant_links l
      on l.metric_event_participant_id = occ.event_participant_id and l.link_status = 'confirmed'
    join training.activity_participants ap on ap.id = l.activity_participant_id;
  if v_acts is not null then
    perform training.roster_record_change(v_acts, v_aths, 'measurement_changed', null, null, false, 'current_occasion');
  end if;
  return null;
end;
$$ language plpgsql;

create trigger metric_source_identities_roster_update
  after update on training_load.metric_source_identities
  referencing old table as old_rows new table as new_rows
  for each statement execute function training.roster_on_source_identity_update();

-- 4c/4d. Links: a participant's metric link (insert confirmed, or a status
-- change to or from confirmed) and an activity's metric event link.
create function training.roster_on_participant_link_insert() returns trigger as $$
declare
  v_acts uuid[];
  v_aths uuid[];
begin
  select array_agg(ap.activity_id), array_agg(ap.athlete_id) into v_acts, v_aths
    from new_rows n join training.activity_participants ap on ap.id = n.activity_participant_id
   where n.link_status = 'confirmed';
  if v_acts is not null then
    perform training.roster_record_change(v_acts, v_aths, 'link_changed', null, null, false, 'participant_link');
  end if;
  return null;
end;
$$ language plpgsql;

create trigger activity_participant_metric_links_roster_insert
  after insert on training.activity_participant_metric_participant_links
  referencing new table as new_rows
  for each statement execute function training.roster_on_participant_link_insert();

create function training.roster_on_participant_link_update() returns trigger as $$
declare
  v_acts uuid[];
  v_aths uuid[];
begin
  select array_agg(ap.activity_id), array_agg(ap.athlete_id) into v_acts, v_aths
    from new_rows n join old_rows o on o.id = n.id
    join training.activity_participants ap on ap.id = n.activity_participant_id
   where n.link_status is distinct from o.link_status and 'confirmed' in (n.link_status, o.link_status);
  if v_acts is not null then
    perform training.roster_record_change(v_acts, v_aths, 'link_changed', null, null, false, 'participant_link');
  end if;
  return null;
end;
$$ language plpgsql;

create trigger activity_participant_metric_links_roster_update
  after update on training.activity_participant_metric_participant_links
  referencing old table as old_rows new table as new_rows
  for each statement execute function training.roster_on_participant_link_update();

create function training.roster_on_event_link_insert() returns trigger as $$
declare
  v_acts uuid[];
begin
  select array_agg(n.activity_id) into v_acts from new_rows n where n.link_status = 'confirmed';
  if v_acts is not null then
    perform training.roster_record_change(v_acts, array_fill(null::uuid, array[cardinality(v_acts)]), 'link_changed', null, null, false, 'event_link');
  end if;
  return null;
end;
$$ language plpgsql;

create trigger activity_metric_event_links_roster_insert
  after insert on training.activity_metric_event_links
  referencing new table as new_rows
  for each statement execute function training.roster_on_event_link_insert();

create function training.roster_on_event_link_update() returns trigger as $$
declare
  v_acts uuid[];
begin
  select array_agg(n.activity_id) into v_acts
    from new_rows n join old_rows o on o.id = n.id
   where n.link_status is distinct from o.link_status and 'confirmed' in (n.link_status, o.link_status);
  if v_acts is not null then
    perform training.roster_record_change(v_acts, array_fill(null::uuid, array[cardinality(v_acts)]), 'link_changed', null, null, false, 'event_link');
  end if;
  return null;
end;
$$ language plpgsql;

create trigger activity_metric_event_links_roster_update
  after update on training.activity_metric_event_links
  referencing old table as old_rows new table as new_rows
  for each statement execute function training.roster_on_event_link_update();

-- 4e. Participants: a reparent moves a participant (source and target
-- activity); a participant merge makes one an alias of another (both
-- participants' activities).
create function training.roster_on_participant_update() returns trigger as $$
declare
  v_acts uuid[];
  v_aths uuid[];
begin
  select array_agg(x.activity_id), array_agg(x.athlete_id) into v_acts, v_aths
    from (select o.activity_id, o.athlete_id from old_rows o join new_rows n on n.id = o.id where n.activity_id is distinct from o.activity_id
          union all
          select n.activity_id, n.athlete_id from old_rows o join new_rows n on n.id = o.id where n.activity_id is distinct from o.activity_id) x;
  if v_acts is not null then
    perform training.roster_record_change(v_acts, v_aths, 'roster_changed', null, null, false, 'participant_reparent');
  end if;

  v_acts := null;
  v_aths := null;
  select array_agg(x.activity_id), array_agg(x.athlete_id) into v_acts, v_aths
    from (select n.activity_id, n.athlete_id
            from old_rows o join new_rows n on n.id = o.id
           where n.merge_status is distinct from o.merge_status
              or n.superseded_by_participant_id is distinct from o.superseded_by_participant_id
          union all
          select t.activity_id, t.athlete_id
            from old_rows o join new_rows n on n.id = o.id
            join training.activity_participants t on t.id = n.superseded_by_participant_id
           where n.superseded_by_participant_id is distinct from o.superseded_by_participant_id) x;
  if v_acts is not null then
    perform training.roster_record_change(v_acts, v_aths, 'activity_merged', null, null, false, 'participant_merge');
  end if;
  return null;
end;
$$ language plpgsql;

create trigger activity_participants_roster_update
  after update on training.activity_participants
  referencing old table as old_rows new table as new_rows
  for each statement execute function training.roster_on_participant_update();

-- 4f. An activity superseded by another: the survivor (the superseded
-- activity's own completion row stays as history). A change of the
-- session's time or date (started_at, occurred_local_date,
-- timezone_snapshot) changes which memberships cover it: roster_changed.
create function training.roster_on_activity_update() returns trigger as $$
declare
  v_acts uuid[];
begin
  select array_agg(n.superseded_by_activity_id) into v_acts
    from old_rows o join new_rows n on n.id = o.id
   where n.superseded_by_activity_id is distinct from o.superseded_by_activity_id and n.superseded_by_activity_id is not null;
  if v_acts is not null then
    perform training.roster_record_change(v_acts, array_fill(null::uuid, array[cardinality(v_acts)]), 'activity_merged', null, null, false, 'activity_supersede');
  end if;
  v_acts := null;
  select array_agg(n.id) into v_acts
    from old_rows o join new_rows n on n.id = o.id
   where n.started_at is distinct from o.started_at
      or n.occurred_local_date is distinct from o.occurred_local_date
      or n.timezone_snapshot is distinct from o.timezone_snapshot;
  if v_acts is not null then
    perform training.roster_record_change(v_acts, array_fill(null::uuid, array[cardinality(v_acts)]), 'roster_changed', null, null, false, 'activity_time');
  end if;
  return null;
end;
$$ language plpgsql;

create trigger activities_roster_update
  after update on training.activities
  referencing old table as old_rows new table as new_rows
  for each statement execute function training.roster_on_activity_update();

-- 4g. Source observations: opened or resolved.
create function training.roster_on_observation_insert() returns trigger as $$
declare
  g record;
begin
  for g in select kind, array_agg(activity_id) as acts, array_agg(athlete_id) as aths from new_rows group by kind order by kind loop
    perform training.roster_record_change(g.acts, g.aths, g.kind, null, null, false, 'observation_open');
  end loop;
  return null;
end;
$$ language plpgsql;

create trigger activity_source_observations_roster_insert
  after insert on training.activity_source_observations
  referencing new table as new_rows
  for each statement execute function training.roster_on_observation_insert();

create function training.roster_on_observation_update() returns trigger as $$
declare
  g record;
begin
  for g in
    select n.kind, array_agg(n.activity_id) as acts, array_agg(n.athlete_id) as aths
      from new_rows n join old_rows o on o.id = n.id
     where n.resolved_at is distinct from o.resolved_at
     group by n.kind order by n.kind
  loop
    perform training.roster_record_change(g.acts, g.aths, g.kind, null, null, false, 'observation_resolve');
  end loop;
  return null;
end;
$$ language plpgsql;

create trigger activity_source_observations_roster_update
  after update on training.activity_source_observations
  referencing old table as old_rows new table as new_rows
  for each statement execute function training.roster_on_observation_update();

-- 4h. Membership periods. A period opened [from, to) or closed at t (the
-- interval [t, previous end) leaves the roster) changes the roster of every
-- session of the team inside that interval. Only sessions that carry a
-- complete or needs_review completion are touched; a Complete that has not
-- committed yet is covered by the team lock (exclusive for Complete, shared
-- here, taken before the sessions are looked up).
create function training.roster_sessions_in_interval(p_team_id uuid, p_from timestamptz, p_to timestamptz)
returns table (activity_id uuid) as $$
  select a.id
    from training.activity_completions c
    join training.activities a on a.id = c.activity_id
   where c.owner_team_id = p_team_id and c.status in ('complete', 'needs_review')
     and a.owner_scope = 'team' and a.superseded_by_activity_id is null
     and case when a.started_at is not null
              then p_from <= a.started_at and a.started_at < coalesce(p_to, 'infinity')
              else p_from < ((a.occurred_local_date + 1)::timestamp at time zone a.timezone_snapshot)
                   and coalesce(p_to, 'infinity') > (a.occurred_local_date::timestamp at time zone a.timezone_snapshot)
         end;
$$ language sql stable;

create function training.roster_on_period_change() returns trigger as $$
declare
  v_team uuid;
  v_acts uuid[];
  v_aths uuid[];
begin
  if tg_op = 'INSERT' then
    for v_team in select distinct team_id from new_rows where membership_type = 'team' order by 1 loop
      perform training.lock_roster_team(v_team, false);
    end loop;
    select array_agg(s.activity_id), array_agg(n.athlete_id) into v_acts, v_aths
      from new_rows n
      cross join lateral training.roster_sessions_in_interval(n.team_id, n.valid_from, n.valid_to) s
     where n.membership_type = 'team';
  else
    for v_team in
      select distinct n.team_id from new_rows n join old_rows o on o.id = n.id
       where n.membership_type = 'team' and n.valid_to is distinct from o.valid_to order by 1
    loop
      perform training.lock_roster_team(v_team, false);
    end loop;
    select array_agg(s.activity_id), array_agg(n.athlete_id) into v_acts, v_aths
      from new_rows n join old_rows o on o.id = n.id
      cross join lateral training.roster_sessions_in_interval(n.team_id, n.valid_to, o.valid_to) s
     where n.membership_type = 'team' and n.valid_to is distinct from o.valid_to and n.valid_to is not null;
  end if;
  if v_acts is not null then
    perform training.roster_record_change(v_acts, v_aths, 'roster_changed', null, null, false, 'membership_period');
  end if;
  return null;
end;
$$ language plpgsql;

create trigger athlete_membership_periods_roster_insert
  after insert on public.athlete_membership_periods
  referencing new table as new_rows
  for each statement execute function training.roster_on_period_change();

create trigger athlete_membership_periods_roster_update
  after update on public.athlete_membership_periods
  referencing old table as old_rows new table as new_rows
  for each statement execute function training.roster_on_period_change();

-- ---------------------------------------------------------------------------
-- 5. Audit and integrity rules raw SQL cannot bypass.
-- ---------------------------------------------------------------------------

-- 5a. One log row per completion revision.
create unique index activity_completion_log_revision_idx
  on training.activity_completion_log (activity_id, revision);

-- 5b. A completion row starts at revision 1; it becomes complete only over a
-- non-empty roster in which nobody needs a state.
create function training.check_activity_completion_rules() returns trigger as $$
begin
  if tg_op = 'INSERT' and new.revision <> 1 then
    raise exception 'activity_completions: a completion row is created at revision 1 (activity %)', new.activity_id;
  end if;
  if new.status = 'complete' and (tg_op = 'INSERT' or old.status is distinct from 'complete') then
    if not exists (select 1 from training.activity_roster(new.activity_id)) then
      raise exception 'activity_completions: activity % has nobody on its roster; it cannot be complete', new.activity_id;
    end if;
    if exists (select 1 from training.activity_roster_needs_state(new.activity_id)) then
      raise exception 'activity_completions: somebody on the roster of activity % still needs a state', new.activity_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger activity_completions_rules
  before insert or update on training.activity_completions
  for each row execute function training.check_activity_completion_rules();

-- 5c. At commit: every completion revision written in the transaction has
-- its log row.
create function training.check_activity_completion_audited() returns trigger as $$
begin
  if not exists (
    select 1 from training.activity_completion_log l
     where l.activity_id = new.activity_id and l.revision = new.revision and l.to_status = new.status
  ) then
    raise exception 'activity_completions: revision % of activity % has no completion log row', new.revision, new.activity_id;
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger activity_completions_audited
  after insert or update on training.activity_completions
  deferrable initially deferred
  for each row execute function training.check_activity_completion_audited();

-- 5d. A log row describes the completion row as it is, continues the
-- previous revision, and each cause allows only its own transition.
create function training.check_activity_completion_log_rules() returns trigger as $$
declare
  comp record;
  prev_status varchar;
  v_basis text := new.detail ->> 'basis';
begin
  select * into comp from training.activity_completions where activity_id = new.activity_id;
  if not found or comp.revision <> new.revision or comp.status <> new.to_status then
    raise exception 'activity_completion_log: the log row does not describe completion revision % of activity %', new.revision, new.activity_id;
  end if;
  select to_status into prev_status from training.activity_completion_log where activity_id = new.activity_id and revision = new.revision - 1;
  if new.from_status is distinct from coalesce(prev_status, 'not_complete') then
    raise exception 'activity_completion_log: revision % of activity % does not continue from %', new.revision, new.activity_id, coalesce(prev_status, 'not_complete');
  end if;

  if new.cause = 'completed' then
    if new.to_status <> 'complete' or new.from_status not in ('not_complete', 'needs_review') then
      raise exception 'activity_completion_log: completed is % -> complete only', new.from_status;
    end if;
  elsif new.cause = 'reopened' then
    if new.to_status <> 'not_complete' or new.from_status not in ('complete', 'needs_review') then
      raise exception 'activity_completion_log: reopened is complete | needs_review -> not_complete only';
    end if;
    if length(btrim(coalesce(new.detail ->> 'reason', ''))) = 0 then
      raise exception 'activity_completion_log: a reopen carries its reason';
    end if;
  elsif new.cause = 'decision_changed' then
    if (new.from_status, new.to_status) not in (('not_complete', 'not_complete'), ('complete', 'needs_review'), ('needs_review', 'needs_review')) then
      raise exception 'activity_completion_log: decision_changed is not % -> %', new.from_status, new.to_status;
    end if;
  elsif new.to_status <> 'needs_review' or new.from_status not in ('complete', 'needs_review') then
    raise exception 'activity_completion_log: % only turns complete or needs_review into needs_review', new.cause;
  end if;

  if new.cause in ('completed', 'reopened', 'decision_changed') then
    if new.request_id is null or new.performed_by_user_id is null then
      raise exception 'activity_completion_log: % carries its request and user', new.cause;
    end if;
  end if;
  if new.cause in ('completed', 'reopened') then
    if v_basis is null then
      raise exception 'activity_completion_log: % carries the basis it was done on', new.cause;
    end if;
    perform training.lock_activity_decider(new.performed_by_user_id, comp.owner_team_id, v_basis);
    if new.cause = 'completed' and (comp.completed_by_user_id is distinct from new.performed_by_user_id or comp.completed_by_basis is distinct from v_basis) then
      raise exception 'activity_completion_log: completed by % as % does not match the completion row', new.performed_by_user_id, v_basis;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger activity_completion_log_rules
  before insert on training.activity_completion_log
  for each row execute function training.check_activity_completion_log_rules();

-- 5e. A new decision is the only current decision of its athlete in the
-- whole alias set (the write path supersedes every current one first; a
-- merge that brings two together is shown as a conflict until the coach
-- decides once).
create function training.check_activity_athlete_decision_alias_set() returns trigger as $$
begin
  if exists (
    select 1 from training.activity_athlete_decisions d
     where d.activity_id in (select activity_id from training.activity_alias_ids(training.resolve_canonical_activity_id(new.activity_id)))
       and d.athlete_id = new.athlete_id and d.superseded_by_decision_id is null and d.id <> new.id
  ) then
    raise exception 'activity_athlete_decisions: athlete % already has a current decision in the alias set of activity %; supersede it first', new.athlete_id, new.activity_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger activity_athlete_decisions_one_current_in_alias_set
  before insert on training.activity_athlete_decisions
  for each row execute function training.check_activity_athlete_decision_alias_set();

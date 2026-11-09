-- Training Load v60 - the undo of an imported session is always possible, whatever roster work exists (O1; J20 section 5.3,
-- extended variant b; the owner's decision of 2026-11-09: "undo and re-import must ALWAYS be possible, because in practice
-- coaches change statuses later").
--
-- v57 refused an undo (`roster_decisions_exist`) as soon as the session had a roster decision, request, completion or
-- completion log row, and nothing could remove them: the four v25 tables are append-only. This migration:
--   * adds activity_roster_requests.origin ('roster' | 'import', default 'roster'), set to 'import' only by the import flow
--     (J20-C): the database accepts 'import' only for a request by the SAME user who approved an import of this session, made
--     after that approval (so a coach's own decision can never be labelled import-written and hide from the warning);
--   * gives the four roster tables ONE delete exception each, true only inside the undo's own transaction (the v57 marker);
--     UPDATE, TRUNCATE and every other DELETE stay refused;
--   * splits the roster work of a session into what the import flow wrote and a coach's later work
--     (training_load.session_undo_roster_work), and replaces undo_imported_session with a 7-argument version: import-written
--     work goes with the session; later work goes only when the call carries the fingerprint of the list the administrator
--     saw, compared under the team lock with the list as it is at that moment (a changed list removes nothing);
--   * records what was removed in the deletion log (import_deletion_log.roster_work_removed: counts and a bounded list with no
--     free text), checked by the log's insert guard, and the administrator who confirmed is the one who ran the undo.
-- The old 6-argument function no longer exists afterwards. No row of any table changes. Who may undo is unchanged (an active
-- platform admin). Lock order unchanged (users, platform role, the team's import lock, request, candidates, event, activities);
-- the roster commands take the same users-first order and the same team lock, so an undo and a Change serialise.
-- Rollback: docs/runbooks/session-undo-roster-work-v60-rollback.sql. Runbook: docs/runbooks/session-undo-roster-work-v60.md.

-- ---------------------------------------------------------------------------
-- 0. The bodies this migration replaces must be the ones in force
-- ---------------------------------------------------------------------------
do $$
declare
  expected constant text[][] := array[
    ['training_load', 'undo_imported_session', 'ae5aa129708a03a602b9cdc596e1e11a', 'v57'],
    ['training_load', 'session_undo_scope', 'f605cb502a36a4d8e372373fe1e2207a', 'v57'],
    ['training', 'protect_activity_roster_request', 'd653da02d80b0e844105c606017917c4', 'v25'],
    ['training', 'check_activity_athlete_decision', 'd911a55ffeb641ab296488f7faa2569f', 'v25'],
    ['training', 'protect_activity_completion', '4ad9534602ec7cae22d2e4560b9bdeed', 'v25'],
    ['training', 'protect_activity_completion_log', '2cd36fa02adf8af1c41436225459d0ad', 'v25'],
    ['training_load', 'validate_import_deletion_log', 'ccd1157ee00901c66d3bf4c031763bf7', 'v21']];
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2]) <> 1
       or (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = expected[i][1] and p.proname = expected[i][2]) is distinct from expected[i][3] then
      raise exception 'v60 refused: the body in force of %.% is not %''s', expected[i][1], expected[i][2], expected[i][4] using errcode = '23514';
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------------
-- A constant default adds the column without rewriting the table. The append-only trigger keeps refusing UPDATE, so a
-- request can never be relabelled afterwards.
alter table training.activity_roster_requests
  add column origin text not null default 'roster' check (origin in ('roster', 'import'));

alter table training_load.import_deletion_log
  add column roster_work_removed jsonb check (roster_work_removed is null or jsonb_typeof(roster_work_removed) = 'object');

-- ---------------------------------------------------------------------------
-- 2. The deletion log's shape guard (no free text, bounded) and the insert guard that calls it
-- ---------------------------------------------------------------------------
create function training_load.import_deletion_log_roster_work_ok(p jsonb, p_actor uuid) returns void as $$
declare
  e jsonb;
  k text;
  blk text;
begin
  if jsonb_typeof(p) is distinct from 'object'
     or (select array_agg(x order by x) from jsonb_object_keys(p) x)
        is distinct from array['confirmedByUserId', 'importWritten', 'later', 'laterConfirmed', 'laterDecisions', 'laterDecisionsTotal'] then
    raise exception 'import_deletion_log: roster_work_removed has a closed shape' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p -> 'confirmedByUserId') is distinct from 'string' or (p ->> 'confirmedByUserId') is distinct from p_actor::text then
    raise exception 'import_deletion_log: the roster work was confirmed by the administrator who ran the undo' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p -> 'laterConfirmed') is distinct from 'boolean' then
    raise exception 'import_deletion_log: laterConfirmed is a boolean' using errcode = 'check_violation';
  end if;
  foreach blk in array array['importWritten', 'later'] loop
    if jsonb_typeof(p -> blk) is distinct from 'object'
       or (select array_agg(x order by x) from jsonb_object_keys(p -> blk) x) is distinct from array['completionLog', 'completions', 'decisions', 'requests'] then
      raise exception 'import_deletion_log: roster_work_removed.% has a closed shape', blk using errcode = 'check_violation';
    end if;
    foreach k in array array['completionLog', 'completions', 'decisions', 'requests'] loop
      if jsonb_typeof(p -> blk -> k) is distinct from 'number' or (p -> blk ->> k) !~ '^[0-9]{1,9}$' then
        raise exception 'import_deletion_log: roster_work_removed.%.% is a count', blk, k using errcode = 'check_violation';
      end if;
    end loop;
  end loop;
  if jsonb_typeof(p -> 'laterDecisionsTotal') is distinct from 'number' or (p ->> 'laterDecisionsTotal') !~ '^[0-9]{1,9}$'
     or jsonb_typeof(p -> 'laterDecisions') is distinct from 'array'
     or jsonb_array_length(p -> 'laterDecisions') > 500
     or jsonb_array_length(p -> 'laterDecisions') is distinct from least((p ->> 'laterDecisionsTotal')::int, 500)
     or (p ->> 'laterDecisionsTotal')::int <> (p -> 'later' ->> 'decisions')::int then
    raise exception 'import_deletion_log: roster_work_removed.laterDecisions is a bounded list' using errcode = 'check_violation';
  end if;
  for e in select x from jsonb_array_elements(p -> 'laterDecisions') x loop
    if jsonb_typeof(e) is distinct from 'object'
       or (select array_agg(x order by x) from jsonb_object_keys(e) x) is distinct from array['athleteId', 'decidedAt', 'decidedByUserId', 'kind', 'reasonCode']
       or (e ->> 'athleteId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (e ->> 'decidedByUserId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(e -> 'decidedAt') is distinct from 'string'
       or (e ->> 'kind') not in ('did_not_participate', 'participated_no_values', 'manual_values', 'estimated', 'cleared')
       or (jsonb_typeof(e -> 'reasonCode') not in ('string', 'null'))
       or (jsonb_typeof(e -> 'reasonCode') = 'string' and (e ->> 'reasonCode') !~ '^[a-z][a-z0-9_]{0,59}$') then
      raise exception 'import_deletion_log: a listed decision has a closed shape (no free text)' using errcode = 'check_violation';
    end if;
  end loop;
end;
$$ language plpgsql immutable;

create or replace function training_load.validate_import_deletion_log() returns trigger as $$
begin
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = new.deleted_by_user_id
     and r.role = 'platform_admin'
     and r.is_active = true
     and u.is_active = true
   for share of r;
  if not found then
    raise exception 'import_deletion_log: user % is not an active platform admin — only a platform admin may undo an imported session', new.deleted_by_user_id
      using errcode = 'insufficient_privilege';
  end if;
  -- v60: what the undo removed of the roster, in a bounded closed shape; the administrator named is the one who ran it.
  if new.roster_work_removed is not null then
    perform training_load.import_deletion_log_roster_work_ok(new.roster_work_removed, new.deleted_by_user_id);
  end if;
  if exists (select 1 from training_load.metric_events where id = new.event_id) then
    raise exception 'import_deletion_log: event % still exists — a log row records a removal made in the same transaction, not a plan', new.event_id;
  end if;
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 3. The four roster tables: one DELETE exception each, under the undo's marker (v57 pattern)
-- ---------------------------------------------------------------------------
create or replace function training.protect_activity_roster_request() returns trigger as $$
begin
  if tg_op = 'DELETE' and training_load.session_undo_marker_ok() then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'activity_roster_requests is append-only (% refused)', tg_op;
  end if;
  perform training.assert_canonical_team_activity(new.activity_id, null, 'activity_roster_requests');
  -- v60: only the import flow's own request may say so: the same user approved an import of this session (an event linked to
  -- the activity or its alias set) and the request is not older than that approval.
  if new.origin = 'import' and not exists (
    select 1
      from training_load.gpexe_import_approvals a
      join training.activity_metric_event_links l on l.metric_event_id = a.metric_event_id
     where a.approved_by_user_id = new.performed_by_user_id
       and a.approved_at <= new.created_at
       and exists (select 1 from training.activity_alias_ids(training.resolve_canonical_activity_id(new.activity_id)) aa
                    where aa.activity_id = l.activity_id)
  ) then
    raise exception 'activity_roster_requests: an import-origin request needs the same user''s approval of an import of this session, made before it'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function training.check_activity_athlete_decision() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    if training_load.session_undo_marker_ok() then
      return old;
    end if;
    raise exception 'activity_athlete_decisions is append-only; a decision is superseded, never deleted (decision %)', old.id;
  end if;
  if tg_op = 'UPDATE' then
    if old.superseded_by_decision_id is not null or new.superseded_by_decision_id is null
       or new.id is distinct from old.id or new.activity_id is distinct from old.activity_id
       or new.athlete_id is distinct from old.athlete_id or new.owner_team_id is distinct from old.owner_team_id
       or new.request_id is distinct from old.request_id or new.decision_kind is distinct from old.decision_kind
       or new.reason_key is distinct from old.reason_key or new.note is distinct from old.note
       or new.occasion_id is distinct from old.occasion_id or new.decided_by_user_id is distinct from old.decided_by_user_id
       or new.decided_by_basis is distinct from old.decided_by_basis or new.decided_at is distinct from old.decided_at then
      raise exception 'activity_athlete_decisions: a decision only gets superseded, once (decision %)', old.id;
    end if;
    return new;
  end if;

  -- INSERT
  if new.superseded_by_decision_id is not null then
    raise exception 'activity_athlete_decisions: a new decision is current';
  end if;
  perform training.assert_canonical_team_activity(new.activity_id, new.owner_team_id, 'activity_athlete_decisions');
  if not exists (select 1 from training.activity_roster(new.activity_id) r where r.athlete_id = new.athlete_id) then
    raise exception 'activity_athlete_decisions: athlete % is not on the roster of activity %', new.athlete_id, new.activity_id;
  end if;
  if new.decision_kind in ('manual_values', 'estimated') then
    raise exception 'activity_athlete_decisions: % is not available yet (Phase 5b)', new.decision_kind;
  end if;
  if new.reason_key is not null and not exists (
    select 1 from training.participation_reasons where key = new.reason_key and is_active
  ) then
    raise exception 'activity_athlete_decisions: reason % is not active', new.reason_key;
  end if;
  -- A measured record is never overridden by a coach decision; only
  -- 'cleared' (back to the derived state) is allowed next to one.
  if new.decision_kind <> 'cleared' and exists (
    select 1 from training.canonical_activity_results(new.activity_id) r
     where r.fact_kind = 'metric_value' and r.athlete_id = new.athlete_id
       and r.detail ->> 'entryMethod' in ('api_import', 'csv_import')
  ) then
    raise exception 'activity_athlete_decisions: athlete % has a measured record in activity %', new.athlete_id, new.activity_id
      using errcode = 'check_violation';
  end if;
  perform training.lock_activity_decider(new.decided_by_user_id, new.owner_team_id, new.decided_by_basis);
  return new;
end;
$$ language plpgsql;

create or replace function training.protect_activity_completion() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    if training_load.session_undo_marker_ok() then
      return old;
    end if;
    raise exception 'activity_completions: completion of activity % is never deleted', old.activity_id;
  end if;
  if tg_op = 'INSERT' then
    perform training.assert_canonical_team_activity(new.activity_id, new.owner_team_id, 'activity_completions');
  else
    if new.activity_id is distinct from old.activity_id or new.owner_team_id is distinct from old.owner_team_id then
      raise exception 'activity_completions: the activity and team of a completion never change (activity %)', old.activity_id;
    end if;
    if new.revision is distinct from old.revision + 1 then
      raise exception 'activity_completions: every change bumps the revision by one (activity %, % -> %)', old.activity_id, old.revision, new.revision;
    end if;
    new.updated_at := now();
  end if;
  if new.status = 'complete' and (tg_op = 'INSERT' or old.status is distinct from 'complete'
       or new.completed_by_user_id is distinct from old.completed_by_user_id
       or new.completed_by_basis is distinct from old.completed_by_basis) then
    perform training.lock_activity_decider(new.completed_by_user_id, new.owner_team_id, new.completed_by_basis);
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function training.protect_activity_completion_log() returns trigger as $$
begin
  if tg_op = 'DELETE' and training_load.session_undo_marker_ok() then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'activity_completion_log is append-only (% refused)', tg_op;
  end if;
  -- A log row belongs to the canonical team session it describes, like
  -- every other row that points at an activity.
  perform training.assert_canonical_team_activity(new.activity_id, null, 'activity_completion_log');
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 4. The roster work of a session, split in two kinds, and the scope that carries it
-- ---------------------------------------------------------------------------
create function training_load.session_undo_roster_work(p_alias uuid[]) returns jsonb as $$
  -- The roster work of an alias set, split in two disjoint kinds (J20 section 5.3, extended variant b):
  --   importWritten = what the J20 flow wrote: requests of origin 'import', decisions of athletes whose whole chain is such
  --                   requests', completion log rows of such requests, completions all of whose log rows are such;
  --   later         = everything else, a coach's own work: a request of origin 'roster', every decision of an athlete who has
  --                   one (a later decision that supersedes an import-origin one makes the chain later work), a log row of a
  --                   request of another origin or with none, a completion with any such log row (or none).
  -- The fingerprint covers the ids of the later work (and the completion revisions) in a fixed order.
  with req as (
    select id, activity_id, origin from training.activity_roster_requests where activity_id = any(p_alias)
  ), dec as (
    select d.id, d.athlete_id, d.decision_kind, d.reason_key, d.decided_by_user_id, d.decided_at, d.request_id
      from training.activity_athlete_decisions d where d.activity_id = any(p_alias)
  ), later_athletes as (
    select distinct d.athlete_id from dec d join req r on r.id = d.request_id where r.origin <> 'import'
  ), dec_c as (
    select d.*, d.athlete_id in (select athlete_id from later_athletes) as is_later from dec d
  ), logs as (
    select l.id, l.activity_id, coalesce(r.origin, 'roster') <> 'import' as is_later
      from training.activity_completion_log l left join req r on r.id = l.request_id
     where l.activity_id = any(p_alias)
  ), comp as (
    select c.activity_id, c.revision,
           (not exists (select 1 from logs l where l.activity_id = c.activity_id)
            or exists (select 1 from logs l where l.activity_id = c.activity_id and l.is_later)) as is_later
      from training.activity_completions c where c.activity_id = any(p_alias)
  ), tagged as (
    select 'd:' || id::text as k from dec_c where is_later
    union all select 'r:' || id::text from req where origin <> 'import'
    union all select 'c:' || activity_id::text || ':' || revision::text from comp where is_later
    union all select 'l:' || id::text from logs where is_later
  )
  select jsonb_build_object(
    'importWritten', jsonb_build_object(
      'decisions', (select count(*)::int from dec_c where not is_later),
      'requests', (select count(*)::int from req where origin = 'import'),
      'completions', (select count(*)::int from comp where not is_later),
      'completionLog', (select count(*)::int from logs where not is_later)),
    'later', jsonb_build_object(
      'decisions', (select count(*)::int from dec_c where is_later),
      'requests', (select count(*)::int from req where origin <> 'import'),
      'completions', (select count(*)::int from comp where is_later),
      'completionLog', (select count(*)::int from logs where is_later)),
    'laterDecisions', coalesce((
      select jsonb_agg(jsonb_build_object('athleteId', x.athlete_id, 'kind', x.decision_kind, 'reasonCode', x.reason_key,
                                          'decidedByUserId', x.decided_by_user_id, 'decidedAt', x.decided_at) order by x.decided_at, x.id)
        from (select * from dec_c where is_later order by decided_at, id limit 500) x), '[]'::jsonb),
    'laterDecisionsTotal', (select count(*)::int from dec_c where is_later),
    'fingerprint', md5(coalesce((select string_agg(k, ',' order by k) from tagged), '')));
$$ language sql stable;

create or replace function training_load.session_undo_scope(p_event uuid) returns jsonb as $$
declare
  v_event record;
  v_part uuid[];
  v_occ uuid[];
  v_seg uuid[];
  v_ident uuid[];
  v_batch uuid[];
  v_act uuid[];
  v_obs uuid[];
  v_reached uuid[];
  v_alias uuid[];
  v_binding record;
  v_values integer := 0;
  v_manual integer := 0;
  v_shared integer := 0;
  v_other_links integer := 0;
  v_entangled integer := 0;
  v_calendar integer := 0;
  v_write_requests integer := 0;
  v_roster jsonb;
begin
  select e.id, e.source_connection_id, e.source_external_id, e.owner_team_id, e.occurred_date, c.source_system
    into v_event
    from training_load.metric_events e
    left join training_load.metric_source_connections c on c.id = e.source_connection_id
   where e.id = p_event;
  if not found then
    perform training_load.session_undo_refuse('event_missing');
  end if;
  v_part := coalesce(array(select id from training_load.metric_event_participants where event_id = p_event order by id), '{}');
  v_occ := coalesce(array(select id from training_load.metric_measurement_occasions where event_participant_id = any(v_part) order by id), '{}');
  select count(*)::int into v_manual from training_load.metric_measurement_occasions where id = any(v_occ) and entry_method = 'manual';
  select count(*)::int into v_values from training_load.metric_values where occasion_id = any(v_occ);
  v_seg := coalesce(array(select id from training_load.metric_event_segments where event_id = p_event order by id), '{}');
  select b.event_id, b.reference_set_external_id into v_binding from training_load.metric_event_source_bindings b where b.event_id = p_event;
  v_batch := coalesce(array(select distinct import_batch_id from training_load.metric_measurement_occasions where id = any(v_occ) and import_batch_id is not null order by 1), '{}');
  -- The occasions' identities and the session's own reservation identity (found through the EVENT's connection and
  -- external id, not the binding's: a binding may be absent).
  v_ident := coalesce(array(
    select id from (
      select source_identity_id as id from training_load.metric_measurement_occasions where id = any(v_occ) and source_identity_id is not null
      union
      select si.id from training_load.metric_source_identities si
       where v_event.source_connection_id is not null and v_event.source_external_id is not null
         and si.source_connection_id = v_event.source_connection_id and si.source_external_id = v_event.source_external_id
    ) x order by id), '{}');
  -- The activities this session reaches: through its participants OR a direct event link.
  v_reached := coalesce(array(
    select activity_id from (
      select ap.activity_id
        from training.activity_participants ap
        join training.activity_participant_metric_participant_links pl on pl.activity_participant_id = ap.id
       where pl.metric_event_participant_id = any(v_part)
      union
      select activity_id from training.activity_metric_event_links where metric_event_id = p_event
    ) r order by activity_id), '{}');
  v_act := coalesce(array(
    select distinct ap.activity_id
      from training.activity_participants ap
      join training.activity_participant_metric_participant_links l on l.activity_participant_id = ap.id
     where l.metric_event_participant_id = any(v_part)
     order by 1), '{}');
  select count(*)::int into v_shared
    from training.activity_participants ap2
    join training.activity_participant_metric_participant_links l2 on l2.activity_participant_id = ap2.id
    join training_load.metric_event_participants p2 on p2.id = l2.metric_event_participant_id
   where ap2.activity_id = any(v_act) and p2.event_id <> p_event;
  select count(*)::int into v_other_links
    from training.activity_metric_event_links l
   where l.activity_id = any(v_reached) and l.metric_event_id <> p_event;
  select count(*)::int into v_entangled
    from training.activities a
   where a.id = any(v_reached)
     and (a.lifecycle_state = 'superseded' or a.superseded_by_activity_id is not null
          or exists (select 1 from training.activity_participant_merge_log m where m.source_activity_id = a.id or m.target_activity_id = a.id)
          or exists (select 1 from training.activity_participant_reparent_log r where r.from_activity_id = a.id or r.to_activity_id = a.id));
  -- The whole alias set of every reached activity (v25 rosters).
  v_alias := coalesce(array(
    select aa.activity_id
      from (select distinct training.resolve_canonical_activity_id(r) as canonical_id from unnest(v_reached) r) c
      cross join lateral training.activity_alias_ids(c.canonical_id) aa
     order by 1), '{}');
  v_roster := training_load.session_undo_roster_work(v_alias);
  v_obs := coalesce(array(select id from training.activity_source_observations where activity_id = any(v_alias) order by id), '{}');
  select count(*)::int into v_calendar from calendar.event_activity_links where activity_id = any(v_reached) or activity_id = any(v_alias);
  select count(*)::int into v_write_requests from training_load.metric_write_requests
   where result_event_id = p_event or result_occasion_id = any(v_occ);
  return jsonb_build_object(
    'eventId', p_event,
    'connectionId', v_event.source_connection_id,
    'ownerTeamId', v_event.owner_team_id,
    'occurredDate', v_event.occurred_date,
    'sourceSystem', v_event.source_system,
    'externalId', v_event.source_external_id,
    'participantIds', to_jsonb(v_part),
    'occasionIds', to_jsonb(v_occ),
    'valueCount', v_values,
    'segmentIds', to_jsonb(v_seg),
    'identityIds', to_jsonb(v_ident),
    'hasBinding', v_binding.event_id is not null,
    'referenceSetExternalId', v_binding.reference_set_external_id,
    'activityIds', to_jsonb(v_act),
    'batchIds', to_jsonb(v_batch),
    'observationIds', to_jsonb(v_obs),
    'manualOccasionCount', v_manual,
    'sharedActivityCount', v_shared,
    'otherEventLinkCount', v_other_links,
    'entangledActivityCount', v_entangled,
    'calendarLinkCount', v_calendar,
    'manualWriteRequestCount', v_write_requests,
    'rosterWork', v_roster,
    'aliasIds', to_jsonb(v_alias));
end;
-- Volatile on purpose: every statement of the body takes its own snapshot, so the second look (after the activities are
-- locked) sees a link committed while the lock was waited for.
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 5. The undo: the 6-argument function goes, the 7-argument one comes
-- ---------------------------------------------------------------------------
drop function training_load.undo_imported_session(uuid, uuid, uuid, uuid, text, uuid);

create function training_load.undo_imported_session(
  p_actor uuid, p_team uuid, p_candidate uuid, p_request_key uuid, p_reason text, p_expected_event uuid default null,
  p_confirm_later text default null
) returns table (
  replayed boolean, event_id uuid, deletion_log_id uuid, removed_counts jsonb, removed_total integer, new_candidate_id uuid,
  undone_candidate_ids uuid[], roster_work jsonb
) as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_hash text;
  v_req record;
  v_cand record;
  v_offer record;
  v_ids uuid[];
  v_event_id uuid;
  v_event record;
  v_scope jsonb;
  v_act uuid[];
  v_part uuid[];
  v_occ uuid[];
  v_seg uuid[];
  v_ident uuid[];
  v_batch uuid[];
  v_obs uuid[];
  v_work jsonb;
  v_removed jsonb := '{}'::jsonb;
  v_total integer;
  v_n integer;
  v_log uuid;
  v_req_id uuid := gen_random_uuid();
  v_new uuid;
  v_last_status text;
  v_constraint text;
  v_status text;
  v_pass integer := 0;
  v_act_before uuid[];
  v_alias uuid[];
  v_later_n integer;
  v_roster_n integer;
  v_roster_log jsonb;
begin
  if p_actor is null or p_team is null or p_candidate is null or p_request_key is null then
    raise exception 'undo_imported_session: actor, team, candidate and request key are required' using errcode = '22023';
  end if;
  if length(v_reason) not between 1 and 500 or v_reason ~ '[[:cntrl:]]' then
    perform training_load.session_undo_refuse('invalid_reason');
  end if;
  v_hash := encode(sha256(convert_to(p_candidate::text || '|' || v_reason || '|' || coalesce(p_expected_event::text, ''), 'UTF8')), 'hex');

  -- 1. The right: the acting user, then the platform-admin role row (the revocations' order).
  perform 1 from public.users u where u.id = p_actor and u.is_active = true for share;
  if not found then
    raise exception 'user % may not undo an imported session', p_actor using errcode = '42501';
  end if;
  perform 1 from public.user_global_roles r where r.user_id = p_actor and r.role = 'platform_admin' and r.is_active = true for share;
  if not found then
    raise exception 'user % may not undo an imported session', p_actor using errcode = '42501';
  end if;

  -- 1b. An unlocked look at the candidate BEFORE the team lock. The approval locks a candidate row and only then waits for
  --     the team lock, the undo the other way round; an undo aimed at a candidate that is not imported (an approval may hold
  --     it) is therefore refused here, before it can wait for that row while holding the team lock. An imported row can be
  --     locked by an approval that refuses it before waiting for the team lock, and by a check's finalization, which then
  --     only TRY-locks the team (never waits), so the later FOR UPDATE cannot close a cycle. An undone row passes on
  --     purpose: its replay is answered below.
  select c.status into v_status from training_load.gpexe_import_candidates c where c.id = p_candidate and c.owner_team_id = p_team;
  if not found then
    perform training_load.session_undo_refuse('candidate_not_found');
  end if;
  if v_status <> 'imported' then
    perform training_load.session_undo_refuse('candidate_not_imported');
  end if;

  -- 2. The team's import lock: the importer's own key, so an import and an undo of the same team wait for each other.
  perform pg_advisory_xact_lock(hashtextextended('gpexe-import-team:' || lower(p_team::text), 21));

  -- 3. A replay answers the saved outcome before any further lock.
  select * into v_req from training_load.gpexe_session_undo_requests q
   where q.requested_by_user_id = p_actor and q.request_key = p_request_key and q.owner_team_id = p_team;
  if found then
    if v_req.request_hash <> v_hash then
      perform training_load.session_undo_refuse('request_key_reused');
    end if;
    return query select true, v_req.event_id, v_req.deletion_log_id, v_req.removed_counts, v_req.removed_total, v_req.new_candidate_id, v_req.undone_candidate_ids,
                        (select l.roster_work_removed from training_load.import_deletion_log l where l.id = v_req.deletion_log_id);
    return;
  end if;

  -- 4. The event the requested candidate's approval wrote, and every approved version of the session that wrote into it. A
  --    session changed in GPEXE and approved again (acceptChanges) goes into the SAME event (one event per session, v20), so
  --    removing the event undoes all of them: they are locked by id, and the undo marks every one of them.
  select a.metric_event_id into v_event_id from training_load.gpexe_import_approvals a where a.candidate_id = p_candidate;
  if not found then
    perform training_load.session_undo_refuse('approval_missing');
  end if;
  perform 1 from training_load.gpexe_import_candidates c
   where c.owner_team_id = p_team
     and c.id in (select a.candidate_id from training_load.gpexe_import_approvals a where a.metric_event_id = v_event_id)
   order by c.id for update;
  select * into v_cand from training_load.gpexe_import_candidates c where c.id = p_candidate and c.owner_team_id = p_team;
  if not found then
    perform training_load.session_undo_refuse('candidate_not_found');
  end if;
  if v_cand.status <> 'imported' then
    perform training_load.session_undo_refuse('candidate_not_imported');
  end if;
  if v_cand.import_undone_at is not null then
    perform training_load.session_undo_refuse('already_undone');
  end if;
  v_ids := coalesce(array(
    select c.id from training_load.gpexe_import_candidates c
      join training_load.gpexe_import_approvals a on a.candidate_id = c.id
     where a.metric_event_id = v_event_id and c.owner_team_id = p_team and c.status = 'imported' and c.import_undone_at is null
     order by c.id), '{}');

  -- 5. The event, locked, and the identity of what is about to be removed.
  if p_expected_event is not null and p_expected_event <> v_event_id then
    perform training_load.session_undo_refuse('event_mismatch');
  end if;
  select e.id, e.owner_team_id, e.source_external_id into v_event
    from training_load.metric_events e where e.id = v_event_id for update;
  if not found then
    perform training_load.session_undo_refuse('event_missing');
  end if;
  if v_event.owner_team_id is distinct from p_team then
    perform training_load.session_undo_refuse('event_team_mismatch');
  end if;
  if v_event.source_external_id is distinct from 'team_session:' || v_cand.gpexe_team_session_id then
    perform training_load.session_undo_refuse('event_session_mismatch');
  end if;
  if (select count(*) from training_load.metric_events e2
       join training_load.metric_source_connections c2 on c2.id = e2.source_connection_id
      where c2.source_system = 'gpexe' and e2.owner_team_id = p_team and e2.source_external_id = v_event.source_external_id) > 1 then
    perform training_load.session_undo_refuse('two_events_for_session');
  end if;

  -- 6. The scope, collected again after the activities are locked (a link added meanwhile is seen here or waits).
  v_scope := training_load.session_undo_scope(v_event_id);
  v_act := coalesce(array(select jsonb_array_elements_text(v_scope -> 'activityIds')::uuid), '{}');
  -- Lock the activities, look again, and repeat until the set no longer grows (a link added while a lock was waited for is
  -- seen by the next look; three rounds are far more than the importer's own creation under the team lock can need).
  loop
    exit when cardinality(v_act) = 0;
    perform 1 from training.activities a where a.id = any(v_act) order by a.id for update;
    v_act_before := v_act;
    v_scope := training_load.session_undo_scope(v_event_id);
    v_act := coalesce(array(select jsonb_array_elements_text(v_scope -> 'activityIds')::uuid), '{}');
    exit when v_act <@ v_act_before;
    v_pass := v_pass + 1;
    if v_pass >= 3 then
      raise exception 'undo_imported_session: the activities of the event keep changing' using errcode = '55P03';
    end if;
  end loop;
  if (v_scope ->> 'manualOccasionCount')::int > 0 then
    perform training_load.session_undo_refuse('manual_occasion');
  end if;
  if (v_scope ->> 'sharedActivityCount')::int > 0 then
    perform training_load.session_undo_refuse('shared_activity');
  end if;
  if (v_scope ->> 'otherEventLinkCount')::int > 0 then
    perform training_load.session_undo_refuse('other_event_link');
  end if;
  -- v60: roster work never blocks the undo. What the import flow wrote (origin 'import') goes with the session; a later
  -- coach's work goes too, but only on an explicit confirmation that carries the fingerprint of the list the administrator saw,
  -- compared here, under the team lock and the activity locks, with the list as it is NOW (a changed list: nothing is removed).
  -- 'preview' is the read-only call's marker (the service rolls its transaction back): it skips the gate and shows the blocks.
  v_work := v_scope -> 'rosterWork';
  v_alias := coalesce(array(select jsonb_array_elements_text(v_scope -> 'aliasIds')::uuid), '{}');
  v_later_n := (v_work -> 'later' ->> 'decisions')::int + (v_work -> 'later' ->> 'requests')::int
             + (v_work -> 'later' ->> 'completions')::int + (v_work -> 'later' ->> 'completionLog')::int;
  v_roster_n := v_later_n + (v_work -> 'importWritten' ->> 'decisions')::int + (v_work -> 'importWritten' ->> 'requests')::int
             + (v_work -> 'importWritten' ->> 'completions')::int + (v_work -> 'importWritten' ->> 'completionLog')::int;
  if p_confirm_later is distinct from 'preview' then
    if (v_work ->> 'laterDecisionsTotal')::int > 500 then
      perform training_load.session_undo_refuse('roster_work_too_large', v_work::text);
    end if;
    if p_confirm_later is not null and p_confirm_later is distinct from (v_work ->> 'fingerprint') then
      perform training_load.session_undo_refuse('roster_work_changed', v_work::text);
    end if;
    if v_later_n > 0 and p_confirm_later is null then
      perform training_load.session_undo_refuse('roster_work_needs_confirmation', v_work::text);
    end if;
  end if;
  if (v_scope ->> 'entangledActivityCount')::int > 0 then
    perform training_load.session_undo_refuse('entangled_activity');
  end if;
  if (v_scope ->> 'calendarLinkCount')::int > 0 then
    perform training_load.session_undo_refuse('calendar_link_exists', v_scope ->> 'calendarLinkCount');
  end if;
  if (v_scope ->> 'manualWriteRequestCount')::int > 0 then
    perform training_load.session_undo_refuse('manual_write_request_exists');
  end if;
  v_part := coalesce(array(select jsonb_array_elements_text(v_scope -> 'participantIds')::uuid), '{}');
  v_occ := coalesce(array(select jsonb_array_elements_text(v_scope -> 'occasionIds')::uuid), '{}');
  v_seg := coalesce(array(select jsonb_array_elements_text(v_scope -> 'segmentIds')::uuid), '{}');
  v_ident := coalesce(array(select jsonb_array_elements_text(v_scope -> 'identityIds')::uuid), '{}');
  v_batch := coalesce(array(select jsonb_array_elements_text(v_scope -> 'batchIds')::uuid), '{}');
  v_obs := coalesce(array(select jsonb_array_elements_text(v_scope -> 'observationIds')::uuid), '{}');

  -- 7. The removal, in the CLI's order, under the marker.
  perform set_config('optimove.session_undo_tx', txid_current()::text, true);
  begin
    -- The roster work of the whole alias set (v25 tables, append-only except under the marker): the decisions first (they
    -- point at occasions), then the completion log, the completions and the requests that all of them hang on.
    if cardinality(v_alias) > 0 and v_roster_n > 0 then
      delete from training.activity_athlete_decisions where activity_id = any(v_alias);
      get diagnostics v_n = row_count;
      if v_n > 0 then v_removed := training_load.session_undo_add(v_removed, 'activity_athlete_decisions', v_n); end if;
      delete from training.activity_completion_log where activity_id = any(v_alias);
      get diagnostics v_n = row_count;
      if v_n > 0 then v_removed := training_load.session_undo_add(v_removed, 'activity_completion_log', v_n); end if;
      delete from training.activity_completions where activity_id = any(v_alias);
      get diagnostics v_n = row_count;
      if v_n > 0 then v_removed := training_load.session_undo_add(v_removed, 'activity_completions', v_n); end if;
      delete from training.activity_roster_requests where activity_id = any(v_alias);
      get diagnostics v_n = row_count;
      if v_n > 0 then v_removed := training_load.session_undo_add(v_removed, 'activity_roster_requests', v_n); end if;
    end if;
    if cardinality(v_obs) > 0 then
      delete from training.activity_source_observations where id = any(v_obs);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activity_source_observations', v_n);
    end if;
    if cardinality(v_act) > 0 then
      delete from training.activity_component_metric_segment_links l using training.activity_components c
       where c.id = l.activity_component_id and c.activity_id = any(v_act);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activity_component_metric_segment_links', v_n);
      delete from training.activity_components where activity_id = any(v_act);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activity_components', v_n);
      -- Only this event's links: a foreign one left behind makes the activity delete fail and the whole call roll back.
      delete from training.activity_participant_metric_participant_links l using training_load.metric_event_participants p
       where p.id = l.metric_event_participant_id and p.event_id = v_event_id;
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activity_participant_metric_participant_links', v_n);
      delete from training.activity_participants where activity_id = any(v_act);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activity_participants', v_n);
      delete from training.activity_metric_event_links where metric_event_id = v_event_id;
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activity_metric_event_links', v_n);
      delete from training.activities where id = any(v_act);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activities', v_n);
    end if;
    if cardinality(v_occ) > 0 then
      delete from training_load.metric_value_source_provenance p using training_load.metric_values v
       where v.id = p.metric_value_id and v.occasion_id = any(v_occ);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_value_source_provenance', v_n);
      delete from training_load.metric_values where occasion_id = any(v_occ);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_values', v_n);
      update training_load.metric_source_identities set current_occasion_id = null where current_occasion_id = any(v_occ);
      -- One statement for the whole chain: occasions point at each other and the checks run at the end of the statement.
      delete from training_load.metric_measurement_occasions where id = any(v_occ);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_measurement_occasions', v_n);
    end if;
    if cardinality(v_ident) > 0 then
      delete from training_load.metric_source_identities where id = any(v_ident);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_source_identities', v_n);
    end if;
    if cardinality(v_part) > 0 then
      delete from training_load.metric_event_participants where id = any(v_part);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_event_participants', v_n);
    end if;
    if cardinality(v_seg) > 0 then
      delete from training_load.metric_event_segments where id = any(v_seg);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_event_segments', v_n);
    end if;
    if (v_scope ->> 'hasBinding')::boolean then
      delete from training_load.metric_event_source_bindings b where b.event_id = v_event_id;
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_event_source_bindings', v_n);
    end if;
    delete from training_load.metric_events where id = v_event_id;
    get diagnostics v_n = row_count;
    v_removed := training_load.session_undo_add(v_removed, 'metric_events', v_n);
    if cardinality(v_batch) > 0 then
      delete from training_load.metric_import_batches b
       where b.id = any(v_batch)
         and not exists (select 1 from training_load.metric_measurement_occasions o where o.import_batch_id = b.id);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_import_batches', v_n);
    end if;
  exception when foreign_key_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform training_load.session_undo_refuse('referenced_elsewhere', v_constraint);
  end;
  select coalesce(sum(value::int), 0)::int into v_total from jsonb_each_text(v_removed);

  -- 8. The deletion log (v21): one row, in this transaction, after the event is gone.
  if v_roster_n > 0 then
    v_roster_log := jsonb_build_object(
      'importWritten', v_work -> 'importWritten', 'later', v_work -> 'later',
      'laterDecisions', v_work -> 'laterDecisions', 'laterDecisionsTotal', (v_work ->> 'laterDecisionsTotal')::int,
      'confirmedByUserId', p_actor, 'laterConfirmed', v_later_n > 0);
  end if;
  insert into training_load.import_deletion_log
    (deleted_by_user_id, authorized_via, reason, event_id, source_system, source_connection_id, source_external_id,
     owner_team_id, occurred_date, reference_set_external_id, removed_counts, removed_total, roster_work_removed)
  values (p_actor, 'platform_admin', v_reason, v_event_id, v_scope ->> 'sourceSystem', (v_scope ->> 'connectionId')::uuid,
          v_scope ->> 'externalId', (v_scope ->> 'ownerTeamId')::uuid, (v_scope ->> 'occurredDate')::date,
          v_scope ->> 'referenceSetExternalId', v_removed, v_total, v_roster_log)
  returning id into v_log;

  -- 9. Every candidate of the event is marked undone (their request is checked at the end of this call). Then, for the NEWEST
  --    approved content among them, when its raw snapshot is still available, the check that last saw it succeeded and the
  --    team has no live candidate of the session with other content, a fresh pending candidate of that content is written.
  update training_load.gpexe_import_candidates
     set import_undone_at = clock_timestamp(), import_undone_request_id = v_req_id
   where id = any(v_ids);
  select c.* into v_offer
    from training_load.gpexe_import_candidates c
    join training_load.gpexe_import_approvals a on a.candidate_id = c.id
   where c.id = any(v_ids)
   order by a.approved_at desc, c.id desc limit 1;
  select k.status into v_last_status from training_load.gpexe_import_checks k
   where k.id = v_offer.last_seen_check_id and k.owner_team_id = p_team;
  if v_offer.raw_bundle is not null and v_offer.raw_purged_at is null and v_offer.raw_expires_at > now()
     and v_last_status = 'succeeded'
     -- Never offer content older than what the team already has: a live candidate of the same session with other content
     -- (newer data a search published) means the old snapshot would be approvable over it.
     and not exists (select 1 from training_load.gpexe_import_candidates o
                      where o.owner_team_id = p_team and o.gpexe_team_session_id = v_offer.gpexe_team_session_id
                        and o.import_undone_at is null and o.bundle_hash <> v_offer.bundle_hash
                        and o.status in ('pending', 'blocked', 'imported')) then
    v_new := gen_random_uuid();
    insert into training_load.gpexe_import_candidates
      (id, owner_team_id, gpexe_team_session_id, session_started_at, session_label, bundle_hash, raw_bundle, raw_expires_at,
       status, first_seen_check_id, last_seen_check_id, first_seen_at, last_seen_at, drill_parameter_effect)
    values (v_new, p_team, v_offer.gpexe_team_session_id, v_offer.session_started_at, v_offer.session_label, v_offer.bundle_hash,
            v_offer.raw_bundle, least(v_offer.raw_expires_at, now() + interval '30 days'), 'pending',
            v_offer.first_seen_check_id, v_offer.last_seen_check_id, v_offer.first_seen_at, now(), v_offer.drill_parameter_effect);
  end if;

  -- 10. The request record, then the deferred link is checked here, not at the COMMIT.
  insert into training_load.gpexe_session_undo_requests
    (id, requested_by_user_id, request_key, request_hash, owner_team_id, candidate_id, undone_candidate_ids, event_id,
     deletion_log_id, reason, removed_counts, removed_total, new_candidate_id)
  values (v_req_id, p_actor, p_request_key, v_hash, p_team, p_candidate, v_ids, v_event_id, v_log, v_reason, v_removed, v_total, v_new);
  set constraints training_load.gpexe_import_candidates_import_undone_request_fkey immediate;
  -- The marker covers this call only.
  perform set_config('optimove.session_undo_tx', '', true);
  return query select false, v_event_id, v_log, v_removed, v_total, v_new, v_ids, v_work;
end;
$$ language plpgsql;

comment on function training_load.undo_imported_session(uuid, uuid, uuid, uuid, text, uuid, text) is
  'v60: the sanctioned undo of one imported GPEXE session (platform admin only). Roster work never blocks it; a coach''s later work goes only on the fingerprint of the list shown. See migrations_v2/202611091200_training_load_v60_session_undo_roster_work.sql.';

-- ---------------------------------------------------------------------------
-- 6. Post-gate: the new bodies are in force and the old signature is gone
-- ---------------------------------------------------------------------------
do $$
declare
  expected constant text[][] := array[
    ['training_load', 'undo_imported_session', 'd7dddfdd0fbd4430b9892e1948b2b3bb'],
    ['training_load', 'session_undo_scope', '514617da209da9d2703477ef5c4a69dd'],
    ['training_load', 'session_undo_roster_work', '1b6b9dae1db45b329ca24f522fd0a06d'],
    ['training', 'protect_activity_roster_request', '48dd4baacbfb374847515356e1a33c42'],
    ['training', 'check_activity_athlete_decision', 'cb038617f44d1e6028825d73f5048c64'],
    ['training', 'protect_activity_completion', '1bd5b84c90536e4a7802e2ed2c3e7229'],
    ['training', 'protect_activity_completion_log', '310479ead5bac4ba0ada834a6c20543c'],
    ['training_load', 'validate_import_deletion_log', '8bc1c58cee9d8a42b9d7bdec06978f5b'],
    ['training_load', 'import_deletion_log_roster_work_ok', '15b84bbba78720367aa55bb11eaa76fa']];
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2]) is distinct from expected[i][3] then
      raise exception 'v60 failed: the body of %.% is not the one this migration installs', expected[i][1], expected[i][2] using errcode = '23514';
    end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'undo_imported_session') <> 1
     or (select pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'training_load' and p.proname = 'undo_imported_session') <> 7 then
    raise exception 'v60 failed: undo_imported_session must exist once, with seven arguments' using errcode = '23514';
  end if;
end;
$$;

-- v76: an imported session is deleted by whoever may import it (the owner's decision of 2026-11-17).
--
-- Until v76 the in-app undo (U5, v57; v60's roster work; v63) was a platform admin's only, hard-wired in three places:
-- undo_imported_session's right block, import_deletion_log's authorized_via CHECK, and its insert trigger's function
-- validate_import_deletion_log_v60 (v60 rebound the trigger to it; v21's validate_import_deletion_log is no longer called and
-- is left as it is). The
-- owner: "deleting may be done by the coach, i.e. by whoever imports". The Rukovodilac's decisions (2026-11-17):
--
--   * The right to undo is the right to approve an import of that team - the same four bases, in the same order, with the
--     same mode rule as lock_gpexe_import_approver (v56): platform_admin; team_grant (an active coach of the team with an
--     unrevoked approver grant); club_admin of the team's club and team_coach of the team, both only while the team's
--     switch is in mode 'team'. Option (a): the switch being OFF does not take the right away (a wrong import must stay
--     deletable); in pilot mode (or with no switch row) club_admin and team_coach are no right.
--   * The new function training_load.lock_gpexe_session_undo_right(user, team) derives it under FOR SHARE locks in the
--     revocations' order: users, then the role rows, then the switch row, then the team and its club (an archived
--     team or club is no right). 42501 'user % may not undo an imported
--     session' when there is none (the route answers the identical 404).
--   * undo_imported_session takes its right from it and writes the basis to the deletion log.
--   * import_deletion_log.authorized_via takes the four bases; validate_import_deletion_log_v60 derives the basis again and
--     refuses a row whose authorized_via is not the user's (a coach cannot log an undo as platform_admin).
--
-- Bodies are replaced after an md5 check of the body in force (v74 touches neither). New lines sit between
-- "-- v76 begin" and "-- v76 end". No table, column or row changes.
-- Locks: the deletion log ACCESS EXCLUSIVE (its CHECK), lock_timeout 5 s, before the first change; a busy table fails the
-- migration with nothing applied.
-- Rollback: docs/runbooks/undo-by-importer-v76-rollback.sql (refuses once a log row has another basis).

set local lock_timeout = '5s';
lock table training_load.import_deletion_log in access exclusive mode;

-- 1. Written on the bodies in force: refuse any other.
do $$
declare
  expected constant text[][] := array[
    ['undo_imported_session', 'cf208f99e3e4db738670dec2567dc8fc', 'v63'],
    ['validate_import_deletion_log_v60', '1c949a5f6a8383724ec1836b0ed3dddd', 'v60']];
  i integer;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = expected[i][1]) is distinct from expected[i][2] then
      raise exception 'v76 refused: the body in force of training_load.% is not %''s', expected[i][1], expected[i][3] using errcode = '23514';
    end if;
  end loop;
  if (select count(*) from pg_constraint where conrelid = 'training_load.import_deletion_log'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%authorized_via%') <> 1 then
    raise exception 'v76 refused: exactly one authorized_via CHECK is expected' using errcode = '23514';
  end if;
end $$;

-- 2. The right to undo an imported session (the approval's right, without the switch's on/off).
create function training_load.lock_gpexe_session_undo_right(p_user_id uuid, p_team_id uuid) returns text as $$
declare
  v_basis text;
  v_club uuid;
  v_role_club uuid; -- the club the club_admin role was checked for (compared again under the team's lock)
  v_peek text;
  v_mode text;
begin
  -- The acting user first, then the role rows (the revocations' order); the switch row last.
  perform 1 from public.users u where u.id = p_user_id and u.is_active = true for share;
  if not found then
    raise exception 'user % may not undo an imported session', p_user_id using errcode = '42501';
  end if;
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_user_id and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
   for share of r;
  if found then
    v_basis := 'platform_admin';
  end if;
  if v_basis is null then
    perform 1
      from training_load.gpexe_import_approvers a
      join public.user_team_roles tr on tr.user_id = a.user_id and tr.team_id = a.owner_team_id
           and tr.role = 'team_coach' and tr.is_active = true
      join public.users u on u.id = a.user_id and u.is_active = true
     where a.user_id = p_user_id and a.owner_team_id = p_team_id and a.revoked_at is null
     for share of a, tr;
    if found then
      v_basis := 'team_grant';
    end if;
  end if;
  -- club_admin / team_coach count only while the team is in mode 'team' (peeked without a lock, decided again below).
  select s.mode into v_peek from training_load.gpexe_team_import_switch s where s.owner_team_id = p_team_id;
  if v_basis is null and v_peek = 'team' then
    select t.club_id into v_club from public.teams t where t.id = p_team_id;
    v_role_club := v_club;
    perform 1
      from public.user_club_roles cr
      join public.users u on u.id = cr.user_id and u.is_active = true
     where cr.user_id = p_user_id and cr.club_id = v_club and cr.role = 'club_admin' and cr.is_active = true
     for share of cr;
    if found then
      v_basis := 'club_admin';
    end if;
  end if;
  if v_basis is null and v_peek = 'team' then
    perform 1
      from public.user_team_roles tr
      join public.users u on u.id = tr.user_id and u.is_active = true
     where tr.user_id = p_user_id and tr.team_id = p_team_id and tr.role = 'team_coach' and tr.is_active = true
     for share of tr;
    if found then
      v_basis := 'team_coach';
    end if;
  end if;
  if v_basis is null then
    raise exception 'user % may not undo an imported session', p_user_id using errcode = '42501';
  end if;
  -- The switch row last, FOR SHARE: a change of mode waits for this undo, and one committed before it is seen here. Its
  -- on/off is not read (option (a)).
  select s.mode into v_mode from training_load.gpexe_team_import_switch s where s.owner_team_id = p_team_id for share;
  if v_basis in ('club_admin', 'team_coach') and v_mode is distinct from 'team' then
    raise exception 'user % may not undo an imported session', p_user_id using errcode = '42501';
  end if;
  -- The team, then its club, FOR SHARE (the approval's lockApprovalTeam): an archived team or club is no right, for every
  -- basis, and an archive waits for an undo in flight (the archive writers are single statements: no cycle).
  select t.club_id into v_club from public.teams t where t.id = p_team_id and coalesce(t.is_active, true) for share;
  if not found then
    raise exception 'user % may not undo an imported session', p_user_id using errcode = '42501';
  end if;
  -- A club admin's role was checked for the club read before this lock: a team moved to another club in between is no
  -- right. The other bases name the team itself (the grant, the team role), not its club.
  if v_basis = 'club_admin' and v_club is distinct from v_role_club then
    raise exception 'user % may not undo an imported session', p_user_id using errcode = '42501';
  end if;
  if v_club is not null then
    perform 1 from public.clubs c where c.id = v_club and coalesce(c.is_active, true) for share;
    if not found then
      raise exception 'user % may not undo an imported session', p_user_id using errcode = '42501';
    end if;
  end if;
  return v_basis;
end;
$$ language plpgsql;
comment on function training_load.lock_gpexe_session_undo_right(uuid, uuid) is
  'v76: the right to undo an imported session of a team - the approval right''s four bases and mode rule (v56), without the switch''s on/off; FOR SHARE, users first.';

-- 3. The deletion log takes the four bases.
do $$
declare v_name text;
begin
  select conname into v_name from pg_constraint where conrelid = 'training_load.import_deletion_log'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%authorized_via%';
  execute format('alter table training_load.import_deletion_log drop constraint %I', v_name);
end $$;
alter table training_load.import_deletion_log
  add constraint import_deletion_log_authorized_via_check
  check (authorized_via in ('platform_admin', 'team_grant', 'club_admin', 'team_coach'));

-- 4. The replaced bodies.
CREATE OR REPLACE FUNCTION training_load.undo_imported_session(p_actor uuid, p_team uuid, p_candidate uuid, p_request_key uuid, p_reason text, p_expected_event uuid DEFAULT NULL::uuid, p_later_roster_fingerprint text DEFAULT NULL::text)
 RETURNS TABLE(replayed boolean, event_id uuid, deletion_log_id uuid, removed_counts jsonb, removed_total integer, new_candidate_id uuid, undone_candidate_ids uuid[], roster_work_removed jsonb)
 LANGUAGE plpgsql
AS $function$
declare
  v_basis text; -- v76: the right this undo is made on
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
  v_confirm boolean := p_later_roster_fingerprint is not null;
  v_alias uuid[];
  v_later_total integer;
  v_roster_removed jsonb;
  v_roster_n integer;
begin
  if p_actor is null or p_team is null or p_candidate is null or p_request_key is null then
    raise exception 'undo_imported_session: actor, team, candidate and request key are required' using errcode = '22023';
  end if;
  if length(v_reason) not between 1 and 500 or v_reason ~ '[[:cntrl:]]' then
    perform training_load.session_undo_refuse('invalid_reason');
  end if;
  if v_confirm and p_later_roster_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'undo_imported_session: the later roster work fingerprint is 64 lowercase hex characters' using errcode = '22023';
  end if;
  -- v57's hash when nothing is confirmed (a v57 request replays unchanged); a confirmation is part of the request.
  v_hash := encode(sha256(convert_to(p_candidate::text || '|' || v_reason || '|' || coalesce(p_expected_event::text, '')
                                     || case when v_confirm then '|confirm|' || p_later_roster_fingerprint else '' end, 'UTF8')), 'hex');

  -- 1. The right: -- v76 begin whoever may approve an import of this team (the owner's decision of 2026-11-17), derived by
  --    lock_gpexe_session_undo_right: the acting user, then the role rows, then the team's switch row, each FOR SHARE (the
  --    revocations' order, and the order of the approval's own lock_gpexe_import_approver). The switch being off is no
  --    refusal here: a wrong import stays deletable. -- v76 end
  v_basis := training_load.lock_gpexe_session_undo_right(p_actor, p_team);

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
  if (v_scope ->> 'entangledActivityCount')::int > 0 then
    perform training_load.session_undo_refuse('entangled_activity');
  end if;
  if (v_scope ->> 'calendarLinkCount')::int > 0 then
    perform training_load.session_undo_refuse('calendar_link_exists', v_scope ->> 'calendarLinkCount');
  end if;
  if (v_scope ->> 'manualWriteRequestCount')::int > 0 then
    perform training_load.session_undo_refuse('manual_write_request_exists');
  end if;
  -- v60 (O1): the roster work never blocks what the import wrote; LATER work is removed only with a confirmation of
  -- exactly the list computed here, under the team's import lock (every roster command takes it too).
  v_work := v_scope -> 'rosterWork';
  v_later_total := (v_work -> 'laterWork' ->> 'decisions')::int + (v_work -> 'laterWork' ->> 'requests')::int
                 + (v_work -> 'laterWork' ->> 'completions')::int + (v_work -> 'laterWork' ->> 'completionLog')::int;
  if v_later_total > 0 then
    if not v_confirm then
      perform training_load.session_undo_refuse('roster_work_needs_confirmation', v_work::text);
    end if;
    if p_later_roster_fingerprint is distinct from v_work -> 'laterWork' ->> 'fingerprint' then
      perform training_load.session_undo_refuse('roster_work_changed', v_work::text);
    end if;
  elsif v_confirm then
    -- A fingerprint confirms a list; with no later work at all that list is gone.
    perform training_load.session_undo_refuse('roster_work_changed', v_work::text);
  end if;
  v_alias := coalesce(array(select jsonb_array_elements_text(v_scope -> 'aliasActivityIds')::uuid), '{}');
  v_part := coalesce(array(select jsonb_array_elements_text(v_scope -> 'participantIds')::uuid), '{}');
  v_occ := coalesce(array(select jsonb_array_elements_text(v_scope -> 'occasionIds')::uuid), '{}');
  v_seg := coalesce(array(select jsonb_array_elements_text(v_scope -> 'segmentIds')::uuid), '{}');
  v_ident := coalesce(array(select jsonb_array_elements_text(v_scope -> 'identityIds')::uuid), '{}');
  v_batch := coalesce(array(select jsonb_array_elements_text(v_scope -> 'batchIds')::uuid), '{}');
  v_obs := coalesce(array(select jsonb_array_elements_text(v_scope -> 'observationIds')::uuid), '{}');

  -- 7. The removal, in the CLI's order, under the marker.
  perform set_config('optimove.session_undo_tx', txid_current()::text, true);
  begin
    -- v60: the roster work of the alias set first (decisions -> completion log -> completions -> requests); each count must
    -- be the one the scope counted, or the work changed under the call.
    delete from training.activity_athlete_decisions where activity_id = any(v_alias);
    get diagnostics v_n = row_count;
    v_roster_n := v_n;
    if v_n <> (v_work ->> 'decisions')::int then
      perform training_load.session_undo_refuse('roster_work_changed', v_work::text);
    end if;
    v_removed := training_load.session_undo_add(v_removed, 'activity_athlete_decisions', v_n);
    delete from training.activity_completion_log where activity_id = any(v_alias);
    get diagnostics v_n = row_count;
    v_roster_n := v_roster_n + v_n;
    if v_n <> (v_work ->> 'completionLog')::int then
      perform training_load.session_undo_refuse('roster_work_changed', v_work::text);
    end if;
    v_removed := training_load.session_undo_add(v_removed, 'activity_completion_log', v_n);
    delete from training.activity_completions where activity_id = any(v_alias);
    get diagnostics v_n = row_count;
    v_roster_n := v_roster_n + v_n;
    if v_n <> (v_work ->> 'completions')::int then
      perform training_load.session_undo_refuse('roster_work_changed', v_work::text);
    end if;
    v_removed := training_load.session_undo_add(v_removed, 'activity_completions', v_n);
    delete from training.activity_roster_requests where activity_id = any(v_alias);
    get diagnostics v_n = row_count;
    v_roster_n := v_roster_n + v_n;
    if v_n <> (v_work ->> 'requests')::int then
      perform training_load.session_undo_refuse('roster_work_changed', v_work::text);
    end if;
    v_removed := training_load.session_undo_add(v_removed, 'activity_roster_requests', v_n);
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
      -- v63: an estimate's provenance row goes before its value (it references it).
      delete from training_load.metric_value_estimates where occasion_id = any(v_occ);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'estimates_removed', v_n);
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
  if v_roster_n > 0 then
    v_roster_removed := jsonb_build_object(
      'import_written', jsonb_build_object('decisions', (v_work -> 'importWritten' ->> 'decisions')::int,
                                           'requests', (v_work -> 'importWritten' ->> 'requests')::int,
                                           'completions', (v_work -> 'importWritten' ->> 'completions')::int,
                                           'completion_log', (v_work -> 'importWritten' ->> 'completionLog')::int),
      'later', jsonb_build_object('decisions', (v_work -> 'laterWork' ->> 'decisions')::int,
                                  'requests', (v_work -> 'laterWork' ->> 'requests')::int,
                                  'completions', (v_work -> 'laterWork' ->> 'completions')::int,
                                  'completion_log', (v_work -> 'laterWork' ->> 'completionLog')::int),
      'later_list', v_work -> 'laterWork' -> 'list',
      'later_fingerprint', v_work -> 'laterWork' -> 'fingerprint',
      'confirmed_by', case when v_later_total > 0 then to_jsonb(p_actor) else 'null'::jsonb end);
  end if;

  -- 8. The deletion log (v21): one row, in this transaction, after the event is gone.
  insert into training_load.import_deletion_log
    (deleted_by_user_id, authorized_via, reason, event_id, source_system, source_connection_id, source_external_id,
     owner_team_id, occurred_date, reference_set_external_id, removed_counts, removed_total, roster_work_removed)
  values (p_actor, v_basis /* v76: derived above */, v_reason, v_event_id, v_scope ->> 'sourceSystem', (v_scope ->> 'connectionId')::uuid,
          v_scope ->> 'externalId', (v_scope ->> 'ownerTeamId')::uuid, (v_scope ->> 'occurredDate')::date,
          v_scope ->> 'referenceSetExternalId', v_removed, v_total, v_roster_removed)
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
  return query select false, v_event_id, v_log, v_removed, v_total, v_new, v_ids, v_roster_removed;
end;
$function$;

comment on function training_load.undo_imported_session(uuid, uuid, uuid, uuid, text, uuid, text) is
  'v76: the sanctioned undo of one imported GPEXE session, its roster work and estimates included, by whoever may import it (lock_gpexe_session_undo_right). See migrations_v2/202611171000_training_load_v76_undo_by_importer.sql.';
CREATE OR REPLACE FUNCTION training_load.validate_import_deletion_log_v60()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- v76 begin: the basis is derived again here, never taken from the row - a row naming platform_admin by a user whose right is a
  -- coach's grant is refused (the function re-takes the same shared locks, a no-op inside the undo).
  if training_load.lock_gpexe_session_undo_right(new.deleted_by_user_id, new.owner_team_id) is distinct from new.authorized_via then
    raise exception 'import_deletion_log: user % may not undo an imported session on that basis', new.deleted_by_user_id
      using errcode = 'insufficient_privilege';
  end if;
  -- v76 end
  if exists (select 1 from training_load.metric_events where id = new.event_id) then
    raise exception 'import_deletion_log: event % still exists — a log row records a removal made in the same transaction, not a plan', new.event_id;
  end if;
  if not training_load.session_undo_roster_log_ok(new.roster_work_removed, new.deleted_by_user_id) then
    raise exception 'import_deletion_log: roster_work_removed is not in its closed shape' using errcode = '23514';
  end if;
  return new;
end;
$function$;

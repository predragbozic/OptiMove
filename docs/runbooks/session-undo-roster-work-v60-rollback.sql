-- Rollback of migration v60 (the undo of an imported session is always possible, O1):
-- migrations_v2/202611091200_training_load_v60_session_undo_roster_work.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/session-undo-roster-work-v60.test.mjs:
-- apply -> rollback -> the v59 catalog exactly -> re-apply, every refusal below).
-- Before it is run anywhere real: a fresh restore-verified backup exists; the deployed commit no longer contains the v60 migration
-- file (otherwise the migrator applies v60 again at the next start); and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- It restores v57's 6-argument undo_imported_session and session_undo_scope, v25's four roster trigger functions and v21's deletion-log
-- insert guard (by the text of those migrations, checked by md5 afterwards), drops the v60 functions and the two columns, and removes
-- the v60 record. It changes no other row. It refuses, changing nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v60 is not recorded, or any later migrations_v2 migration is;
--   * the body in force of any v60 function is not v60's (by md5);
--   * any roster request has origin 'import' or any deletion-log row has roster_work_removed (the import flow wrote states, or an
--     undo removed roster work: the way back would lose that record, so v60 is forward-only from then on).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f session-undo-roster-work-v60-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v60 rollback refused: the migrator is running';
  end if;
end $$;

lock table training.activity_roster_requests, training_load.import_deletion_log, training_load.gpexe_session_undo_requests in access exclusive mode;

do $$
declare
  v60 constant text := 'migrations_v2/202611091200_training_load_v60_session_undo_roster_work.sql';
  expected constant text[][] := array[
    ['training_load', 'undo_imported_session', '9be6ca4eee78a9d26310206aad2b0335'],
    ['training_load', 'session_undo_scope', '514617da209da9d2703477ef5c4a69dd'],
    ['training_load', 'session_undo_roster_work', '1b6b9dae1db45b329ca24f522fd0a06d'],
    ['training', 'protect_activity_roster_request', '4549eaa47dc6c6ad34af9a2d548ff173'],
    ['training', 'check_activity_athlete_decision', 'cb038617f44d1e6028825d73f5048c64'],
    ['training', 'protect_activity_completion', '1bd5b84c90536e4a7802e2ed2c3e7229'],
    ['training', 'protect_activity_completion_log', '310479ead5bac4ba0ada834a6c20543c'],
    ['training_load', 'validate_import_deletion_log', '8bc1c58cee9d8a42b9d7bdec06978f5b'],
    ['training_load', 'import_deletion_log_roster_work_ok', '63ef21b28862101fa25979a90ee47202']];
  i int;
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v60) then
    raise exception 'v60 rollback refused: v60 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v60) then
    raise exception 'v60 rollback refused: later migrations are applied';
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2]) is distinct from expected[i][3] then
      raise exception 'v60 rollback refused: the body in force of %.% is not v60''s', expected[i][1], expected[i][2];
    end if;
  end loop;
  if exists (select 1 from training.activity_roster_requests where origin = 'import')
     or exists (select 1 from training_load.import_deletion_log where roster_work_removed is not null) then
    raise exception 'v60 rollback refused: import-written roster work or a removal of roster work is on record (forward-only)';
  end if;
end $$;

-- v57's functions back (the same text as migrations_v2/202611051000_training_load_v57_session_undo.sql).
drop function training_load.undo_imported_session(uuid, uuid, uuid, uuid, text, uuid, text);
create function training_load.undo_imported_session(
  p_actor uuid, p_team uuid, p_candidate uuid, p_request_key uuid, p_reason text, p_expected_event uuid default null
) returns table (
  replayed boolean, event_id uuid, deletion_log_id uuid, removed_counts jsonb, removed_total integer, new_candidate_id uuid,
  undone_candidate_ids uuid[]
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
    return query select true, v_req.event_id, v_req.deletion_log_id, v_req.removed_counts, v_req.removed_total, v_req.new_candidate_id, v_req.undone_candidate_ids;
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
  v_work := v_scope -> 'rosterWork';
  if (v_work ->> 'decisions')::int + (v_work ->> 'requests')::int + (v_work ->> 'completions')::int + (v_work ->> 'completionLog')::int > 0 then
    perform training_load.session_undo_refuse('roster_decisions_exist', v_work::text);
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
  insert into training_load.import_deletion_log
    (deleted_by_user_id, authorized_via, reason, event_id, source_system, source_connection_id, source_external_id,
     owner_team_id, occurred_date, reference_set_external_id, removed_counts, removed_total)
  values (p_actor, 'platform_admin', v_reason, v_event_id, v_scope ->> 'sourceSystem', (v_scope ->> 'connectionId')::uuid,
          v_scope ->> 'externalId', (v_scope ->> 'ownerTeamId')::uuid, (v_scope ->> 'occurredDate')::date,
          v_scope ->> 'referenceSetExternalId', v_removed, v_total)
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
  return query select false, v_event_id, v_log, v_removed, v_total, v_new, v_ids;
end;
$$ language plpgsql;

comment on function training_load.undo_imported_session(uuid, uuid, uuid, uuid, text, uuid) is
  'v57: the sanctioned undo of one imported GPEXE session (platform admin only in this version). See migrations_v2/202611051000_training_load_v57_session_undo.sql.';

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
  v_work record;
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
  select (select count(*)::int from training.activity_athlete_decisions where activity_id = any(v_alias)) as decisions,
         (select count(*)::int from training.activity_roster_requests where activity_id = any(v_alias)) as requests,
         (select count(*)::int from training.activity_completions where activity_id = any(v_alias)) as completions,
         (select count(*)::int from training.activity_completion_log where activity_id = any(v_alias)) as completion_log
    into v_work;
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
    'rosterWork', jsonb_build_object('decisions', v_work.decisions, 'requests', v_work.requests,
                                     'completions', v_work.completions, 'completionLog', v_work.completion_log));
end;
-- Volatile on purpose: every statement of the body takes its own snapshot, so the second look (after the activities are
-- locked) sees a link committed while the lock was waited for.
$$ language plpgsql;

drop function training_load.session_undo_roster_work(uuid[]);

-- v25's four trigger functions and v21's insert guard back.
create or replace function training.protect_activity_roster_request() returns trigger as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'activity_roster_requests is append-only (% refused)', tg_op;
  end if;
  perform training.assert_canonical_team_activity(new.activity_id, null, 'activity_roster_requests');
  return new;
end;
$$ language plpgsql;

create or replace function training.check_activity_athlete_decision() returns trigger as $$
begin
  if tg_op = 'DELETE' then
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
  if tg_op <> 'INSERT' then
    raise exception 'activity_completion_log is append-only (% refused)', tg_op;
  end if;
  -- A log row belongs to the canonical team session it describes, like
  -- every other row that points at an activity.
  perform training.assert_canonical_team_activity(new.activity_id, null, 'activity_completion_log');
  return new;
end;
$$ language plpgsql;

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
  if exists (select 1 from training_load.metric_events where id = new.event_id) then
    raise exception 'import_deletion_log: event % still exists — a log row records a removal made in the same transaction, not a plan', new.event_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop function training_load.import_deletion_log_roster_work_ok(jsonb, uuid);

alter table training.activity_roster_requests drop column origin;
alter table training_load.import_deletion_log drop column roster_work_removed;

delete from public.schema_migrations where migration_name = 'migrations_v2/202611091200_training_load_v60_session_undo_roster_work.sql';

-- Post-gate: the original bodies are in force and no v60 object is left.
do $$
declare
  expected constant text[][] := array[
    ['training_load', 'undo_imported_session', 'ae5aa129708a03a602b9cdc596e1e11a'],
    ['training_load', 'session_undo_scope', 'f605cb502a36a4d8e372373fe1e2207a'],
    ['training', 'protect_activity_roster_request', 'd653da02d80b0e844105c606017917c4'],
    ['training', 'check_activity_athlete_decision', 'd911a55ffeb641ab296488f7faa2569f'],
    ['training', 'protect_activity_completion', '4ad9534602ec7cae22d2e4560b9bdeed'],
    ['training', 'protect_activity_completion_log', '2cd36fa02adf8af1c41436225459d0ad'],
    ['training_load', 'validate_import_deletion_log', 'ccd1157ee00901c66d3bf4c031763bf7']];
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2]) is distinct from expected[i][3] then
      raise exception 'v60 rollback failed: the body of %.% is not the original', expected[i][1], expected[i][2];
    end if;
  end loop;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname, p.proname) in (('training_load', 'session_undo_roster_work'), ('training_load', 'import_deletion_log_roster_work_ok')))
     or (select pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'training_load' and p.proname = 'undo_imported_session') <> 6
     or exists (select 1 from information_schema.columns where (table_schema, table_name, column_name) in
                (('training', 'activity_roster_requests', 'origin'), ('training_load', 'import_deletion_log', 'roster_work_removed'))) then
    raise exception 'v60 rollback failed: a v60 object is still there';
  end if;
end $$;
commit;

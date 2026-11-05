-- Training Load v57 - the in-app undo of an imported GPEXE session (U5; J19-U5 sub-contract, plan docs/ai/u5-undo-plan.md).
--
-- Owner decisions (2026-11-05, J19-U5 section 9): option A, a sanctioned database function; the first version is for an
-- active platform admin only; the candidate comes back as a fresh pending candidate; coach roster decisions refuse the
-- undo; one session at a time; the first production undo is owner-run.
--
-- What this migration adds (functions, one table, two columns on gpexe_import_candidates; no row of any table changes):
--   * training_load.undo_imported_session(...) removes exactly what backend/scripts/gpexe-undo-imported-session.mjs removes,
--     in the same order, WITHOUT disabling any trigger, writes one import_deletion_log row (v21) and one request row, marks
--     the imported candidate undone and, when its snapshot is still available, writes a fresh pending candidate of the same
--     content - all in the caller's transaction.
--   * The five protections the CLI switches off table by table (v13 metric_values_immutable, v20
--     metric_event_source_bindings_no_delete, v25 activity_source_observations_append_only, v34
--     metric_value_source_provenance_append_only) each get ONE exception, true only for a DELETE inside the function's own
--     transaction: the function sets the transaction-local marker optimove.session_undo_tx = txid_current(), the triggers
--     compare it with the running transaction (the v35 / v56 pattern). A session-level SET holds another transaction id and
--     never satisfies it; every other statement is refused as before. The triggers are re-pointed to new functions that
--     copy the originals' refusals byte for byte; the originals stay in place (the rollback re-points them back).
--   * gpexe_import_candidates gains import_undone_at / import_undone_request_id (set together, once, only by the function,
--     only on an imported row); the unique key "one candidate per team, session and content" becomes partial (live rows only),
--     so the fresh pending candidate can exist beside the undone one. The imported row stays 'imported' (v22/v23 finality).
--   * training_load.gpexe_session_undo_requests: the idempotency / outcome record of an undo (append-only).
--
-- Lock order of the function (users first, the rule of PR #346 / LO-1; the importer's own order after the team lock):
--   acting user row (FOR SHARE) -> platform-admin role row (FOR SHARE) -> the team's import lock (the importer's advisory
--   key) -> the request record (a replay answers before any further lock) -> the candidate (FOR UPDATE) -> the event
--   (FOR UPDATE) -> its activities (by id, FOR UPDATE). A bounded wait is the caller's lock_timeout (55P03).
--
-- Refusals are SQLSTATE 55000 with the message 'session_undo:<code>'; a missing or revoked right is 42501.
-- Rollback: docs/runbooks/session-undo-v57-rollback.sql. Runbook: docs/runbooks/session-undo-v57.md.

-- ---------------------------------------------------------------------------
-- 0. The bodies this migration copies must be the ones in force
-- ---------------------------------------------------------------------------
do $$
declare
  expected constant text[][] := array[
    ['training_load', 'forbid_update_delete', '2a0b9cc2529c6fd401840b20ec86cf03', 'v10'],
    ['training_load', 'source_metric_append_only', 'ce27068e9a81b17f613eb038f58daf91', 'v34'],
    ['training_load', 'forbid_event_source_binding_delete', '0831dafc47b1b8c7609ab96d759f1834', 'v20'],
    ['training_load', 'protect_gpexe_import_candidate', '7d8a5d443864d8fa05195db752906f29', 'v23'],
    ['training', 'protect_activity_source_observation', 'b9d2efb9eebb71138286dcc31f46e9c6', 'v25']];
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2])
       is distinct from expected[i][3] then
      raise exception 'v57 refused: the body in force of %.% is not %''s', expected[i][1], expected[i][2], expected[i][4] using errcode = '23514';
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The marker and the refusal helper
-- ---------------------------------------------------------------------------
create function training_load.session_undo_marker_ok() returns boolean as $$
  select coalesce(current_setting('optimove.session_undo_tx', true) = txid_current()::text, false);
$$ language sql stable;

create function training_load.session_undo_refuse(p_code text, p_detail text default null) returns void as $$
begin
  raise exception 'session_undo:%', p_code using errcode = '55000', detail = coalesce(p_detail, '');
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 2. The request record
-- ---------------------------------------------------------------------------
create table training_load.gpexe_session_undo_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by_user_id uuid not null references public.users(id) on delete restrict,
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  owner_team_id uuid not null references public.teams(id) on delete restrict,
  candidate_id uuid not null unique references training_load.gpexe_import_candidates(id) on delete restrict,
  -- The removed event is gone, so it is referenced by value only (as in the deletion log).
  event_id uuid not null,
  deletion_log_id uuid not null unique references training_load.import_deletion_log(id) on delete restrict,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  removed_counts jsonb not null check (jsonb_typeof(removed_counts) = 'object' and removed_counts <> '{}'::jsonb),
  removed_total integer not null check (removed_total > 0),
  new_candidate_id uuid references training_load.gpexe_import_candidates(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (requested_by_user_id, request_key)
);
create index gpexe_session_undo_requests_team_idx on training_load.gpexe_session_undo_requests (owner_team_id, created_at desc);
create index gpexe_session_undo_requests_new_candidate_idx on training_load.gpexe_session_undo_requests (new_candidate_id) where new_candidate_id is not null;

create function training_load.session_undo_request_guard() returns trigger as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'gpexe_session_undo_requests is append-only (% refused)', tg_op using errcode = '23514';
  end if;
  if not training_load.session_undo_marker_ok() then
    raise exception 'gpexe_session_undo_requests is written only by undo_imported_session' using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_session_undo_requests_guard
  before insert or update or delete on training_load.gpexe_session_undo_requests
  for each row execute function training_load.session_undo_request_guard();
create trigger gpexe_session_undo_requests_no_truncate
  before truncate on training_load.gpexe_session_undo_requests
  for each statement execute function training_load.session_undo_request_guard();

-- ---------------------------------------------------------------------------
-- 3. The candidate: undone columns, the partial key, the guard
-- ---------------------------------------------------------------------------
alter table training_load.gpexe_import_candidates
  add column import_undone_at timestamptz,
  add column import_undone_request_id uuid;

alter table training_load.gpexe_import_candidates
  add constraint gpexe_import_candidates_import_undone_request_fkey
    foreign key (import_undone_request_id) references training_load.gpexe_session_undo_requests(id)
    on delete restrict deferrable initially deferred,
  add constraint gpexe_import_candidates_import_undone_together
    check ((import_undone_at is null) = (import_undone_request_id is null)),
  add constraint gpexe_import_candidates_import_undone_imported
    check (import_undone_at is null or status = 'imported');

create index gpexe_import_candidates_import_undone_request_idx
  on training_load.gpexe_import_candidates (import_undone_request_id) where import_undone_request_id is not null;

-- One candidate per team, session and content among the LIVE rows: an undone imported row keeps its content hash as history.
alter table training_load.gpexe_import_candidates
  drop constraint gpexe_import_candidates_owner_team_id_gpexe_team_session_id_key;
create unique index gpexe_import_candidates_live_content_key
  on training_load.gpexe_import_candidates (owner_team_id, gpexe_team_session_id, bundle_hash)
  where import_undone_at is null;

-- The v23 guard, unchanged except for the undone columns.
create function training_load.protect_gpexe_import_candidate_v57() returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'imported' then
      raise exception 'gpexe_import_candidates: a candidate is never inserted as imported; only its approval imports it';
    end if;
    if new.import_undone_at is not null or new.import_undone_request_id is not null then
      raise exception 'gpexe_import_candidates: a candidate is never inserted as undone';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status = 'imported' then
      raise exception 'gpexe_import_candidates: candidate % was imported; its record is never deleted', old.id;
    end if;
    return old;
  end if;
  if new.owner_team_id is distinct from old.owner_team_id
     or new.gpexe_team_session_id is distinct from old.gpexe_team_session_id
     or new.bundle_hash is distinct from old.bundle_hash
     or new.first_seen_check_id is distinct from old.first_seen_check_id
     or new.first_seen_at is distinct from old.first_seen_at then
    raise exception 'gpexe_import_candidates: the team, session, content and first sighting of candidate % never change', old.id;
  end if;
  if old.import_undone_at is not null then
    if new.import_undone_at is distinct from old.import_undone_at
       or new.import_undone_request_id is distinct from old.import_undone_request_id then
      raise exception 'gpexe_import_candidates: the undo of candidate % is final', old.id;
    end if;
  elsif new.import_undone_at is not null or new.import_undone_request_id is not null then
    if old.status is distinct from 'imported' then
      raise exception 'gpexe_import_candidates: only an imported candidate can be undone (candidate % is %)', old.id, old.status;
    end if;
    if not training_load.session_undo_marker_ok() then
      raise exception 'gpexe_import_candidates: a candidate is marked undone only by undo_imported_session' using errcode = '42501';
    end if;
  end if;
  if old.status = 'imported' and (new.status is distinct from old.status or new.imported_at is distinct from old.imported_at) then
    raise exception 'gpexe_import_candidates: candidate % was imported; its status and import time are final', old.id;
  end if;
  if new.status = 'imported' and old.status is distinct from 'imported' then
    if old.status <> 'pending' then
      raise exception 'gpexe_import_candidates: candidate % is %, only a pending candidate can be imported', old.id, old.status;
    end if;
    if not exists (select 1 from training_load.gpexe_import_approvals a where a.candidate_id = new.id) then
      raise exception 'gpexe_import_candidates: candidate % has no recorded approval', old.id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger gpexe_import_candidates_protect on training_load.gpexe_import_candidates;
create trigger gpexe_import_candidates_protect
  before update or delete on training_load.gpexe_import_candidates
  for each row execute function training_load.protect_gpexe_import_candidate_v57();
drop trigger gpexe_import_candidates_protect_insert on training_load.gpexe_import_candidates;
create trigger gpexe_import_candidates_protect_insert
  before insert on training_load.gpexe_import_candidates
  for each row execute function training_load.protect_gpexe_import_candidate_v57();

-- ---------------------------------------------------------------------------
-- 4. The four protections, each with its one exception (DELETE inside the function's transaction)
-- ---------------------------------------------------------------------------
create function training_load.forbid_update_delete_unless_session_undo() returns trigger as $$
begin
  if tg_op = 'DELETE' and training_load.session_undo_marker_ok() then
    return old;
  end if;
  raise exception 'immutable row: % on %.% (id=%) is not permitted', tg_op, tg_table_schema, tg_table_name, coalesce(old.id::text, 'n/a');
end;
$$ language plpgsql;

create function training_load.forbid_event_source_binding_delete_unless_session_undo() returns trigger as $$
begin
  if training_load.session_undo_marker_ok() then
    return old;
  end if;
  raise exception 'metric_event_source_bindings rows are immutable and cannot be deleted (event_id=%)', old.event_id;
end;
$$ language plpgsql;

create function training_load.source_metric_append_only_unless_session_undo() returns trigger as $$
begin
  if tg_op = 'DELETE' and training_load.session_undo_marker_ok() then
    return old;
  end if;
  raise exception '%.% is append-only; % refused', tg_table_schema, tg_table_name, tg_op using errcode = '23514';
end;
$$ language plpgsql;

create function training.protect_activity_source_observation_v57() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    if training_load.session_undo_marker_ok() then
      return old;
    end if;
    raise exception 'activity_source_observations: observation % is removed only by the undo of its import', old.id;
  end if;
  if old.resolved_at is not null or new.resolved_at is null
     or new.id is distinct from old.id or new.activity_id is distinct from old.activity_id
     or new.athlete_id is distinct from old.athlete_id or new.source_connection_id is distinct from old.source_connection_id
     or new.kind is distinct from old.kind or new.reason_code is distinct from old.reason_code
     or new.observed_at is distinct from old.observed_at or new.adapter_ref is distinct from old.adapter_ref then
    raise exception 'activity_source_observations: an observation is only resolved, once (observation %)', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger metric_values_immutable on training_load.metric_values;
create trigger metric_values_immutable
  before update or delete on training_load.metric_values
  for each row execute function training_load.forbid_update_delete_unless_session_undo();

drop trigger metric_event_source_bindings_no_delete on training_load.metric_event_source_bindings;
create trigger metric_event_source_bindings_no_delete
  before delete on training_load.metric_event_source_bindings
  for each row execute function training_load.forbid_event_source_binding_delete_unless_session_undo();

drop trigger metric_value_source_provenance_append_only on training_load.metric_value_source_provenance;
create trigger metric_value_source_provenance_append_only
  before update or delete on training_load.metric_value_source_provenance
  for each row execute function training_load.source_metric_append_only_unless_session_undo();

drop trigger activity_source_observations_append_only on training.activity_source_observations;
create trigger activity_source_observations_append_only
  before update or delete on training.activity_source_observations
  for each row execute function training.protect_activity_source_observation_v57();

-- ---------------------------------------------------------------------------
-- 5. The scope of one event (read-only; the CLI's collectScope, in SQL)
-- ---------------------------------------------------------------------------
create function training_load.session_undo_scope(p_event uuid) returns jsonb as $$
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

-- ---------------------------------------------------------------------------
-- 6. The sanctioned undo
-- ---------------------------------------------------------------------------
create function training_load.session_undo_add(p_counts jsonb, p_label text, p_n integer) returns jsonb as $$
  select p_counts || jsonb_build_object(p_label, coalesce((p_counts ->> p_label)::int, 0) + p_n);
$$ language sql immutable;

create function training_load.undo_imported_session(
  p_actor uuid, p_team uuid, p_candidate uuid, p_request_key uuid, p_reason text, p_expected_event uuid default null
) returns table (
  replayed boolean, event_id uuid, deletion_log_id uuid, removed_counts jsonb, removed_total integer, new_candidate_id uuid
) as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_hash text;
  v_req record;
  v_cand record;
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

  -- 2. The team's import lock: the importer's own key, so an import and an undo of the same team wait for each other.
  perform pg_advisory_xact_lock(hashtextextended('gpexe-import-team:' || lower(p_team::text), 21));

  -- 3. A replay answers the saved outcome before any further lock.
  select * into v_req from training_load.gpexe_session_undo_requests q
   where q.requested_by_user_id = p_actor and q.request_key = p_request_key;
  if found then
    if v_req.request_hash <> v_hash then
      perform training_load.session_undo_refuse('request_key_reused');
    end if;
    return query select true, v_req.event_id, v_req.deletion_log_id, v_req.removed_counts, v_req.removed_total, v_req.new_candidate_id;
    return;
  end if;

  -- 4. The candidate.
  select * into v_cand from training_load.gpexe_import_candidates c where c.id = p_candidate and c.owner_team_id = p_team for update;
  if not found then
    perform training_load.session_undo_refuse('candidate_not_found');
  end if;
  if v_cand.status <> 'imported' then
    perform training_load.session_undo_refuse('candidate_not_imported');
  end if;
  if v_cand.import_undone_at is not null then
    perform training_load.session_undo_refuse('already_undone');
  end if;

  -- 5. The event the approval wrote, locked, and the identity of what is about to be removed.
  select a.metric_event_id into v_event_id from training_load.gpexe_import_approvals a where a.candidate_id = p_candidate;
  if not found then
    perform training_load.session_undo_refuse('approval_missing');
  end if;
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
  if cardinality(v_act) > 0 then
    perform 1 from training.activities a where a.id = any(v_act) order by a.id for update;
    v_scope := training_load.session_undo_scope(v_event_id);
    v_act := coalesce(array(select jsonb_array_elements_text(v_scope -> 'activityIds')::uuid), '{}');
  end if;
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

  -- 9. The candidate is marked undone (its request is checked at the end of this call), then, when its snapshot is still
  --    available and the check that last saw it succeeded, a fresh pending candidate of the same content is written.
  update training_load.gpexe_import_candidates
     set import_undone_at = clock_timestamp(), import_undone_request_id = v_req_id
   where id = p_candidate;
  select k.status into v_last_status from training_load.gpexe_import_checks k
   where k.id = v_cand.last_seen_check_id and k.owner_team_id = p_team;
  if v_cand.raw_bundle is not null and v_cand.raw_purged_at is null and v_cand.raw_expires_at > now()
     and v_last_status = 'succeeded' then
    v_new := gen_random_uuid();
    insert into training_load.gpexe_import_candidates
      (id, owner_team_id, gpexe_team_session_id, session_started_at, session_label, bundle_hash, raw_bundle, raw_expires_at,
       status, first_seen_check_id, last_seen_check_id, first_seen_at, last_seen_at, drill_parameter_effect)
    values (v_new, p_team, v_cand.gpexe_team_session_id, v_cand.session_started_at, v_cand.session_label, v_cand.bundle_hash,
            v_cand.raw_bundle, least(v_cand.raw_expires_at, now() + interval '30 days'), 'pending',
            v_cand.first_seen_check_id, v_cand.last_seen_check_id, v_cand.first_seen_at, now(), v_cand.drill_parameter_effect);
  end if;

  -- 10. The request record, then the deferred link is checked here, not at the COMMIT.
  insert into training_load.gpexe_session_undo_requests
    (id, requested_by_user_id, request_key, request_hash, owner_team_id, candidate_id, event_id, deletion_log_id, reason,
     removed_counts, removed_total, new_candidate_id)
  values (v_req_id, p_actor, p_request_key, v_hash, p_team, p_candidate, v_event_id, v_log, v_reason, v_removed, v_total, v_new);
  set constraints training_load.gpexe_import_candidates_import_undone_request_fkey immediate;
  -- The marker covers this call only.
  perform set_config('optimove.session_undo_tx', '', true);
  return query select false, v_event_id, v_log, v_removed, v_total, v_new;
end;
$$ language plpgsql;

comment on function training_load.undo_imported_session(uuid, uuid, uuid, uuid, text, uuid) is
  'v57: the sanctioned undo of one imported GPEXE session (platform admin only in this version). See migrations_v2/202611051000_training_load_v57_session_undo.sql.';

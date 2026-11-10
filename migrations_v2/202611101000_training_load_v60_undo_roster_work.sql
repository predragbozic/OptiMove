-- Training Load v60 - the undo of an imported session also removes its roster work (O1 of J20, the extended variant b;
-- docs/ai/j20-session-review-contract.md section 5.3).
--
-- Owner decision O1 (2026-11-09): undo and re-import must always be possible. The attendance states J20's flow wrote at the
-- import are removed and listed; LATER roster work (the Roster tab, a colleague's change) does not block the undo, but it
-- is removed only after an explicit confirmation of exactly the list the administrator saw; everything removed goes to the
-- deletion log. Who may undo is unchanged (an active platform admin, J19-U5).
--
-- What this migration changes (no row of any table changes):
--   1. training.activity_roster_requests gains `origin` ('roster' | 'import', constant DEFAULT 'roster', so no rewrite).
--   2. Its guard: a request with origin 'import' is accepted only when an approval of the same user imported this session
--      into an activity of the request's alias set, before the request (23514 otherwise). The generic roster routes never
--      name the column, so they always write 'roster'. The origin only tells the two warnings apart; it is not a condition
--      of the undo.
--   3. The four roster tables (decisions, completion log, completions, requests) get ONE exception each: a DELETE inside
--      undo_imported_session's own transaction (v57's marker, session_undo_marker_ok()). UPDATE stays refused as before,
--      TRUNCATE stays refused by the unchanged v25 statement triggers. The triggers are re-pointed to new functions that copy
--      the originals' refusals byte for byte; the originals stay in place (the rollback re-points them back).
--   4. session_undo_scope splits rosterWork into importWritten and laterWork. A row is LATER work unless the request that
--      wrote it has origin 'import': a decision by its request, a request by itself, a completion log row by its request
--      (a log row without a request - an automatic needs_review - is later work; it can only exist after a later roster
--      complete, which is itself later work), a completion row when any of its log rows is later work. laterWork carries
--      changes (the coach's later acts: decisions plus complete / reopen requests), a list (at most 60 of those acts:
--      athlete, kind, reason_code, by, at) and a fingerprint (sha256 over every later row's identity, not only the listed
--      ones). An import-origin request may only be a decide or decide_bulk (J20-C writes states, nothing else).
--   5. undo_imported_session (DROP + CREATE, signature with one more parameter, one more result column):
--        * importWritten never blocks;
--        * the confirmation IS p_later_roster_fingerprint (not null), so a confirmation without a fingerprint cannot exist;
--        * laterWork > 0 without a fingerprint -> 55000 session_undo:roster_work_needs_confirmation (detail: the
--          rosterWork object), nothing removed;
--        * a fingerprint is compared with the one computed under the team's import lock (every roster command takes that
--          lock too): another list -> session_undo:roster_work_changed; a fingerprint sent while there is no later work at
--          all is roster_work_changed as well (the list it confirmed is gone);
--        * the roster rows of the alias set are removed first (decisions -> completion log -> completions -> requests), and
--          the number removed must be the number the scope counted (roster_work_changed otherwise);
--        * removed_counts carries the four roster tables; the deletion log row carries roster_work_removed.
--      The request hash is v57's when nothing is confirmed, so a v57 request replays unchanged.
--   6. training_load.import_deletion_log gains roster_work_removed jsonb (NULL when no roster row was removed). The insert
--      guard keeps v21's checks and checks its closed shape: counts, a list of at most 60 entries with only
--      athlete / kind / reason_code / by / at (never a note), the fingerprint, and confirmed_by = deleted_by_user_id
--      whenever later work was removed. The table stays append-only (v21's triggers are unchanged).
--
-- Lock order: unchanged from v57 (users -> platform-admin role -> the team's import lock -> request record -> candidates ->
-- event -> activities). A roster command takes its decider rows FOR SHARE, then the same team import lock, so an undo and
-- a roster command of the same team wait for each other in either order; no lock is added.
--
-- Rollback: docs/runbooks/undo-roster-work-v60-rollback.sql (restores v57's function and the original triggers; refuses
-- once an import-origin request or a deletion log row with roster work exists, or a later migration is recorded).
-- Runbook: docs/runbooks/undo-roster-work-v60.md.

-- ---------------------------------------------------------------------------
-- 0. The bodies this migration replaces or copies must be the ones in force
-- ---------------------------------------------------------------------------
do $$
declare
  expected constant text[][] := array[
    ['training_load', 'undo_imported_session', 'ae5aa129708a03a602b9cdc596e1e11a', 'v57'],
    ['training_load', 'session_undo_scope', 'f605cb502a36a4d8e372373fe1e2207a', 'v57'],
    ['training_load', 'session_undo_marker_ok', '393c18c8b7228793fd47a0122d63cf02', 'v57'],
    ['training_load', 'validate_import_deletion_log', 'ccd1157ee00901c66d3bf4c031763bf7', 'v21'],
    ['training', 'protect_activity_roster_request', 'd653da02d80b0e844105c606017917c4', 'v25'],
    ['training', 'check_activity_athlete_decision', 'd911a55ffeb641ab296488f7faa2569f', 'v25'],
    ['training', 'protect_activity_completion', '4ad9534602ec7cae22d2e4560b9bdeed', 'v25'],
    ['training', 'protect_activity_completion_log', '2cd36fa02adf8af1c41436225459d0ad', 'v25']];
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2])
       is distinct from expected[i][3] then
      raise exception 'v60 refused: the body in force of %.% is not %''s', expected[i][1], expected[i][2], expected[i][4] using errcode = '23514';
    end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'undo_imported_session') <> 1 then
    raise exception 'v60 refused: undo_imported_session must exist exactly once' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The origin of a roster request
-- ---------------------------------------------------------------------------
alter table training.activity_roster_requests
  add column origin text not null default 'roster' constraint activity_roster_requests_origin_check check (origin in ('roster', 'import'));

-- ---------------------------------------------------------------------------
-- 2 and 3. The roster tables' guards: the origin rule and the one DELETE exception
-- ---------------------------------------------------------------------------
create function training.protect_activity_roster_request_v60() returns trigger as $$
declare
  v_team uuid;
begin
  if tg_op = 'DELETE' and training_load.session_undo_marker_ok() then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'activity_roster_requests is append-only (% refused)', tg_op;
  end if;
  perform training.assert_canonical_team_activity(new.activity_id, null, 'activity_roster_requests');
  if new.origin = 'import' then
    if new.operation not in ('decide', 'decide_bulk') then
      raise exception 'activity_roster_requests: origin import is only a decide or decide_bulk' using errcode = '23514';
    end if;
    select owner_team_id into v_team from training.activities where id = new.activity_id;
    if not exists (
      select 1
        from training_load.gpexe_import_approvals a
       where a.owner_team_id = v_team
         and a.approved_by_user_id = new.performed_by_user_id
         and a.approved_at <= new.created_at
         and exists (
           select 1
             from training.activity_alias_ids(training.resolve_canonical_activity_id(new.activity_id)) s
            where exists (select 1 from training.activity_metric_event_links l
                           where l.activity_id = s.activity_id and l.metric_event_id = a.metric_event_id)
               or exists (select 1 from training.activity_participants ap
                            join training.activity_participant_metric_participant_links pl on pl.activity_participant_id = ap.id
                            join training_load.metric_event_participants p on p.id = pl.metric_event_participant_id
                           where ap.activity_id = s.activity_id and p.event_id = a.metric_event_id))
    ) then
      raise exception 'activity_roster_requests: origin import needs an approval of this session by the same user'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create function training.check_activity_athlete_decision_v60() returns trigger as $$
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

create function training.protect_activity_completion_v60() returns trigger as $$
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

create function training.protect_activity_completion_log_v60() returns trigger as $$
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

drop trigger activity_roster_requests_protect on training.activity_roster_requests;
create trigger activity_roster_requests_protect
  before insert or update or delete on training.activity_roster_requests
  for each row execute function training.protect_activity_roster_request_v60();
drop trigger activity_athlete_decisions_check on training.activity_athlete_decisions;
create trigger activity_athlete_decisions_check
  before insert or update or delete on training.activity_athlete_decisions
  for each row execute function training.check_activity_athlete_decision_v60();
drop trigger activity_completions_protect on training.activity_completions;
create trigger activity_completions_protect
  before insert or update or delete on training.activity_completions
  for each row execute function training.protect_activity_completion_v60();
drop trigger activity_completion_log_protect on training.activity_completion_log;
create trigger activity_completion_log_protect
  before insert or update or delete on training.activity_completion_log
  for each row execute function training.protect_activity_completion_log_v60();

-- ---------------------------------------------------------------------------
-- 4. The roster work of an alias set: what the import wrote, what came later
-- ---------------------------------------------------------------------------
create function training_load.session_undo_roster_work(p_alias uuid[]) returns jsonb as $$
declare
  v_imp record;
  v_later record;
  v_list jsonb;
  v_fp text;
begin
  with req as (
    select id, origin, operation, performed_by_user_id, created_at from training.activity_roster_requests where activity_id = any(p_alias)
  ), dec as (
    select d.id, d.athlete_id, d.decision_kind, d.reason_key, d.decided_by_user_id, d.decided_at,
           coalesce(r.origin, 'roster') <> 'import' as later
      from training.activity_athlete_decisions d left join req r on r.id = d.request_id
     where d.activity_id = any(p_alias)
  ), lg as (
    select l.id, l.activity_id, coalesce(r.origin, 'roster') <> 'import' as later
      from training.activity_completion_log l left join req r on r.id = l.request_id
     where l.activity_id = any(p_alias)
  ), comp as (
    select c.activity_id, c.revision, exists (select 1 from lg where lg.activity_id = c.activity_id and lg.later) as later
      from training.activity_completions c where c.activity_id = any(p_alias)
  )
  select (select count(*) filter (where not later) from dec)::int as d_imp, (select count(*) filter (where later) from dec)::int as d_later,
         (select count(*) filter (where origin <> 'import' and operation in ('complete', 'reopen')) from req)::int as acts_later,
         (select count(*) filter (where origin = 'import') from req)::int as r_imp, (select count(*) filter (where origin <> 'import') from req)::int as r_later,
         (select count(*) filter (where not later) from comp)::int as c_imp, (select count(*) filter (where later) from comp)::int as c_later,
         (select count(*) filter (where not later) from lg)::int as l_imp, (select count(*) filter (where later) from lg)::int as l_later,
         (select string_agg(x, ',' order by x) from (
            select 'd:' || id::text as x from dec where later
            union all select 'r:' || id::text from req where origin <> 'import'
            union all select 'l:' || id::text from lg where later
            union all select 'c:' || activity_id::text || ':' || revision::text from comp where later) ids) as ids,
         (select coalesce(jsonb_agg(item order by at, k), '[]'::jsonb) from (
            select * from (
              select jsonb_build_object('athlete', athlete_id, 'kind', decision_kind, 'reason_code', reason_key,
                                        'by', decided_by_user_id, 'at', decided_at) as item, decided_at as at, id::text as k
                from dec where later
              union all
              select jsonb_build_object('athlete', null, 'kind', operation, 'reason_code', null,
                                        'by', performed_by_user_id, 'at', created_at), created_at, id::text
                from req where origin <> 'import' and operation in ('complete', 'reopen')
            ) all_items order by at, k limit 60) items) as list
    into v_later;
  v_fp := case when v_later.ids is null then null else encode(sha256(convert_to(v_later.ids, 'UTF8')), 'hex') end;
  return jsonb_build_object(
    -- v57's totals, kept for its readers.
    'decisions', v_later.d_imp + v_later.d_later, 'requests', v_later.r_imp + v_later.r_later,
    'completions', v_later.c_imp + v_later.c_later, 'completionLog', v_later.l_imp + v_later.l_later,
    'importWritten', jsonb_build_object('decisions', v_later.d_imp, 'requests', v_later.r_imp,
                                        'completions', v_later.c_imp, 'completionLog', v_later.l_imp),
    'laterWork', jsonb_build_object('decisions', v_later.d_later, 'requests', v_later.r_later,
                                    'completions', v_later.c_later, 'completionLog', v_later.l_later,
                                    'changes', v_later.d_later + v_later.acts_later,
                                    'list', v_later.list, 'fingerprint', v_fp));
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 6. The deletion log: the roster work it removed, in a closed shape
-- ---------------------------------------------------------------------------
alter table training_load.import_deletion_log add column roster_work_removed jsonb;

create function training_load.session_undo_roster_log_ok(p jsonb, p_deleted_by uuid) returns boolean as $$
declare
  v_counts constant text[] := array['completion_log', 'completions', 'decisions', 'requests'];
  v_part text;
  v_later_sum integer := 0;
  v_all_sum integer := 0;
  v_item jsonb;
begin
  if p is null then
    return true;
  end if;
  if jsonb_typeof(p) <> 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(p) k)
        is distinct from array['confirmed_by', 'import_written', 'later', 'later_fingerprint', 'later_list'] then
    return false;
  end if;
  foreach v_part in array array['import_written', 'later'] loop
    if jsonb_typeof(p -> v_part) <> 'object'
       or (select array_agg(k order by k) from jsonb_object_keys(p -> v_part) k) is distinct from v_counts
       or exists (select 1 from jsonb_each(p -> v_part) e where jsonb_typeof(e.value) <> 'number' or e.value::text !~ '^(0|[1-9][0-9]{0,8})$') then
      return false;
    end if;
    v_all_sum := v_all_sum + (select sum(e.value::text::int) from jsonb_each(p -> v_part) e);
  end loop;
  v_later_sum := (select sum(e.value::text::int) from jsonb_each(p -> 'later') e);
  if v_all_sum = 0 then
    return false;
  end if;
  if jsonb_typeof(p -> 'later_list') <> 'array' or jsonb_array_length(p -> 'later_list') > 60
     or (v_later_sum = 0 and jsonb_array_length(p -> 'later_list') > 0) then
    return false;
  end if;
  for v_item in select value from jsonb_array_elements(p -> 'later_list') loop
    if jsonb_typeof(v_item) <> 'object'
       or (select array_agg(k order by k) from jsonb_object_keys(v_item) k) is distinct from array['at', 'athlete', 'by', 'kind', 'reason_code']
       or not (jsonb_typeof(v_item -> 'athlete') = 'null'
               or (jsonb_typeof(v_item -> 'athlete') = 'string' and v_item ->> 'athlete' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
       or jsonb_typeof(v_item -> 'kind') is distinct from 'string'
       or (v_item ->> 'kind') not in ('did_not_participate', 'participated_no_values', 'manual_values', 'estimated', 'cleared', 'complete', 'reopen')
       or not (jsonb_typeof(v_item -> 'reason_code') = 'null'
               or (jsonb_typeof(v_item -> 'reason_code') = 'string' and v_item ->> 'reason_code' ~ '^[a-z][a-z0-9_]{1,40}$'))
       or jsonb_typeof(v_item -> 'by') is distinct from 'string'
       or v_item ->> 'by' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_item -> 'at') is distinct from 'string'
       or v_item ->> 'at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?([+-][0-9]{2}(:[0-9]{2})?|Z)$' then
      return false;
    end if;
  end loop;
  if v_later_sum > 0 then
    return jsonb_typeof(p -> 'later_fingerprint') = 'string' and p ->> 'later_fingerprint' ~ '^[0-9a-f]{64}$'
       and jsonb_typeof(p -> 'confirmed_by') = 'string' and p ->> 'confirmed_by' = p_deleted_by::text;
  end if;
  return jsonb_typeof(p -> 'later_fingerprint') = 'null' and jsonb_typeof(p -> 'confirmed_by') = 'null';
end;
$$ language plpgsql immutable;

-- v21's checks, unchanged, then the shape of the roster work.
create function training_load.validate_import_deletion_log_v60() returns trigger as $$
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
  if not training_load.session_undo_roster_log_ok(new.roster_work_removed, new.deleted_by_user_id) then
    raise exception 'import_deletion_log: roster_work_removed is not in its closed shape' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger import_deletion_log_validate on training_load.import_deletion_log;
create trigger import_deletion_log_validate
  before insert on training_load.import_deletion_log
  for each row execute function training_load.validate_import_deletion_log_v60();

-- ---------------------------------------------------------------------------
-- 4b. The scope: v57's, with the alias set and the split roster work
-- ---------------------------------------------------------------------------
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
  v_work jsonb;
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
  -- v60: the roster work, split into what the import wrote and what came later.
  v_work := training_load.session_undo_roster_work(v_alias);
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
    'aliasActivityIds', to_jsonb(v_alias),
    'rosterWork', v_work);
end;
-- Volatile on purpose: every statement of the body takes its own snapshot, so the second look (after the activities are
-- locked) sees a link committed while the lock was waited for.
$$ language plpgsql;


-- ---------------------------------------------------------------------------
-- 5. The sanctioned undo, with the roster work (DROP + CREATE: one more parameter and one more result column)
-- ---------------------------------------------------------------------------
drop function training_load.undo_imported_session(uuid, uuid, uuid, uuid, text, uuid);

create function training_load.undo_imported_session(
  p_actor uuid, p_team uuid, p_candidate uuid, p_request_key uuid, p_reason text, p_expected_event uuid default null,
  p_later_roster_fingerprint text default null
) returns table (
  replayed boolean, event_id uuid, deletion_log_id uuid, removed_counts jsonb, removed_total integer, new_candidate_id uuid,
  undone_candidate_ids uuid[], roster_work_removed jsonb
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
  values (p_actor, 'platform_admin', v_reason, v_event_id, v_scope ->> 'sourceSystem', (v_scope ->> 'connectionId')::uuid,
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
$$ language plpgsql;

comment on function training_load.undo_imported_session(uuid, uuid, uuid, uuid, text, uuid, text) is
  'v60: the sanctioned undo of one imported GPEXE session, its roster work included (platform admin only). See migrations_v2/202611101000_training_load_v60_undo_roster_work.sql.';

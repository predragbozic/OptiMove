-- Training Load v61 (J20-C of docs/ai/j20-session-review-contract.md): the attendance states a session's import writes are
-- bound to that import's approval.
--
-- v60 (O1) lets a roster request say origin = 'import' (the undo then removes it without a question) when an approval of the
-- same session by the same user exists from before the request. Its reviews left two things to J20-C: the time between the
-- approval and the request is not bounded, and the request does not name WHICH approval. v61 closes both:
--   1. activity_roster_requests.origin_approval_id (uuid, NULL for every other request): an import-origin request names its
--      approval; a CHECK holds origin = 'import' exactly when it is set. No backfill: no import-origin request can exist
--      before J20-C's route (the preflight counts them).
--   2. training_load.import_states_window() is the one place the window lives (30 minutes, the Rukovodilac's decision of
--      2026-11-10). The route reads it from here; nothing else holds the number.
--   3. The request guard (a new function; the trigger is re-pointed, v60's function stays for the rollback) keeps every
--      v60 rule and, for an import-origin request, checks the NAMED approval: the same team, the same user, the same session
--      (its event linked to an activity of the request's alias set), approved_at <= now() <= approved_at + the window (the
--      server's time, never a created_at the writer could set),
--      its candidate not undone (v57); and every decision the request wrote (they are inserted before it, the FK is deferred)
--      names an athlete on the session's roster (training.activity_roster). An athlete the coach left out of the import
--      (v59's excluded_athlete_ids) is on the roster and may get a state; one who is not on the roster may not. Refusals are
--      23514 with fixed messages.
--
-- Lock order: unchanged. The guard reads the approval, the candidate and the roster without locking them; the route takes
-- the roster command's own locks (decider rows, the team's import lock, the alias set) before it writes.
--
-- Rollback: docs/runbooks/import-states-v61-rollback.sql (re-points the trigger to v60's function, drops what v61 added;
-- refuses once an import-origin request exists or a later migration is recorded). Runbook: docs/runbooks/import-states-v61.md.

-- ---------------------------------------------------------------------------
-- 0. The body this migration replaces must be the one in force (v60's request guard)
-- ---------------------------------------------------------------------------
do $$
begin
  if (select md5(p.prosrc)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training' and p.proname = 'protect_activity_roster_request_v60')
     is distinct from 'b80d37661ee1b9dc021b6d08b8e74993' then
    raise exception 'v61 refused: the body in force of training.protect_activity_roster_request_v60 is not v60''s' using errcode = '23514';
  end if;
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'training' and c.relname = 'activity_roster_requests' and t.tgname = 'activity_roster_requests_protect'
       and t.tgfoid = 'training.protect_activity_roster_request_v60()'::regprocedure) then
    raise exception 'v61 refused: activity_roster_requests_protect does not run v60''s guard' using errcode = '23514';
  end if;
  if exists (select 1 from training.activity_roster_requests where origin = 'import') then
    raise exception 'v61 refused: an import-origin roster request exists already' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The approval an import-origin request belongs to
-- ---------------------------------------------------------------------------
-- No index on the column: the approvals are append-only (v23), so the foreign key is never checked from their side by a
-- delete or an update, and nothing reads the requests by approval.
alter table training.activity_roster_requests
  add column origin_approval_id uuid references training_load.gpexe_import_approvals(id) on delete restrict,
  add constraint activity_roster_requests_origin_approval_check check ((origin = 'import') = (origin_approval_id is not null));

-- ---------------------------------------------------------------------------
-- 2. The window: the one place it lives
-- ---------------------------------------------------------------------------
create function training_load.import_states_window() returns interval as $$
  select interval '30 minutes'
$$ language sql immutable;

comment on function training_load.import_states_window() is
  'v61: how long after an import approval its attendance states may be saved as the import''s own (origin import). After it, the Roster tab.';

-- ---------------------------------------------------------------------------
-- 3. The request guard: v60's rules, the named approval and the roster
-- ---------------------------------------------------------------------------
create function training.protect_activity_roster_request_v61() returns trigger as $$
declare
  v_team uuid;
  v_appr record;
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
    select a.id, a.owner_team_id, a.approved_by_user_id, a.approved_at, a.metric_event_id, c.import_undone_at
      into v_appr
      from training_load.gpexe_import_approvals a
      join training_load.gpexe_import_candidates c on c.id = a.candidate_id
     where a.id = new.origin_approval_id;
    if v_appr.id is null
       or v_appr.owner_team_id is distinct from v_team
       or v_appr.approved_by_user_id is distinct from new.performed_by_user_id
       or not exists (
         select 1
           from training.activity_alias_ids(training.resolve_canonical_activity_id(new.activity_id)) s
          where exists (select 1 from training.activity_metric_event_links l
                         where l.activity_id = s.activity_id and l.metric_event_id = v_appr.metric_event_id)
             or exists (select 1 from training.activity_participants ap
                          join training.activity_participant_metric_participant_links pl on pl.activity_participant_id = ap.id
                          join training_load.metric_event_participants p on p.id = pl.metric_event_participant_id
                         where ap.activity_id = s.activity_id and p.event_id = v_appr.metric_event_id)) then
      raise exception 'activity_roster_requests: origin import needs an approval of this session by the same user'
        using errcode = '23514';
    end if;
    if v_appr.import_undone_at is not null then
      raise exception 'activity_roster_requests: origin import names an undone import' using errcode = '23514';
    end if;
    -- The server's time (the transaction's start, the same now() the route reads), never the writer's created_at.
    if now() < v_appr.approved_at or now() > v_appr.approved_at + training_load.import_states_window() then
      raise exception 'activity_roster_requests: origin import is outside the import states window' using errcode = '23514';
    end if;
    if exists (
      select 1 from training.activity_athlete_decisions d
       where d.request_id = new.id
         and not exists (select 1 from training.activity_roster(training.resolve_canonical_activity_id(new.activity_id)) r
                          where r.athlete_id = d.athlete_id)) then
      raise exception 'activity_roster_requests: origin import names an athlete who is not on the roster' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger activity_roster_requests_protect on training.activity_roster_requests;
create trigger activity_roster_requests_protect
  before insert or update or delete on training.activity_roster_requests
  for each row execute function training.protect_activity_roster_request_v61();

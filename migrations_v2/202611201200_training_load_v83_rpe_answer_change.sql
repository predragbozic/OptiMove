-- Training Load v83 - an athlete changes their own RPE answer while the question is open (central calendar K4b;
-- contract docs/ai/central-calendar-k4b-contract.md, PR #647; the OptiMove manager's GO of 2026-11-19).
--
-- What this migration adds (functions, one table, one trigger re-pointed, one constraint trigger; no row of any existing
-- table is written):
--   * training_load.session_feedback_changes: the append-only history of a changed answer (who, when, the old and the new
--     values, the basis, the request key and its hash). One row per change; a revision number per answer.
--   * training_load.change_external_rpe(...): the sanctioned change. It changes the one session_feedback row of an
--     external (calendar) RPE answer in place - RPE, duration and note, the athlete's own entries (contract 1.4, 2) -
--     and writes the history row in the same transaction. srpe is a generated column and follows.
--   * The marker optimove.rpe_change_tx = pg_current_xact_id(), set by the function for its own call only (the v57
--     pattern). The snapshot trigger protect_session_feedback_snapshot is re-pointed to a v83 function that copies the
--     v5 rule and its refusal byte for byte and lets rpe / duration_minutes / athlete_note differ ONLY under that marker
--     and ONLY on a 'scheduled_external' row. The v5 function stays in place (the rollback re-points the trigger back).
--   * The history insert guard checks in the database, under the locks: the marker, the athlete's own user, the answer's
--     identity, the window (clock_timestamp() inside opens_at..closes_at, the schedule active, the occurrence not
--     cancelled, the assignment completed), the old values and the next revision.
--   * session_feedback_change_link, a deferred constraint trigger (the v35 lesson): a change of those three columns
--     without its history row written by the same transaction (not in a savepoint) is refused at COMMIT, or where the
--     function sets it IMMEDIATE.
--
-- Lock order of the function (users first, the rule of PR #346 / LO-1; then the submit's own order,
-- backend/src/routes/trainingLoad.js POST /external-assignments/:assignmentId/rpe): acting user (FOR SHARE) ->
-- external_schedules (FOR UPDATE) -> external_schedule_occurrences (FOR UPDATE) -> external_assignments (FOR UPDATE) ->
-- the athlete of the LOCKED assignment (FOR SHARE; its user_id must be the actor) -> session_feedback (FOR UPDATE) ->
-- the history insert. Every lock before the first write.
--
-- Outcomes are returned as jsonb (nothing is written for any but 'changed'); a guard refusal is 42501 / 23514 with a
-- fixed message; a call from inside a savepoint is 55000 'rpe_change:in_savepoint'.
-- The guards prove that the row, the history and the window agree; they do not stop whoever holds the database
-- credentials (stated as v35 states it).
-- Rollback: docs/runbooks/rpe-answer-change-v83-rollback.sql. Runbook: docs/runbooks/rpe-answer-change-v83.md.

-- ---------------------------------------------------------------------------
-- 0. The body this migration copies must be the one in force (v5)
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
begin
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'training_load' and p.proname = 'protect_session_feedback_snapshot';
  if v_md5 is distinct from '1d60bc187fa149ca524ffcb0e61d8a63' then
    raise exception 'v83 refused: training_load.protect_session_feedback_snapshot is not the v5 body (md5 %)', v_md5 using errcode = '23514';
  end if;
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'training_load.session_feedback'::regclass
                   and t.tgname = 'protect_session_feedback_snapshot' and not t.tgisinternal
                   and t.tgfoid = 'training_load.protect_session_feedback_snapshot()'::regprocedure) then
    raise exception 'v83 refused: the trigger protect_session_feedback_snapshot does not call the v5 function' using errcode = '23514';
  end if;
  if to_regclass('training_load.session_feedback_changes') is not null
     or to_regprocedure('training_load.change_external_rpe(uuid,uuid,uuid,integer,integer,text,integer)') is not null then
    raise exception 'v83 refused: a v83 object already exists' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The marker and the transaction's own xmin
-- ---------------------------------------------------------------------------
create function training_load.rpe_change_marker_ok() returns boolean as $$
  select coalesce(current_setting('optimove.rpe_change_tx', true) = pg_current_xact_id()::text, false);
$$ language sql stable;

-- The id of this (top-level) transaction as a row's xmin carries it; a row written inside a savepoint carries the
-- subtransaction's id instead, so it never matches (fail closed, as v35).
create function training_load.rpe_change_current_xmin() returns bigint as $$
  select pg_current_xact_id()::text::bigint % 4294967296;
$$ language sql volatile;

-- ---------------------------------------------------------------------------
-- 2. The history
-- ---------------------------------------------------------------------------
create table training_load.session_feedback_changes (
  id uuid primary key default gen_random_uuid(),
  session_feedback_id uuid not null references training_load.session_feedback(id) on delete restrict,
  external_assignment_id uuid not null references training_load.external_assignments(id) on delete restrict,
  athlete_id uuid not null references public.athletes(id) on delete restrict,
  revision integer not null check (revision >= 1),
  changed_by_user_id uuid not null references public.users(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp(),
  basis text not null check (basis = 'athlete_self'),
  old_rpe smallint not null check (old_rpe between 0 and 10),
  old_duration_minutes smallint not null check (old_duration_minutes between 1 and 600),
  old_athlete_note text check (old_athlete_note is null or char_length(old_athlete_note) <= 500),
  new_rpe smallint not null check (new_rpe between 0 and 10),
  new_duration_minutes smallint not null check (new_duration_minutes between 1 and 600),
  new_athlete_note text check (new_athlete_note is null or char_length(new_athlete_note) <= 500),
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  -- Written flat (a OR b OR c), so a pg_dump / pg_restore reads it back the same (the v32 lesson).
  constraint session_feedback_changes_values_differ check (
    old_rpe is distinct from new_rpe or old_duration_minutes is distinct from new_duration_minutes
    or old_athlete_note is distinct from new_athlete_note),
  constraint session_feedback_changes_revision_key unique (session_feedback_id, revision),
  constraint session_feedback_changes_request_key unique (session_feedback_id, request_key)
);
create index session_feedback_changes_assignment_idx on training_load.session_feedback_changes (external_assignment_id, changed_at desc);

comment on table training_load.session_feedback_changes is
  'v83: the append-only history of an athlete''s change of their own external RPE answer. Written only by training_load.change_external_rpe().';

create function training_load.session_feedback_changes_append_only() returns trigger as $$
begin
  raise exception 'training_load.session_feedback_changes is append-only' using errcode = '23514';
end;
$$ language plpgsql;

create trigger session_feedback_changes_no_update_delete
  before update or delete on training_load.session_feedback_changes
  for each row execute function training_load.session_feedback_changes_append_only();
create trigger session_feedback_changes_no_truncate
  before truncate on training_load.session_feedback_changes
  for each statement execute function training_load.session_feedback_changes_append_only();

-- The insert guard: the database checks who and until when, under the locks (condition 1).
create function training_load.session_feedback_changes_guard() returns trigger as $$
declare
  v_win record;
  v_fb record;
  v_rev integer;
  v_now timestamptz := clock_timestamp();
begin
  if not training_load.rpe_change_marker_ok() then
    raise exception 'training_load.session_feedback_changes: only training_load.change_external_rpe() writes a change' using errcode = '42501';
  end if;
  perform 1
    from public.users u
    join public.athletes a on a.user_id = u.id
   where u.id = new.changed_by_user_id and u.is_active = true and a.id = new.athlete_id
     for share of u, a;
  if not found then
    raise exception 'training_load.session_feedback_changes: only the athlete changes their own answer' using errcode = '42501';
  end if;
  select s.status as schedule_status, o.status as occurrence_status, asg.status as assignment_status,
         asg.opens_at, asg.closes_at, asg.athlete_id
    into v_win
    from training_load.external_assignments asg
    join training_load.external_schedule_occurrences o on o.id = asg.occurrence_id
    join training_load.external_schedules s on s.id = o.schedule_id
   where asg.id = new.external_assignment_id
     for share of s, o, asg;
  if not found or v_win.athlete_id is distinct from new.athlete_id then
    raise exception 'training_load.session_feedback_changes: the answer does not belong to this assignment' using errcode = '23514';
  end if;
  if v_win.schedule_status <> 'active' or v_win.occurrence_status = 'cancelled' or v_win.assignment_status <> 'completed'
     or v_now < v_win.opens_at or v_now > v_win.closes_at then
    raise exception 'training_load.session_feedback_changes: the question is closed' using errcode = '23514';
  end if;
  select id, source, external_assignment_id, athlete_id, rpe, duration_minutes, athlete_note
    into v_fb
    from training_load.session_feedback
   where id = new.session_feedback_id
     for share;
  if not found or v_fb.source <> 'scheduled_external' or v_fb.external_assignment_id is distinct from new.external_assignment_id
     or v_fb.athlete_id is distinct from new.athlete_id then
    raise exception 'training_load.session_feedback_changes: the answer does not belong to this assignment' using errcode = '23514';
  end if;
  if (v_fb.rpe, v_fb.duration_minutes, v_fb.athlete_note) is distinct from (new.old_rpe, new.old_duration_minutes, new.old_athlete_note) then
    raise exception 'training_load.session_feedback_changes: the old values are not the answer''s current values' using errcode = '23514';
  end if;
  select coalesce(max(revision), 0) + 1 into v_rev from training_load.session_feedback_changes where session_feedback_id = new.session_feedback_id;
  if new.revision is distinct from v_rev then
    raise exception 'training_load.session_feedback_changes: the revision is not the next one' using errcode = '23514';
  end if;
  new.changed_at := v_now;
  return new;
end;
$$ language plpgsql;

create trigger session_feedback_changes_guard
  before insert on training_load.session_feedback_changes
  for each row execute function training_load.session_feedback_changes_guard();

-- ---------------------------------------------------------------------------
-- 3. The snapshot trigger: the v5 rule, plus the one exception under the marker
-- ---------------------------------------------------------------------------
create function training_load.protect_session_feedback_snapshot_v83() returns trigger language plpgsql as $$
declare
  v_change_allowed boolean := OLD.source = 'scheduled_external' and training_load.rpe_change_marker_ok();
begin
  if NEW.athlete_id is distinct from OLD.athlete_id
     or NEW.logical_session_id is distinct from OLD.logical_session_id
     or NEW.source is distinct from OLD.source
     or NEW.external_assignment_id is distinct from OLD.external_assignment_id
     or NEW.event_name is distinct from OLD.event_name
     or NEW.session_date is distinct from OLD.session_date
     or NEW.plan_name is distinct from OLD.plan_name
     or NEW.plan_week_start is distinct from OLD.plan_week_start
     or NEW.session_name is distinct from OLD.session_name
     or NEW.session_time is distinct from OLD.session_time
     or NEW.session_am_pm is distinct from OLD.session_am_pm
     or NEW.session_bta is distinct from OLD.session_bta
     or (not v_change_allowed and NEW.rpe is distinct from OLD.rpe)
     or (not v_change_allowed and NEW.duration_minutes is distinct from OLD.duration_minutes)
     or (not v_change_allowed and NEW.athlete_note is distinct from OLD.athlete_note)
     or NEW.submitted_at is distinct from OLD.submitted_at
     or NEW.created_at is distinct from OLD.created_at
  then
    raise exception 'training_load.session_feedback.% is an immutable snapshot once created - only plan_session_id (the nullable best-effort backreference) may ever change', OLD.id;
  end if;
  return NEW;
end $$;

drop trigger protect_session_feedback_snapshot on training_load.session_feedback;
create trigger protect_session_feedback_snapshot
  before update on training_load.session_feedback
  for each row execute function training_load.protect_session_feedback_snapshot_v83();

-- ---------------------------------------------------------------------------
-- 4. The deferred link: a changed answer has its history row from the same transaction (the v35 lesson)
-- ---------------------------------------------------------------------------
create function training_load.session_feedback_change_link_check() returns trigger as $$
declare
  v_here bigint := training_load.rpe_change_current_xmin();
  v_cur record;
begin
  -- The CURRENT row, not NEW: a later update in the same transaction may have replaced NEW.
  select id, rpe, duration_minutes, athlete_note, xmin::text::bigint as written_in
    into v_cur
    from training_load.session_feedback
   where id = new.id;
  if not found then
    return null;
  end if;
  if v_cur.written_in is distinct from v_here
     or not exists (
       select 1 from training_load.session_feedback_changes h
        where h.session_feedback_id = v_cur.id
          and h.xmin::text::bigint = v_here
          and h.new_rpe = v_cur.rpe
          and h.new_duration_minutes = v_cur.duration_minutes
          and h.new_athlete_note is not distinct from v_cur.athlete_note) then
    raise exception 'training_load.session_feedback: a changed answer needs its history row from the same transaction' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger session_feedback_change_link
  after update of rpe, duration_minutes, athlete_note on training_load.session_feedback
  deferrable initially deferred
  for each row
  when (OLD.rpe is distinct from NEW.rpe or OLD.duration_minutes is distinct from NEW.duration_minutes
        or OLD.athlete_note is distinct from NEW.athlete_note)
  execute function training_load.session_feedback_change_link_check();

-- ---------------------------------------------------------------------------
-- 5. The answer as the function returns it
-- ---------------------------------------------------------------------------
create function training_load.rpe_change_state(p_feedback_id uuid) returns jsonb as $$
  select jsonb_build_object(
           'feedbackId', f.id, 'rpe', f.rpe, 'durationMinutes', f.duration_minutes, 'srpe', f.srpe,
           'note', f.athlete_note, 'submittedAt', f.submitted_at,
           'revision', coalesce((select max(h.revision) from training_load.session_feedback_changes h where h.session_feedback_id = f.id), 0),
           'lastChangedAt', (select max(h.changed_at) from training_load.session_feedback_changes h where h.session_feedback_id = f.id),
           'closesAt', a.closes_at)
    from training_load.session_feedback f
    join training_load.external_assignments a on a.id = f.external_assignment_id
   where f.id = p_feedback_id;
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- 6. The sanctioned change
-- ---------------------------------------------------------------------------
create function training_load.change_external_rpe(
  p_actor uuid, p_assignment uuid, p_request_key uuid, p_rpe integer, p_duration_minutes integer, p_note text,
  p_expected_revision integer
) returns jsonb as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_hash text;
  v_lookup record;
  v_sched record;
  v_occ record;
  v_asg record;
  v_ath record;
  v_fb record;
  v_prev record;
  v_rev integer;
  v_now timestamptz;
  v_id uuid;
begin
  -- 1. Arguments (nothing is read before them).
  if p_actor is null or p_assignment is null or p_request_key is null or p_rpe is null or p_duration_minutes is null
     or p_rpe not between 0 and 10 or p_duration_minutes not between 1 and 600 or char_length(coalesce(v_note, '')) > 500
     or (p_expected_revision is not null and p_expected_revision < 0) then
    return jsonb_build_object('outcome', 'refused', 'code', 'invalid');
  end if;
  v_hash := encode(sha256(convert_to(jsonb_build_object('rpe', p_rpe, 'durationMinutes', p_duration_minutes, 'note', v_note)::text, 'UTF8')), 'hex');

  -- 2. The acting user, first.
  perform 1 from public.users where id = p_actor and is_active = true for share;
  if not found then
    return jsonb_build_object('outcome', 'refused', 'code', 'not_found');
  end if;

  -- 3. An unlocked lookup; not hers or missing is the one answer.
  select asg.id, asg.occurrence_id, o.schedule_id
    into v_lookup
    from training_load.external_assignments asg
    join training_load.external_schedule_occurrences o on o.id = asg.occurrence_id
    join public.athletes a on a.id = asg.athlete_id
   where asg.id = p_assignment and a.user_id = p_actor;
  if not found then
    return jsonb_build_object('outcome', 'refused', 'code', 'not_found');
  end if;

  -- 4. The submit's order: schedule -> occurrence -> assignment.
  select status into v_sched from training_load.external_schedules where id = v_lookup.schedule_id for update;
  select status into v_occ from training_load.external_schedule_occurrences where id = v_lookup.occurrence_id for update;
  select * into v_asg from training_load.external_assignments where id = p_assignment for update;

  -- 5. The athlete of the LOCKED assignment, locked; its user must be the actor (never "the first athlete of the user").
  select id, user_id into v_ath from public.athletes where id = v_asg.athlete_id for share;
  if not found or v_ath.user_id is distinct from p_actor then
    return jsonb_build_object('outcome', 'refused', 'code', 'not_found');
  end if;

  -- 6. The answer.
  select id, rpe, duration_minutes, athlete_note, source
    into v_fb
    from training_load.session_feedback
   where external_assignment_id = p_assignment
     for update;
  if not found then
    return jsonb_build_object('outcome', 'refused', 'code', 'not_answered');
  end if;
  if v_fb.source <> 'scheduled_external' then
    return jsonb_build_object('outcome', 'refused', 'code', 'not_found');
  end if;
  select coalesce(max(revision), 0) into v_rev from training_load.session_feedback_changes where session_feedback_id = v_fb.id;

  -- 7. A replay is answered before the window (a retry after an unknown outcome gets its answer).
  select request_hash into v_prev from training_load.session_feedback_changes where session_feedback_id = v_fb.id and request_key = p_request_key;
  if found then
    if v_prev.request_hash = v_hash then
      return jsonb_build_object('outcome', 'replayed', 'feedback', training_load.rpe_change_state(v_fb.id));
    end if;
    return jsonb_build_object('outcome', 'refused', 'code', 'request_key_reused');
  end if;

  -- 8. The window, under the locks, at the clock (never now(): a change that waited on a lock is decided now).
  v_now := clock_timestamp();
  if v_sched.status <> 'active' or v_occ.status = 'cancelled' or v_asg.status <> 'completed'
     or v_now < v_asg.opens_at or v_now > v_asg.closes_at then
    return jsonb_build_object('outcome', 'refused', 'code', 'window_closed', 'feedback', training_load.rpe_change_state(v_fb.id));
  end if;

  -- 9. The same values write nothing (no history row, the key not recorded).
  if (v_fb.rpe, v_fb.duration_minutes, v_fb.athlete_note) is not distinct from (p_rpe::smallint, p_duration_minutes::smallint, v_note) then
    return jsonb_build_object('outcome', 'unchanged', 'feedback', training_load.rpe_change_state(v_fb.id));
  end if;

  -- 10. Another screen changed it first.
  if p_expected_revision is not null and p_expected_revision <> v_rev then
    return jsonb_build_object('outcome', 'refused', 'code', 'answer_changed', 'feedback', training_load.rpe_change_state(v_fb.id));
  end if;

  -- 11. The marker, the history, the change, the deferred link checked here.
  perform set_config('optimove.rpe_change_tx', pg_current_xact_id()::text, true);
  insert into training_load.session_feedback_changes
    (session_feedback_id, external_assignment_id, athlete_id, revision, changed_by_user_id, basis,
     old_rpe, old_duration_minutes, old_athlete_note, new_rpe, new_duration_minutes, new_athlete_note, request_key, request_hash)
  values (v_fb.id, p_assignment, v_ath.id, v_rev + 1, p_actor, 'athlete_self',
          v_fb.rpe, v_fb.duration_minutes, v_fb.athlete_note, p_rpe, p_duration_minutes, v_note, p_request_key, v_hash)
  returning id into v_id;
  if (select xmin::text::bigint from training_load.session_feedback_changes where id = v_id) is distinct from training_load.rpe_change_current_xmin() then
    raise exception 'rpe_change:in_savepoint' using errcode = '55000';
  end if;
  update training_load.session_feedback
     set rpe = p_rpe, duration_minutes = p_duration_minutes, athlete_note = v_note
   where id = v_fb.id;
  set constraints training_load.session_feedback_change_link immediate;
  set constraints training_load.session_feedback_change_link deferred;
  -- The marker covers this call only.
  perform set_config('optimove.rpe_change_tx', '', true);
  return jsonb_build_object('outcome', 'changed', 'feedback', training_load.rpe_change_state(v_fb.id));
end;
$$ language plpgsql set search_path = pg_catalog, public;

comment on function training_load.change_external_rpe(uuid, uuid, uuid, integer, integer, text, integer) is
  'v83: the sanctioned change of an athlete''s own external RPE answer while the question is open. See migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql.';

-- ---------------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------------
alter table training_load.session_feedback_changes enable row level security;
revoke all on training_load.session_feedback_changes from public;
revoke execute on function training_load.change_external_rpe(uuid, uuid, uuid, integer, integer, text, integer) from public;
revoke execute on function training_load.session_feedback_changes_guard() from public;
revoke execute on function training_load.session_feedback_changes_append_only() from public;
revoke execute on function training_load.session_feedback_change_link_check() from public;
revoke execute on function training_load.protect_session_feedback_snapshot_v83() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on training_load.session_feedback_changes from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on training_load.session_feedback_changes from authenticated';
  end if;
end $$;

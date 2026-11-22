-- Training Load v89 - a session type per athlete, and a type changed after the import (ST-3 of
-- docs/ai/session-type-plan.md, sections 3, 5, 6 and 10; section 16 records what was built).
--
-- What this migration does:
--   * training.participant_activity_types: an athlete's own session type in one session (the exception of plan
--     section 3), one live row per participant. Clearing or replacing an exception ends its row (ended_at, who, why);
--     nothing is updated otherwise and nothing is deleted, except with its participant by the sanctioned undo of an
--     imported session (v57's marker).
--   * training.effective_activity_type(participant): the one place that decides an athlete's type in a session - the
--     canonical participant's live exception, otherwise the canonical activity's type.
--   * training.activity_type_requests: the append-only request record of the two routes (a session's type changed
--     after the import; an athlete's exception set or cleared): who, on which basis, the old and the new type, the
--     reason, the request key and its hash, the saved answer.
--   * Guards (the v35 / v85 pattern): a new exception and a request row need the transaction's acting user
--     (optimove.session_type_actor) with the roster decider's right on the activity's team
--     (training.lock_activity_decider, users first since v54); the exception's type must be active, offered to the
--     team's club (training.session_type_offered, the type row FOR SHARE) and different from the session's type; the
--     participant must be canonical and its activity a team's, not superseded. An exception row only ever ends: by its
--     acting user, or by a merge or a reparent (below).
--   * training.merge_activity_participants and training.reparent_activity_participant (v4) are replaced, their bodies
--     unchanged but for one added block each: a merge ends the merged (source) participant's live exception, the
--     canonical one keeps its own; a reparent ends the participant's live exception, because the session around it
--     changed. The block runs after the functions' own locks (the activities, then the participants), so the lock order
--     is activities -> participants -> exception rows, the order the routes take.
--   * training.activity_field_correction_log (v1): its foreign key to the activity becomes ON DELETE CASCADE and a
--     guard refuses every delete outside the sanctioned undo. Before ST-3 nothing wrote this log; the type change
--     route does (through training.correct_confirmed_activity_fields), and without this an undo of a session whose
--     type was changed would fail on the foreign key. The undo's own function is not changed. A correction's
--     changed_at becomes the wall clock (a trigger), so "was the type changed after this estimate was saved" compares
--     two wall-clock times.
--
-- Nothing else is written: no activity changes its type, no exception exists after the migration.
-- Lock orders: an exception write - the team, its club, the acting user, the role row (FOR SHARE), the activity row,
-- the participant row, the exception row, the type row (FOR SHARE); a session type change - the same rights, the
-- activity row (FOR UPDATE), the participants whose exception ends, their exception rows, the type row.
-- The guards prove that the row, the actor and the right agree; they do not stop whoever holds the database
-- credentials (stated as v35 states it).
-- Rollback: docs/runbooks/participant-session-types-v89-rollback.sql. Runbook: docs/runbooks/participant-session-types-v89.md.

-- The schema locks below (foreign keys to the activity, participant and user tables) wait at most this long; a
-- lock-timeout failure changes nothing and the deploy is simply repeated at a quieter moment.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Preconditions: nothing of v89 exists, and the two v4 bodies are the ones v89 replaces
-- ---------------------------------------------------------------------------
do $$
declare
  expected constant text[][] := array[
    ['merge_activity_participants', 'c3c16b64fe37f1511e42a7db50d68063'],
    ['reparent_activity_participant', 'be3b50ce3e52750fb80e09e31b9bc4e8']];
  i int;
begin
  if to_regclass('training.participant_activity_types') is not null or to_regclass('training.activity_type_requests') is not null then
    raise exception 'v89 refused: a v89 table already exists' using errcode = '23514';
  end if;
  if to_regprocedure('training.session_type_offered(text, uuid, boolean)') is null
     or to_regprocedure('training.lock_activity_decider(uuid, uuid, character varying)') is null
     or to_regprocedure('training_load.session_undo_marker_ok()') is null then
    raise exception 'v89 refused: v54, v57 and v85 must be applied first' using errcode = '23514';
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training' and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v89 refused: the body in force of training.% is not v4''s', expected[i][1] using errcode = '23514';
    end if;
  end loop;
  if (select confdeltype from pg_constraint where conname = 'activity_field_correction_log_activity_id_fkey'
        and conrelid = 'training.activity_field_correction_log'::regclass) is distinct from 'a' then
    raise exception 'v89 refused: the correction log''s activity key is not as v1 made it' using errcode = '23514';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The athlete's own session type (the exception)
-- ---------------------------------------------------------------------------
create table training.participant_activity_types (
  id                uuid primary key default gen_random_uuid(),
  participant_id    uuid not null references training.activity_participants(id) on delete cascade,
  activity_type_key text not null references training.activity_types(key) on delete restrict,
  reason            text constraint participant_activity_types_reason_check
                    check (reason is null or training_load.source_metric_text_ok(reason, 300)),
  set_by_user_id    uuid not null references public.users(id) on delete restrict,
  set_by_basis      text not null
                    constraint participant_activity_types_basis_check check (set_by_basis in ('team_coach', 'club_admin', 'platform_admin')),
  set_at            timestamptz not null default clock_timestamp(),
  ended_at          timestamptz,
  ended_by_user_id  uuid references public.users(id) on delete restrict,
  end_cause         text constraint participant_activity_types_end_cause_check
                    check (end_cause in ('cleared', 'replaced', 'same_as_session', 'merge', 'reparent')),
  constraint participant_activity_types_end_shape check (
    (ended_at is null and ended_by_user_id is null and end_cause is null)
    or (ended_at is not null and end_cause is not null and ended_at >= set_at)),
  constraint participant_activity_types_user_end_shape check (
    end_cause is null or end_cause in ('merge', 'reparent') or ended_by_user_id is not null)
);
create unique index participant_activity_types_one_live on training.participant_activity_types (participant_id) where ended_at is null;
create index participant_activity_types_participant_idx on training.participant_activity_types (participant_id, set_at);

-- The one place that decides an athlete's type in a session.
create function training.effective_activity_type(p_participant_id uuid) returns text as $$
  select coalesce(
           (select x.activity_type_key from training.participant_activity_types x
             where x.participant_id = c.id and x.ended_at is null),
           (select a.activity_type_key from training.activities a
             where a.id = training.resolve_canonical_activity_id(c.activity_id)))
    from training.activity_participants c
   where c.id = training.resolve_canonical_participant_id(p_participant_id);
$$ language sql stable;

-- Whether p_user may decide on p_team's sessions on any basis (the roster decider's audience): the team and its club
-- active, then the acting user, then a role row - every row FOR SHARE, in training.lock_activity_decider's order.
create function training.session_type_team_decider(p_user uuid, p_team uuid) returns boolean as $$
declare
  v_club uuid;
begin
  select club_id into v_club from public.teams where id = p_team and coalesce(is_active, true) for share;
  if not found then
    return false;
  end if;
  perform 1 from public.clubs where id = v_club and coalesce(is_active, true) for share;
  if not found then
    return false;
  end if;
  perform 1 from public.users u where u.id = p_user and u.is_active = true for share;
  if not found then
    return false;
  end if;
  perform 1 from public.user_team_roles r
    where r.user_id = p_user and r.team_id = p_team and r.role = 'team_coach' and r.is_active = true for share of r;
  if found then
    return true;
  end if;
  perform 1 from public.user_club_roles r
    where r.user_id = p_user and r.club_id = v_club and r.role = 'club_admin' and r.is_active = true for share of r;
  if found then
    return true;
  end if;
  perform 1 from public.user_global_roles r
    where r.user_id = p_user and r.role = 'platform_admin' and r.is_active = true for share of r;
  return found;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create function training.participant_activity_types_before_write() returns trigger as $$
declare
  v_actor uuid;
  v_participant record;
  v_activity record;
  v_club uuid;
begin
  if tg_op = 'DELETE' then
    -- Only with its participant, by the sanctioned undo of an imported session (v57).
    if not training_load.session_undo_marker_ok() then
      raise exception 'training.participant_activity_types: an exception ends, it is never deleted' using errcode = '23514';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.participant_id is distinct from old.participant_id
       or new.activity_type_key is distinct from old.activity_type_key or new.reason is distinct from old.reason
       or new.set_by_user_id is distinct from old.set_by_user_id or new.set_by_basis is distinct from old.set_by_basis
       or new.set_at is distinct from old.set_at then
      raise exception 'training.participant_activity_types: an exception only ever ends' using errcode = '23514';
    end if;
    if old.ended_at is not null or new.ended_at is null then
      raise exception 'training.participant_activity_types: an exception ends once' using errcode = '23514';
    end if;
    new.ended_at := clock_timestamp();
    if new.end_cause in ('merge', 'reparent') then
      if current_setting('training.allow_participant_type_end', true) is distinct from 'on' then
        raise exception 'training.participant_activity_types: only a merge or a reparent ends an exception this way' using errcode = '42501';
      end if;
      return new;
    end if;
    v_actor := training.session_type_actor();
    if new.ended_by_user_id is distinct from v_actor then
      raise exception 'training.participant_activity_types: the end names the acting user' using errcode = '42501';
    end if;
    select a.owner_scope, a.owner_team_id into v_activity
      from training.activity_participants ap join training.activities a on a.id = ap.activity_id
     where ap.id = new.participant_id;
    if v_activity.owner_scope is distinct from 'team' or not training.session_type_team_decider(v_actor, v_activity.owner_team_id) then
      raise exception 'training.participant_activity_types: the acting user may not decide on this session' using errcode = '42501';
    end if;
    return new;
  end if;

  -- INSERT: a new, live exception.
  v_actor := training.session_type_actor();
  if new.set_by_user_id is distinct from v_actor then
    raise exception 'training.participant_activity_types: the row names the acting user' using errcode = '42501';
  end if;
  if new.ended_at is not null or new.ended_by_user_id is not null or new.end_cause is not null then
    raise exception 'training.participant_activity_types: a new exception is live' using errcode = '23514';
  end if;
  new.set_at := clock_timestamp();
  -- The order of the routes: the rights first, then the activity row, then the participant row.
  -- 1. The session and its team, read without a lock (an activity's owner never changes), and the roster decider's
  --    right on the claimed basis (42501 from the function itself).
  select ap.activity_id into v_participant from training.activity_participants ap where ap.id = new.participant_id;
  if not found then
    raise exception 'training.participant_activity_types: the participant is not a canonical participant' using errcode = '23514';
  end if;
  select a.owner_scope, a.owner_team_id into v_activity from training.activities a where a.id = v_participant.activity_id;
  if v_activity.owner_scope is distinct from 'team' then
    raise exception 'training.participant_activity_types: only a team''s current session takes an exception' using errcode = '23514';
  end if;
  perform training.lock_activity_decider(v_actor, v_activity.owner_team_id, new.set_by_basis::varchar);
  -- 2. The activity row FOR SHARE: a type change of the session, a merge and a reparent (FOR UPDATE) wait for this
  --    write, and this for them.
  select a.owner_scope, a.owner_team_id, a.activity_type_key, a.lifecycle_state into v_activity
    from training.activities a where a.id = v_participant.activity_id for share;
  if v_activity.lifecycle_state = 'superseded' then
    raise exception 'training.participant_activity_types: only a team''s current session takes an exception' using errcode = '23514';
  end if;
  -- 3. The participant, read again under that lock: a merge or a reparent that committed while this write waited has
  --    superseded or moved it, and what was read before the lock no longer holds.
  perform 1 from training.activity_participants ap
    where ap.id = new.participant_id and ap.activity_id = v_participant.activity_id and ap.merge_status = 'canonical'
      for key share;
  if not found then
    raise exception 'training.participant_activity_types: the participant is not a canonical participant' using errcode = '23514';
  end if;
  if new.activity_type_key is not distinct from v_activity.activity_type_key then
    raise exception 'participant_type_same_as_session' using errcode = '23514';
  end if;
  select club_id into v_club from public.teams where id = v_activity.owner_team_id;
  if not training.session_type_offered(new.activity_type_key, v_club, true) then
    raise exception 'participant_type_not_offered' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;
create trigger participant_activity_types_before_write
  before insert or update or delete on training.participant_activity_types
  for each row execute function training.participant_activity_types_before_write();

create function training.participant_activity_types_no_truncate() returns trigger as $$
begin
  raise exception 'training.%: rows are never truncated', tg_table_name using errcode = '23514';
end;
$$ language plpgsql set search_path = pg_catalog, public;
create trigger participant_activity_types_no_truncate before truncate on training.participant_activity_types
  for each statement execute function training.participant_activity_types_no_truncate();

-- ---------------------------------------------------------------------------
-- 2. The request record of the two routes
-- ---------------------------------------------------------------------------
create table training.activity_type_requests (
  id                   uuid primary key default gen_random_uuid(),
  activity_id          uuid not null references training.activities(id) on delete cascade,
  athlete_id           uuid references public.athletes(id) on delete restrict,
  operation            text not null
                       constraint activity_type_requests_operation_check check (operation in ('session_type', 'athlete_type')),
  old_type_key         text references training.activity_types(key) on delete restrict,
  new_type_key         text references training.activity_types(key) on delete restrict,
  reason               text constraint activity_type_requests_reason_check
                       check (reason is null or training_load.source_metric_text_ok(reason, 300)),
  performed_by_user_id uuid not null references public.users(id) on delete restrict,
  basis                text not null
                       constraint activity_type_requests_basis_check check (basis in ('team_coach', 'club_admin', 'platform_admin')),
  request_key          uuid not null,
  request_hash         text not null constraint activity_type_requests_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  result               jsonb not null,
  created_xact         text not null default pg_current_xact_id()::text,
  created_at           timestamptz not null default clock_timestamp(),
  constraint activity_type_requests_shape check (
    (operation = 'session_type' and athlete_id is null and new_type_key is not null)
    or (operation = 'athlete_type' and athlete_id is not null)),
  constraint activity_type_requests_changes check (old_type_key is distinct from new_type_key)
);
create unique index activity_type_requests_request_key on training.activity_type_requests (performed_by_user_id, request_key);
create index activity_type_requests_activity_idx on training.activity_type_requests (activity_id, created_at);

create function training.activity_type_requests_before_write() returns trigger as $$
declare
  v_actor uuid;
  v_activity record;
begin
  if tg_op = 'DELETE' then
    if not training_load.session_undo_marker_ok() then
      raise exception 'training.activity_type_requests is append-only' using errcode = '23514';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'training.activity_type_requests is append-only' using errcode = '23514';
  end if;
  v_actor := training.session_type_actor();
  if new.performed_by_user_id is distinct from v_actor then
    raise exception 'training.activity_type_requests: the row names the acting user' using errcode = '42501';
  end if;
  if new.created_xact is distinct from pg_current_xact_id()::text then
    raise exception 'training.activity_type_requests: created_xact is the writing transaction' using errcode = '23514';
  end if;
  new.created_at := clock_timestamp();
  select a.owner_scope, a.owner_team_id into v_activity from training.activities a where a.id = new.activity_id;
  if not found or v_activity.owner_scope <> 'team' then
    raise exception 'training.activity_type_requests: only a team''s session' using errcode = '23514';
  end if;
  perform training.lock_activity_decider(v_actor, v_activity.owner_team_id, new.basis::varchar);
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;
create trigger activity_type_requests_before_write
  before insert or update or delete on training.activity_type_requests
  for each row execute function training.activity_type_requests_before_write();
create trigger activity_type_requests_no_truncate before truncate on training.activity_type_requests
  for each statement execute function training.participant_activity_types_no_truncate();

-- ---------------------------------------------------------------------------
-- 3. The correction log goes with its activity, only by the sanctioned undo
-- ---------------------------------------------------------------------------
alter table training.activity_field_correction_log
  drop constraint activity_field_correction_log_activity_id_fkey,
  add constraint activity_field_correction_log_activity_id_fkey
    foreign key (activity_id) references training.activities(id) on delete cascade;

create function training.activity_field_correction_log_no_delete() returns trigger as $$
begin
  if tg_op = 'TRUNCATE' or not training_load.session_undo_marker_ok() then
    raise exception 'training.activity_field_correction_log: a correction is never deleted' using errcode = '23514';
  end if;
  return old;
end;
$$ language plpgsql set search_path = pg_catalog, public;
-- A correction's time is the wall clock, not the transaction's start: a type change that waited for its lock is dated
-- after whatever it waited for (the mark on a saved estimate compares the two).
create function training.activity_field_correction_log_clock() returns trigger as $$
begin
  new.changed_at := clock_timestamp();
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;
create trigger activity_field_correction_log_clock before insert on training.activity_field_correction_log
  for each row execute function training.activity_field_correction_log_clock();
create trigger activity_field_correction_log_no_delete before delete on training.activity_field_correction_log
  for each row execute function training.activity_field_correction_log_no_delete();
create trigger activity_field_correction_log_no_truncate before truncate on training.activity_field_correction_log
  for each statement execute function training.activity_field_correction_log_no_delete();

-- ---------------------------------------------------------------------------
-- 4. A merge and a reparent end the exception (v4's bodies, one block added to each)
-- ---------------------------------------------------------------------------
create or replace function training.merge_activity_participants(
  p_source_participant_id uuid, p_target_participant_id uuid, p_performed_by uuid, p_reason text
) returns uuid as $$
declare
  v_lo_p uuid; v_hi_p uuid;
  v_lo_a uuid; v_hi_a uuid;
  v_source record; v_target record;
  v_source_owner record; v_target_owner record;
  v_remaining int;
begin
  if p_source_participant_id = p_target_participant_id then
    raise exception 'merge_activity_participants: source and target are the same participant';
  end if;

  -- Advisory-lock BOTH participant identities, sorted — the SAME lock
  -- namespace (salt 4) reparent_activity_participant uses, so a reparent
  -- and a merge racing over the SAME participant genuinely serialize
  -- against each other, not just merge-vs-merge.
  if p_source_participant_id < p_target_participant_id then v_lo_p := p_source_participant_id; v_hi_p := p_target_participant_id;
  else v_lo_p := p_target_participant_id; v_hi_p := p_source_participant_id; end if;
  perform pg_advisory_xact_lock(hashtextextended('activity-participant:' || v_lo_p::text, 4));
  perform pg_advisory_xact_lock(hashtextextended('activity-participant:' || v_hi_p::text, 4));

  -- Now reliably read source/target (no other conforming function can be
  -- mid-mutation of either while we hold both advisory locks).
  select * into v_source from training.activity_participants where id = p_source_participant_id;
  select * into v_target from training.activity_participants where id = p_target_participant_id;

  -- Idempotent replay: this exact merge already applied.
  if v_source.merge_status = 'superseded' and v_source.superseded_by_participant_id = p_target_participant_id then
    return p_target_participant_id;
  end if;

  if v_source.merge_status <> 'canonical' then
    raise exception 'merge_activity_participants: source participant % is already merged into a DIFFERENT participant — resolve to its canonical id first', p_source_participant_id;
  end if;
  if v_target.merge_status <> 'canonical' then
    raise exception 'merge_activity_participants: target participant % is itself an alias — merge into its canonical id instead', p_target_participant_id;
  end if;
  if v_source.athlete_id is distinct from v_target.athlete_id then
    raise exception 'merge_activity_participants: source and target represent DIFFERENT athletes — refusing';
  end if;

  -- Lock BOTH activities ascending by id (may be the same row — locking
  -- it once is harmless/idempotent within one transaction).
  if v_source.activity_id < v_target.activity_id then v_lo_a := v_source.activity_id; v_hi_a := v_target.activity_id;
  else v_lo_a := v_target.activity_id; v_hi_a := v_source.activity_id; end if;
  perform 1 from training.activities where id = v_lo_a for update;
  if v_hi_a <> v_lo_a then
    perform 1 from training.activities where id = v_hi_a for update;
  end if;

  -- Lock BOTH participant rows, sorted by id (redundant with the advisory
  -- lock for OTHER conforming callers, but keeps FOR UPDATE/FOR SHARE
  -- readers consistent too).
  perform 1 from training.activity_participants where id = v_lo_p for update;
  perform 1 from training.activity_participants where id = v_hi_p for update;

  select owner_scope, owner_user_id, owner_club_id, owner_team_id into v_source_owner from training.activities where id = v_source.activity_id;
  select owner_scope, owner_user_id, owner_club_id, owner_team_id into v_target_owner from training.activities where id = v_target.activity_id;
  if v_source_owner.owner_scope is distinct from v_target_owner.owner_scope or v_source_owner.owner_user_id is distinct from v_target_owner.owner_user_id
     or v_source_owner.owner_club_id is distinct from v_target_owner.owner_club_id or v_source_owner.owner_team_id is distinct from v_target_owner.owner_team_id then
    raise exception 'merge_activity_participants: source and target belong to activities in DIFFERENT owner scopes — refusing';
  end if;

  perform set_config('training.allow_participant_merge_write', 'on', true);
  update training.activity_participants
    set merge_status = 'superseded', superseded_by_participant_id = p_target_participant_id, updated_at = now()
    where id = p_source_participant_id;
  perform set_config('training.allow_participant_merge_write', 'off', true);

  -- v89 (ST-3): the merged participant's own session type ends; the canonical participant keeps its own. The exception
  -- rows come last, after the activities and the participants locked above.
  perform set_config('training.allow_participant_type_end', 'on', true);
  update training.participant_activity_types
    set ended_at = clock_timestamp(), ended_by_user_id = p_performed_by, end_cause = 'merge'
    where participant_id = p_source_participant_id and ended_at is null;
  perform set_config('training.allow_participant_type_end', 'off', true);

  insert into training.activity_participant_merge_log (source_participant_id, target_participant_id, source_activity_id, target_activity_id, reason, performed_by_user_id)
    values (p_source_participant_id, p_target_participant_id, v_source.activity_id, v_target.activity_id, p_reason, p_performed_by);

  -- If the source activity now has zero remaining CANONICAL participants,
  -- it is vestigial — supersede it too, pointing at the target's activity
  -- (same write-once/no-cycle guarantees as reparent's own version of
  -- this; both activities are already locked above, sorted, so no extra
  -- lock acquisition is needed here).
  if v_source.activity_id <> v_target.activity_id then
    select count(*) into v_remaining from training.activity_participants where activity_id = v_source.activity_id and merge_status = 'canonical';
    if v_remaining = 0 then
      perform set_config('training.allow_supersede_write', 'on', true);
      update training.activities set lifecycle_state = 'superseded', superseded_by_activity_id = v_target.activity_id, updated_at = now()
        where id = v_source.activity_id and lifecycle_state <> 'superseded';
      perform set_config('training.allow_supersede_write', 'off', true);
    end if;
  end if;

  return p_target_participant_id;
end;
$$ language plpgsql;

create or replace function training.reparent_activity_participant(
  p_participant_id uuid, p_to_activity_id uuid, p_performed_by uuid, p_reason text,
  p_component_strategy varchar default 'none', p_component_mapping jsonb default null
) returns void as $$
declare
  v_from_activity_id uuid;
  v_lo uuid; v_hi uuid;
  v_from_owner_scope varchar; v_from_owner_user uuid; v_from_owner_club uuid; v_from_owner_team uuid;
  v_to_owner_scope varchar; v_to_owner_user uuid; v_to_owner_club uuid; v_to_owner_team uuid;
  v_to_lifecycle varchar;
  v_remaining int;
  v_has_component_rows boolean;
  v_rec record;
  v_seg_rec record;
  v_mapped_id uuid;
  v_clone_id uuid;
  v_target_event_linked boolean;
  v_old_event_link_id uuid;
  v_new_event_link_id uuid;
  v_progress boolean;
  v_merge_status varchar;
  -- In-memory-only working state for the 'clone' strategy — see this
  -- function's own header comment for why these replace temp tables.
  v_seg_carryover jsonb;
  v_components_to_clone uuid[];
  v_new_parents uuid[];
  v_id_map jsonb;
  v_item jsonb;
begin
  -- Step 1: advisory-lock the participant identity FIRST. This alone is
  -- what makes every read below reliable without a peek/retry loop.
  perform pg_advisory_xact_lock(hashtextextended('activity-participant:' || p_participant_id::text, 4));

  select activity_id, merge_status into v_from_activity_id, v_merge_status from training.activity_participants where id = p_participant_id;
  if v_from_activity_id is null then
    raise exception 'activity_participant % not found', p_participant_id;
  end if;
  -- Round 4 fix: a SUPERSEDED (alias) participant must never be physically
  -- moved — its whole reason for existing is to resolve, via
  -- resolve_canonical_participant_id, to its canonical target; reparenting
  -- it directly would let the canonical result wrongly link the WRONG
  -- activities together (the alias would carry the move, but every
  -- lookup following the alias chain still lands on the canonical row,
  -- which never moved). Checked before ANY write below — zero partial
  -- writes on refusal.
  if v_merge_status <> 'canonical' then
    raise exception 'reparent_activity_participant: participant % is not canonical (merge_status=%) — resolve to its canonical id first, then reparent that', p_participant_id, v_merge_status;
  end if;
  if v_from_activity_id = p_to_activity_id then
    return; -- no-op, already there
  end if;

  -- Step 2: lock BOTH activities ascending by id.
  if v_from_activity_id < p_to_activity_id then v_lo := v_from_activity_id; v_hi := p_to_activity_id;
  else v_lo := p_to_activity_id; v_hi := v_from_activity_id; end if;
  perform 1 from training.activities where id = v_lo for update;
  perform 1 from training.activities where id = v_hi for update;

  -- Step 3: lock the participant row itself.
  perform 1 from training.activity_participants where id = p_participant_id for update;

  select owner_scope, owner_user_id, owner_club_id, owner_team_id into v_from_owner_scope, v_from_owner_user, v_from_owner_club, v_from_owner_team
    from training.activities where id = v_from_activity_id;
  select owner_scope, owner_user_id, owner_club_id, owner_team_id, lifecycle_state into v_to_owner_scope, v_to_owner_user, v_to_owner_club, v_to_owner_team, v_to_lifecycle
    from training.activities where id = p_to_activity_id;

  if v_to_lifecycle = 'superseded' then
    raise exception 'reparent_activity_participant: refusing to reparent into activity % — it is already superseded', p_to_activity_id;
  end if;
  if v_from_owner_scope is distinct from v_to_owner_scope or v_from_owner_user is distinct from v_to_owner_user
     or v_from_owner_club is distinct from v_to_owner_club or v_from_owner_team is distinct from v_to_owner_team then
    raise exception 'refusing to reparent activity_participant % across DIFFERENT owner scopes (from=%/%/%/% to=%/%/%/%)',
      p_participant_id, v_from_owner_scope, v_from_owner_club, v_from_owner_team, v_from_owner_user,
      v_to_owner_scope, v_to_owner_club, v_to_owner_team, v_to_owner_user;
  end if;

  -- Any of this participant's OWN confirmed metric-participant links must
  -- remain valid post-reparent — their event must ALREADY be confirmedly
  -- linked to the TARGET activity, or the whole operation is refused
  -- (never a silent orphan).
  for v_rec in
    select mep.event_id from training.activity_participant_metric_participant_links mpl
    join training_load.metric_event_participants mep on mep.id = mpl.metric_event_participant_id
    where mpl.activity_participant_id = p_participant_id and mpl.link_status = 'confirmed'
  loop
    select exists (
      select 1 from training.activity_metric_event_links
      where activity_id = p_to_activity_id and metric_event_id = v_rec.event_id and link_status = 'confirmed'
    ) into v_target_event_linked;
    if not v_target_event_linked then
      raise exception 'reparent_activity_participant: participant % has a CONFIRMED metric-participant link whose event (%) is not linked to the target activity — relink the event first', p_participant_id, v_rec.event_id;
    end if;
  end loop;

  select exists (select 1 from training.activity_participant_components where activity_participant_id = p_participant_id) into v_has_component_rows;
  if v_has_component_rows and p_component_strategy = 'none' then
    raise exception 'reparent_activity_participant: participant % has component performance data — pass component_strategy ''clone'' or ''map''', p_participant_id;
  end if;

  -- Pre-flight for 'clone': a metric_event can only ever be confirmedly
  -- linked to ONE activity at a time (the partial unique index on
  -- metric_event_id is global, not per-activity) — so "the target must
  -- ALREADY have the event linked" can never hold in practice; the event
  -- is always still linked to the SOURCE at this point. The correct
  -- operation is for the clone to RELINK the event itself, from source to
  -- target, as PART of carrying the segment link over — but ONLY when
  -- doing so is unambiguous: the event must have NO confirmed descendant
  -- (component-segment or participant-metric) OTHER than the exact
  -- segment link(s) this clone is about to carry over. If the event is
  -- shared with anything else, the whole reparent is refused — never a
  -- silent, semantically-wrong event relink.
  if v_has_component_rows and p_component_strategy = 'clone' then
    for v_seg_rec in
      select distinct mes.event_id
      from training.activity_participant_components pc
      join training.activity_component_metric_segment_links csl on csl.activity_component_id = pc.activity_component_id and csl.link_status = 'confirmed'
      join training_load.metric_event_segments mes on mes.id = csl.metric_event_segment_id
      where pc.activity_participant_id = p_participant_id
    loop
      declare
        v_own_segment_count int;
        v_total_segment_descendants int;
        v_total_participant_descendants int;
      begin
        select count(*) into v_own_segment_count
          from training.activity_participant_components pc
          join training.activity_component_metric_segment_links csl on csl.activity_component_id = pc.activity_component_id and csl.link_status = 'confirmed'
          join training_load.metric_event_segments mes on mes.id = csl.metric_event_segment_id
          where pc.activity_participant_id = p_participant_id and mes.event_id = v_seg_rec.event_id;
        select count(*) into v_total_segment_descendants
          from training.activity_component_metric_segment_links csl
          join training_load.metric_event_segments mes on mes.id = csl.metric_event_segment_id
          where mes.event_id = v_seg_rec.event_id and csl.link_status = 'confirmed';
        select count(*) into v_total_participant_descendants
          from training.activity_participant_metric_participant_links mpl
          join training_load.metric_event_participants mep on mep.id = mpl.metric_event_participant_id
          where mep.event_id = v_seg_rec.event_id and mpl.link_status = 'confirmed';
        if v_total_segment_descendants <> v_own_segment_count or v_total_participant_descendants <> 0 then
          raise exception 'reparent_activity_participant: metric event % has OTHER confirmed data depending on it besides this participant''s own component(s) — refusing to relink it automatically; use component_strategy ''map'' and relink manually', v_seg_rec.event_id;
        end if;
      end;
    end loop;
  end if;

  -- The participant row itself moves FIRST — activity_participant_components'
  -- own composite FK to (activity_participants.id, activity_id) requires a
  -- matching participant row at the TARGET activity to already exist before
  -- any junction row can be repointed at it below.
  perform set_config('training.allow_reparent_write', 'on', true);
  update training.activity_participants set activity_id = p_to_activity_id, updated_at = now() where id = p_participant_id;
  perform set_config('training.allow_reparent_write', 'off', true);

  -- v89 (ST-3): the participant's own session type belonged to the session it left: it ends. The exception rows come
  -- last, after the activities and the participant locked above.
  perform set_config('training.allow_participant_type_end', 'on', true);
  update training.participant_activity_types
    set ended_at = clock_timestamp(), ended_by_user_id = p_performed_by, end_cause = 'reparent'
    where participant_id = p_participant_id and ended_at is null;
  perform set_config('training.allow_participant_type_end', 'off', true);

  if v_has_component_rows then
    perform set_config('training.allow_component_repoint', 'on', true);
    if p_component_strategy = 'clone' then
      v_seg_carryover := '[]'::jsonb;
      select coalesce(array_agg(distinct activity_component_id), '{}') into v_components_to_clone
        from training.activity_participant_components where activity_participant_id = p_participant_id;
      v_id_map := '{}'::jsonb;

      for v_rec in
        select pc.activity_component_id as old_component_id, csl.id as old_link_id, csl.metric_event_segment_id as segment_id
        from training.activity_participant_components pc
        join training.activity_component_metric_segment_links csl on csl.activity_component_id = pc.activity_component_id and csl.link_status = 'confirmed'
        where pc.activity_participant_id = p_participant_id
      loop
        v_seg_carryover := v_seg_carryover || jsonb_build_object('old_component_id', v_rec.old_component_id, 'old_link_id', v_rec.old_link_id, 'segment_id', v_rec.segment_id);
      end loop;

      -- Supersede EXACTLY the captured links (bulk, by id — never a
      -- fragile status-based re-query) — this is what unblocks the event
      -- relink below (the "no orphan descendants" trigger fires
      -- immediately, not deferred, and sees zero confirmed descendants
      -- once these are gone).
      if jsonb_array_length(v_seg_carryover) > 0 then
        update training.activity_component_metric_segment_links set link_status = 'superseded'
          where id in (select (elem ->> 'old_link_id')::uuid from jsonb_array_elements(v_seg_carryover) elem);
      end if;

      for v_seg_rec in
        select distinct mes.event_id
        from jsonb_array_elements(v_seg_carryover) elem
        join training_load.metric_event_segments mes on mes.id = (elem ->> 'segment_id')::uuid
      loop
        update training.activity_metric_event_links set link_status = 'superseded'
          where activity_id = v_from_activity_id and metric_event_id = v_seg_rec.event_id and link_status = 'confirmed'
          returning id into v_old_event_link_id;
        insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status, confirmed_by_user_id, confirmed_at, supersedes_link_id, reason, created_by_user_id)
          values (p_to_activity_id, v_seg_rec.event_id, 'automatic', 'confirmed', p_performed_by, now(), v_old_event_link_id, 'relinked as part of reparent clone strategy', p_performed_by)
          returning id into v_new_event_link_id;
        update training.activity_metric_event_links set superseded_by_link_id = v_new_event_link_id where id = v_old_event_link_id;
      end loop;

      -- Full component set to clone: every LEAF the participant directly
      -- performed, plus every ancestor of each, walked to the root — a
      -- plain PL/pgSQL array used as a set (dedup via NOT ... = ANY(...)).
      loop
        select array_agg(distinct ac.parent_component_id) into v_new_parents
          from training.activity_components ac
          where ac.id = any(v_components_to_clone)
            and ac.parent_component_id is not null
            and not (ac.parent_component_id = any(v_components_to_clone));
        exit when v_new_parents is null;
        v_components_to_clone := v_components_to_clone || v_new_parents;
      end loop;

      -- Clone ancestor-first: a component is processed only once its own
      -- parent is already in the map (or has none) — a real topological
      -- pass, not a flat one, so parent_component_id on each clone points
      -- at the CORRESPONDING new clone, never NULL.
      loop
        v_progress := false;
        for v_rec in
          select ac.id, ac.parent_component_id, ac.component_type_key, ac.exercise_id, ac.name_snapshot, ac.image_url_snapshot, ac.instructions_snapshot,
                 ac.planned_prescription_snapshot, ac.planned_prescription_snapshot_version, ac.sort_order, ac.planned_duration_seconds, ac.origin
          from training.activity_components ac
          where ac.id = any(v_components_to_clone)
            and not (v_id_map ? ac.id::text)
            and (ac.parent_component_id is null or v_id_map ? ac.parent_component_id::text)
        loop
          insert into training.activity_components (activity_id, parent_component_id, component_type_key, exercise_id, name_snapshot, image_url_snapshot, instructions_snapshot, planned_prescription_snapshot, planned_prescription_snapshot_version, sort_order, planned_duration_seconds, origin)
            values (
              p_to_activity_id,
              case when v_rec.parent_component_id is null then null else (v_id_map ->> v_rec.parent_component_id::text)::uuid end,
              v_rec.component_type_key, v_rec.exercise_id, v_rec.name_snapshot, v_rec.image_url_snapshot, v_rec.instructions_snapshot,
              v_rec.planned_prescription_snapshot, v_rec.planned_prescription_snapshot_version, v_rec.sort_order, v_rec.planned_duration_seconds, v_rec.origin
            )
            returning id into v_clone_id;
          v_id_map := v_id_map || jsonb_build_object(v_rec.id::text, v_clone_id::text);
          v_progress := true;
        end loop;
        exit when not v_progress;
      end loop;

      -- Repoint the participant's own junction rows at the LEAF clones.
      for v_rec in select id, activity_component_id from training.activity_participant_components where activity_participant_id = p_participant_id loop
        update training.activity_participant_components
          set activity_component_id = (v_id_map ->> v_rec.activity_component_id::text)::uuid, activity_id = p_to_activity_id
          where id = v_rec.id;
      end loop;

      -- New confirmed segment links, driven by the EXACT captured tuples
      -- (never a re-derived query) — each pointing at its leaf's own clone.
      for v_item in select * from jsonb_array_elements(v_seg_carryover) loop
        insert into training.activity_component_metric_segment_links (activity_component_id, metric_event_segment_id, link_method, link_status, confirmed_by_user_id, confirmed_at, supersedes_link_id, reason, created_by_user_id)
          values ((v_id_map ->> (v_item ->> 'old_component_id'))::uuid, (v_item ->> 'segment_id')::uuid, 'automatic', 'confirmed', p_performed_by, now(), (v_item ->> 'old_link_id')::uuid, 'carried over by reparent clone strategy', p_performed_by)
          returning id into v_mapped_id;
        update training.activity_component_metric_segment_links set superseded_by_link_id = v_mapped_id where id = (v_item ->> 'old_link_id')::uuid;
      end loop;
    elsif p_component_strategy = 'map' then
      for v_rec in select id, activity_component_id from training.activity_participant_components where activity_participant_id = p_participant_id loop
        -- Round 4 fix: the service layer (trainingActivityMaterialize.js's
        -- reparentActivityParticipant) now validates component_mapping's
        -- shape (plain object, every key/value a real UUID string) BEFORE
        -- this function is ever called — this cast is a second, defensive
        -- line of DB-level protection for any future/raw caller that
        -- bypasses the service layer, so a malformed value here raises a
        -- clear, named exception instead of a bare, confusing Postgres
        -- 22P02 (invalid_text_representation).
        begin
          v_mapped_id := (p_component_mapping ->> v_rec.activity_component_id::text)::uuid;
        exception when invalid_text_representation then
          raise exception 'reparent_activity_participant: component_mapping entry for source component % is not a valid UUID', v_rec.activity_component_id;
        end;
        if v_mapped_id is null then
          raise exception 'reparent_activity_participant: component_mapping has no entry for source component %', v_rec.activity_component_id;
        end if;
        perform 1 from training.activity_components where id = v_mapped_id and activity_id = p_to_activity_id;
        if not found then
          raise exception 'reparent_activity_participant: mapped component % does not belong to target activity %', v_mapped_id, p_to_activity_id;
        end if;
        update training.activity_participant_components set activity_component_id = v_mapped_id, activity_id = p_to_activity_id where id = v_rec.id;
      end loop;
    else
      perform set_config('training.allow_component_repoint', 'off', true);
      raise exception 'reparent_activity_participant: unknown component_strategy %', p_component_strategy;
    end if;
    perform set_config('training.allow_component_repoint', 'off', true);
  end if;

  insert into training.activity_participant_reparent_log (activity_participant_id, from_activity_id, to_activity_id, component_strategy, reason, performed_by_user_id)
    values (p_participant_id, v_from_activity_id, p_to_activity_id, p_component_strategy, p_reason, p_performed_by);

  select count(*) into v_remaining from training.activity_participants where activity_id = v_from_activity_id and merge_status = 'canonical';
  if v_remaining = 0 then
    perform set_config('training.allow_supersede_write', 'on', true);
    update training.activities set lifecycle_state = 'superseded', superseded_by_activity_id = p_to_activity_id, updated_at = now()
      where id = v_from_activity_id;
    perform set_config('training.allow_supersede_write', 'off', true);
  end if;
end;
$$ language plpgsql;

do $$
declare
  expected constant text[][] := array[
    ['merge_activity_participants', '8b7fb19320c8d16071a02d765438f1e2'],
    ['reparent_activity_participant', '7563c29ddae3f5508dbeff1780a2d89e']];
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training' and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v89 refused: the new body of training.% is not the expected one', expected[i][1] using errcode = '23514';
    end if;
  end loop;
end $$;

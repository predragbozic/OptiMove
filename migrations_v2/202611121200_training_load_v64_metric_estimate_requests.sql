-- Training Load v64 - the request key of an estimate save, and an estimate participant's time zone (phase 5b, 6b-B).
--
-- Contract: docs/ai/phase5b-estimates-contract.md (6b-B, with the Rukovodilac's GO of 2026-11-12, Q1 (a) and Q2 (a)).
-- Runbook: docs/runbooks/metric-value-estimates-v64.md.
--
-- What this migration changes (no existing row changes; nothing is written to a table):
--   1. training_load.metric_value_estimates gets request_key (uuid) and request_hash (64 hex), both NOT NULL. Every row of one
--      save carries the same key and hash; the service answers a repeated key from these rows (the replay), and a key used
--      with another hash is request_key_reused. A plain index on (estimated_by_user_id, request_key) serves that lookup.
--      The table must be empty (6b-B is the first writer), so the columns need no default.
--   2. The provenance guard (v63's validate_metric_value_estimate, replaced under an md5 gate) also refuses a row whose
--      (author, key) is already used with another hash, under a transaction-scoped advisory lock of that (author, key)
--      (seed 64; the save takes the same lock before its replay read).
--   3. v12's protect_participant_identity_once_measured (replaced under an md5 gate): a participant's
--      athlete_timezone_snapshot may change after measurements exist only when every occasion of that participant is an
--      estimate occasion (effective or superseded) with no source identity, and nothing else of the row changes. An
--      estimate participant is created in the event's zone; a later import of that athlete brings the athlete's own zone,
--      and the import writer re-snapshots it under the same condition (gpexeImportWriter.ensureParticipants). A
--      participant with any real occasion keeps v12's rule unchanged.
--   4. v1's protect_participant_identity_once_linked (replaced under an md5 gate): the linked activity participant follows
--      that re-snapshot in the same transaction - its timezone_snapshot and local_date may change only to the new zone and
--      to the day materialize_activity_group_from_metric_event computes in it, only while it is canonical, no alias, with
--      no session link or component, and every linked metric participant is in that zone and holds estimate occasions only
--      with no source identity. So a re-snapshot ends with both layers equal to a direct import's rows.
--
-- Order: after v63. This migration refuses to run without v63's table, or while that table holds a row.
-- Rollback: docs/runbooks/metric-value-estimates-v64-rollback.sql (refuses once a provenance row exists, or a later
-- migration is recorded).

-- ---------------------------------------------------------------------------
-- 0. Preconditions
-- ---------------------------------------------------------------------------
do $$
declare
  expected text[][] := array[
    array['training_load', 'protect_participant_identity_once_measured', '8c56c9950666a874f1fb5c464aa47e58'],
    array['training_load', 'validate_metric_value_estimate', 'fa6e027caca7ea8dfc28f624d81b0e96'],
    array['training', 'protect_participant_identity_once_linked', '4a77025e17227d8efd1408676e461400']
  ];
  i integer;
begin
  if to_regclass('training_load.metric_value_estimates') is null then
    raise exception 'v64 refused: v63 (metric_value_estimates) is not applied' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.metric_value_estimates) then
    raise exception 'v64 refused: metric_value_estimates already holds a row' using errcode = '23514';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'metric_value_estimates'
              and column_name in ('request_key', 'request_hash')) then
    raise exception 'v64 refused: the request columns already exist' using errcode = '23514';
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2]) <> 1 then
      raise exception 'v64 refused: %.% must exist exactly once', expected[i][1], expected[i][2] using errcode = '23514';
    end if;
    if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2]) is distinct from expected[i][3] then
      raise exception 'v64 refused: the body in force of %.% is not the expected one', expected[i][1], expected[i][2] using errcode = '23514';
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The request key of a save
-- ---------------------------------------------------------------------------
alter table training_load.metric_value_estimates
  add column request_key uuid not null,
  add column request_hash text not null constraint metric_value_estimates_request_hash_shape check (request_hash ~ '^[0-9a-f]{64}$');
create index metric_value_estimates_request_idx on training_load.metric_value_estimates (estimated_by_user_id, request_key);

-- ---------------------------------------------------------------------------
-- 2. The provenance guard: v63's checks, and one hash per (author, key)
-- ---------------------------------------------------------------------------
create or replace function training_load.validate_metric_value_estimate() returns trigger as $$
declare
  v_val record;
begin
  select v.occasion_id, o.entry_method, o.recorded_by_user_id, dv.daily_aggregation_method
    into v_val
    from training_load.metric_values v
    join training_load.metric_measurement_occasions o on o.id = v.occasion_id
    join training_load.metric_definition_versions dv on dv.id = v.metric_definition_version_id
   where v.id = new.metric_value_id;
  if not found or v_val.entry_method is distinct from 'estimate' or v_val.occasion_id is distinct from new.occasion_id then
    raise exception 'estimate: the provenance row belongs to an estimated value of its occasion' using errcode = '23514';
  end if;
  if new.estimated_by_user_id is distinct from v_val.recorded_by_user_id
     or new.estimated_by_user_id is distinct from training_load.estimate_context_actor() then
    raise exception 'estimate: the author must be the acting user' using errcode = '42501';
  end if;
  if not (v_val.daily_aggregation_method = 'sum'
          or (v_val.daily_aggregation_method = 'avg' and new.method in ('copy_athlete', 'team_average'))) then
    raise exception 'estimate: this method is not allowed for this variable' using errcode = '23514';
  end if;
  -- v64: one request key names one request. The (author, key) lock serialises two saves of one key (two teams' sessions
  -- at once, where the team lock does not serialise them); the check below then reads in a new snapshot.
  perform pg_advisory_xact_lock(hashtextextended('estimate-request:' || new.estimated_by_user_id::text || ':' || new.request_key::text, 64));
  if exists (select 1 from training_load.metric_value_estimates e
              where e.estimated_by_user_id = new.estimated_by_user_id and e.request_key = new.request_key
                and e.request_hash is distinct from new.request_hash) then
    raise exception 'estimate: a request key names one request' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 3. An estimate participant's time zone
-- ---------------------------------------------------------------------------
create or replace function training_load.protect_participant_identity_once_measured() returns trigger as $$
declare
  has_measurements boolean;
begin
  if new.event_id is not distinct from old.event_id
     and new.athlete_id is not distinct from old.athlete_id
     and new.athlete_timezone_snapshot is not distinct from old.athlete_timezone_snapshot
     and new.logical_session_id is not distinct from old.logical_session_id
     and new.external_assignment_id is not distinct from old.external_assignment_id
     and new.linked_session_name_snapshot is not distinct from old.linked_session_name_snapshot
     and new.linked_plan_name_snapshot is not distinct from old.linked_plan_name_snapshot then
    return new;
  end if;
  -- v64: only the time zone changes, and every occasion of the participant is an estimate (effective or superseded) with
  -- no source identity: an estimate participant takes the athlete's own zone when the athlete's real data arrives.
  if new.event_id is not distinct from old.event_id
     and new.athlete_id is not distinct from old.athlete_id
     and new.logical_session_id is not distinct from old.logical_session_id
     and new.external_assignment_id is not distinct from old.external_assignment_id
     and new.linked_session_name_snapshot is not distinct from old.linked_session_name_snapshot
     and new.linked_plan_name_snapshot is not distinct from old.linked_plan_name_snapshot
     and new.athlete_timezone_snapshot is not null
     and not exists (select 1 from training_load.metric_measurement_occasions o
                      where o.event_participant_id = old.id
                        and (o.entry_method is distinct from 'estimate' or o.source_identity_id is not null)) then
    return new;
  end if;
  select exists (select 1 from training_load.metric_measurement_occasions where event_participant_id = old.id) into has_measurements;
  if has_measurements then
    raise exception 'metric_event_participants (id=%) has dependent measurements: identity/snapshot fields are immutable', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 4. The linked activity participant follows the re-snapshot
-- ---------------------------------------------------------------------------
create or replace function training.protect_participant_identity_once_linked() returns trigger as $$
declare
  is_load_bearing boolean;
begin
  if new.athlete_id is not distinct from old.athlete_id
     and new.timezone_snapshot is not distinct from old.timezone_snapshot
     and new.local_date is not distinct from old.local_date then
    -- fall through to the merge-status/activity_id write-once checks below
    null;
  else
    -- v64 (6b-B, Q2): an estimate participant's activity participant follows its metric participant's re-snapshot. Only the
    -- zone and the day change, to exactly what materialize_activity_group_from_metric_event computes for that zone, and
    -- every linked metric participant is already in the new zone and holds estimate occasions only, with no source identity.
    if new.athlete_id is not distinct from old.athlete_id
       and new.activity_id is not distinct from old.activity_id
       and new.timezone_snapshot is not null and new.local_date is not null
       and old.merge_status = 'canonical' and new.merge_status is not distinct from old.merge_status
       and old.superseded_by_participant_id is null and new.superseded_by_participant_id is null
       and not exists (select 1 from training.activity_participant_session_links where activity_participant_id = old.id)
       and not exists (select 1 from training.activity_participant_components where activity_participant_id = old.id)
       and not exists (select 1 from training.activity_participants where superseded_by_participant_id = old.id)
       and exists (select 1 from training.activity_participant_metric_participant_links where activity_participant_id = old.id)
       and not exists (
             select 1 from training.activity_participant_metric_participant_links l
               join training_load.metric_event_participants mp on mp.id = l.metric_event_participant_id
               join training_load.metric_events e on e.id = mp.event_id
              where l.activity_participant_id = old.id
                and (mp.athlete_timezone_snapshot is distinct from new.timezone_snapshot
                     or new.local_date is distinct from coalesce((e.occurred_instant at time zone new.timezone_snapshot)::date, e.occurred_date)))
       and not exists (
             select 1 from training.activity_participant_metric_participant_links l
               join training_load.metric_measurement_occasions o on o.event_participant_id = l.metric_event_participant_id
              where l.activity_participant_id = old.id
                and (o.entry_method is distinct from 'estimate' or o.source_identity_id is not null)) then
      return new;
    end if;
    select
      exists (select 1 from training.activity_participant_session_links where activity_participant_id = old.id)
      or exists (select 1 from training.activity_participant_metric_participant_links where activity_participant_id = old.id)
      or exists (select 1 from training.activity_participant_components where activity_participant_id = old.id)
      or old.merge_status = 'superseded'
      or exists (select 1 from training.activity_participants where superseded_by_participant_id = old.id)
      into is_load_bearing;
    if is_load_bearing then
      raise exception 'training.activity_participants (id=%): athlete_id/timezone_snapshot/local_date are immutable once load-bearing (linked, itself an alias, or the target of an incoming alias) — reparent the ACTIVITY instead, never the athlete identity', old.id;
    end if;
  end if;

  -- activity_id may only be changed by reparent_activity_participant()
  -- (v4), gated behind the same session-local GUC every other
  -- sanctioned-function-only field in this schema uses.
  if new.activity_id is distinct from old.activity_id
     and current_setting('training.allow_reparent_write', true) is distinct from 'on' then
    raise exception 'training.activity_participants (id=%): activity_id may only be changed by reparent_activity_participant()', old.id;
  end if;

  if old.superseded_by_participant_id is not null and new.superseded_by_participant_id is distinct from old.superseded_by_participant_id then
    raise exception 'training.activity_participants (id=%): superseded_by_participant_id is write-once', old.id;
  end if;
  if new.superseded_by_participant_id is not null and old.superseded_by_participant_id is null
     and current_setting('training.allow_participant_merge_write', true) is distinct from 'on' then
    raise exception 'training.activity_participants (id=%): superseded_by_participant_id may only be set by merge_activity_participants()', old.id;
  end if;
  if new.merge_status is distinct from old.merge_status
     and current_setting('training.allow_participant_merge_write', true) is distinct from 'on' then
    raise exception 'training.activity_participants (id=%): merge_status may only be changed by merge_activity_participants()', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

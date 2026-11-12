-- Training Load v63 - estimated values for an athlete without GPS data (phase 5b, 6b-A).
--
-- Contract: docs/ai/phase5b-estimates-contract.md (accepted with the Rukovodilac's corrections, 2026-11-12). Owner's answers:
-- a capture kind of its own with a provenance table; written after the import only; dashboards leave estimates out by
-- default; the undo removes and logs them and they never block; the J20-C audience. Runbook:
-- docs/runbooks/metric-value-estimates-v63.md.
--
-- What this migration changes (no existing row changes; nothing is written to a table):
--   1. metric_measurement_occasions.entry_method also takes 'estimate' (the CHECK is replaced; the column stays frozen
--      after insert, v13).
--   2. training_load.metric_value_estimates: one provenance row per estimated value - the method (proportional,
--      copy_athlete, team_average), the basis in a closed shape per method, the author, the time and an optional note.
--      Append-only; a DELETE only inside the session undo's own transaction (v57's marker).
--   3. Guards (fixed messages, 23514 / 42501):
--      - an 'estimate' occasion: whole-session level, no source identity, no import batch, no conflict status, its author
--        is the transaction's acting user (optimove.estimate_actor = '<user uuid>:<xact id>', set by the service);
--      - a value of an 'estimate' occasion: the occasion's only value; numeric; is_derived = false, standalone,
--        not_applicable, no computed_by_ref (M1: an estimate is recognised by its occasion's entry_method only);
--        refused while an effective measured whole-session value of the same variable exists for the same participant
--        (M2: estimate_measured_exists); it must have its provenance row by COMMIT (deferred);
--      - a provenance row: of that value and occasion, by the occasion's author; the method allowed by the variable's
--        daily aggregation (sum: every method; avg: copy_athlete and team_average; max, last, none: never).
--   4. M3: when a whole-session value is inserted - measured and effective, or another estimate - the effective estimate
--      occasion of the same participant holding the same variable is superseded by the new occasion
--      (superseded_by_occasion_id). Every reader of effective values already filters on that column. Lock order: the
--      insert has already locked the participant and the event (v13's occasion trigger); the update locks the estimate
--      occasion's row; the import and the estimate save both take the team's import lock first. v13 leaves an occasion's
--      revision fields updatable by any path; for an estimate occasion a guard narrows them: superseded once, only by a
--      whole-session occasion of the same participant that is effective and holds the same variable, never a conflict
--      status. An estimate occasion holds exactly one value by COMMIT.
--   5. The dashboards' series source_policy CHECK also takes 'estimate' (the policy that shows estimates; 6b-D leaves them
--      out under every other policy).
--   6. The session undo (v60's two bodies, replaced under an md5 gate): the scope counts estimateOccasionCount and
--      estimateValueCount; the undo deletes the provenance rows before the values and records metric_value_estimates in
--      removed_counts. Estimates never block. Signatures and everything else unchanged.
--
-- Order: after v62 (#493). This migration refuses to run without v62's table.
-- Rollback: docs/runbooks/metric-value-estimates-v63-rollback.sql (refuses once an estimate occasion or provenance row
-- exists, or a later migration is recorded).

-- ---------------------------------------------------------------------------
-- 0. Preconditions: v62 is in place, and the bodies this migration replaces are v60's.
-- ---------------------------------------------------------------------------
do $$
declare
  expected text[][] := array[
    array['training_load', 'session_undo_scope', 'b6f34358816e7ae382f1385b650b95f0'],
    array['training_load', 'undo_imported_session', '3d78cc86dfa3be3c25d2cb0dc0a858e0']
  ];
  i integer;
begin
  if to_regclass('training_load.gpexe_team_session_timezones') is null then
    raise exception 'v63 refused: v62 (the team session time zone) is not applied' using errcode = '23514';
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2]) <> 1 then
      raise exception 'v63 refused: %.% must exist exactly once', expected[i][1], expected[i][2] using errcode = '23514';
    end if;
    if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2]) is distinct from expected[i][3] then
      raise exception 'v63 refused: the body in force of %.% is not v60''s', expected[i][1], expected[i][2] using errcode = '23514';
    end if;
  end loop;
  if (select count(*) from pg_constraint where conrelid = 'training_load.metric_measurement_occasions'::regclass
       and contype = 'c' and pg_get_constraintdef(oid) like '%entry_method%') <> 1 then
    raise exception 'v63 refused: exactly one entry_method CHECK is expected' using errcode = '23514';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'training_load.dashboard_widget_series'::regclass
       and contype = 'c' and pg_get_constraintdef(oid) like '%source_policy%all_with_conflicts%') <> 1 then
    raise exception 'v63 refused: exactly one source_policy CHECK is expected' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The capture kind
-- ---------------------------------------------------------------------------
do $$
declare
  c text;
begin
  select conname into c from pg_constraint where conrelid = 'training_load.metric_measurement_occasions'::regclass
    and contype = 'c' and pg_get_constraintdef(oid) like '%entry_method%';
  execute format('alter table training_load.metric_measurement_occasions drop constraint %I', c);
end;
$$;
alter table training_load.metric_measurement_occasions
  add constraint metric_measurement_occasions_entry_method_check
  check (entry_method in ('manual', 'api_import', 'csv_import', 'estimate'));

-- ---------------------------------------------------------------------------
-- 2. The acting user of an estimate write
-- ---------------------------------------------------------------------------
create function training_load.estimate_context_actor() returns uuid as $$
declare
  raw text := current_setting('optimove.estimate_actor', true);
begin
  if raw is null
     or raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,20}$'
     or split_part(raw, ':', 2) is distinct from pg_current_xact_id()::text then
    raise exception 'estimate: no acting user is set for this transaction' using errcode = '42501';
  end if;
  return split_part(raw, ':', 1)::uuid;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 3. The provenance table
-- ---------------------------------------------------------------------------
-- The basis, a closed shape per method (contract section 3, the discovery's section 5).
create function training_load.estimate_basis_ok(p_method text, p_basis jsonb) returns boolean as $$
  select case p_method
    when 'proportional' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['minutes', 'ratePerMinute', 'sessions']
      and jsonb_typeof(p_basis -> 'minutes') = 'number' and (p_basis ->> 'minutes')::numeric > 0 and (p_basis ->> 'minutes')::numeric <= 1440
      and jsonb_typeof(p_basis -> 'ratePerMinute') = 'number' and (p_basis ->> 'ratePerMinute')::numeric >= 0
      and jsonb_typeof(p_basis -> 'sessions') = 'number' and (p_basis ->> 'sessions') ~ '^[0-9]{1,3}$' and (p_basis ->> 'sessions')::int between 3 and 5
    when 'copy_athlete' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['sourceAthleteId']
      and jsonb_typeof(p_basis -> 'sourceAthleteId') = 'string'
      and (p_basis ->> 'sourceAthleteId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    when 'team_average' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['athletes']
      and jsonb_typeof(p_basis -> 'athletes') = 'number' and (p_basis ->> 'athletes') ~ '^[0-9]{1,4}$' and (p_basis ->> 'athletes')::int >= 3
    else false
  end;
$$ language sql immutable;

create table training_load.metric_value_estimates (
  id uuid primary key default gen_random_uuid(),
  metric_value_id uuid not null unique references training_load.metric_values(id) on delete restrict,
  occasion_id uuid not null references training_load.metric_measurement_occasions(id) on delete restrict,
  method varchar(20) not null check (method in ('proportional', 'copy_athlete', 'team_average')),
  basis jsonb not null,
  estimated_by_user_id uuid not null references public.users(id) on delete restrict,
  estimated_at timestamptz not null default clock_timestamp(),
  note text check (note is null or (char_length(note) between 1 and 500 and note = btrim(note))),
  constraint metric_value_estimates_basis_shape check (training_load.estimate_basis_ok(method, basis))
);
create index metric_value_estimates_occasion_idx on training_load.metric_value_estimates (occasion_id);

-- ---------------------------------------------------------------------------
-- 4. The guards
-- ---------------------------------------------------------------------------
-- An estimate occasion: whole session, nothing of a source, by the acting user.
create function training_load.validate_estimate_occasion() returns trigger as $$
begin
  if new.entry_method is distinct from 'estimate' then
    return new;
  end if;
  if new.segment_id is not null or new.source_identity_id is not null or new.import_batch_id is not null
     or new.row_number is not null or new.import_conflict_status is not null or new.content_hash is not null
     or new.source_reported_at is not null or new.supersedes_occasion_id is not null or new.superseded_by_occasion_id is not null then
    raise exception 'estimate: an estimate occasion is a whole-session occasion of its own, with nothing of a source' using errcode = '23514';
  end if;
  if new.recorded_by_user_id is null or new.recorded_by_user_id is distinct from training_load.estimate_context_actor() then
    raise exception 'estimate: the author must be the acting user' using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger metric_measurement_occasions_estimate_guard
  before insert on training_load.metric_measurement_occasions
  for each row execute function training_load.validate_estimate_occasion();

-- An effective measured whole-session value of the variable for the participant (M2).
create function training_load.estimate_measured_exists(p_participant uuid, p_definition uuid) returns boolean as $$
  select exists (
    select 1 from training_load.metric_measurement_occasions o
      join training_load.metric_values v on v.occasion_id = o.id
     where o.event_participant_id = p_participant and v.metric_definition_id = p_definition
       and o.entry_method in ('api_import', 'csv_import') and o.segment_id is null
       and o.superseded_by_occasion_id is null and o.import_conflict_status is null
       and (o.source_identity_id is null or exists (
             select 1 from training_load.metric_source_identities si where si.id = o.source_identity_id and si.current_occasion_id = o.id)));
$$ language sql stable;

create function training_load.validate_estimate_value() returns trigger as $$
declare
  v_occ record;
  v_agg text;
  v_type text;
begin
  select o.entry_method, o.event_participant_id into v_occ from training_load.metric_measurement_occasions o where o.id = new.occasion_id;
  if v_occ.entry_method is distinct from 'estimate' then
    return new;
  end if;
  select dv.value_type, dv.daily_aggregation_method into v_type, v_agg
    from training_load.metric_definition_versions dv where dv.id = new.metric_definition_version_id;
  if v_type is distinct from 'numeric' or v_agg not in ('sum', 'avg') then
    raise exception 'estimate: this variable cannot be estimated' using errcode = '23514';
  end if;
  if new.is_derived or new.aggregation_role is distinct from 'standalone' or new.coverage is distinct from 'not_applicable'
     or new.computed_by_ref is not null then
    raise exception 'estimate: an estimated value is a standalone, non-derived value' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.metric_values x where x.occasion_id = new.occasion_id) then
    raise exception 'estimate: an estimate occasion holds one value' using errcode = '23514';
  end if;
  if training_load.estimate_measured_exists(v_occ.event_participant_id, new.metric_definition_id) then
    raise exception 'estimate_measured_exists' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger metric_values_estimate_guard
  before insert on training_load.metric_values
  for each row execute function training_load.validate_estimate_value();

-- Every estimated value has its provenance row by COMMIT.
create function training_load.check_estimate_has_provenance() returns trigger as $$
begin
  if exists (select 1 from training_load.metric_measurement_occasions o where o.id = new.occasion_id and o.entry_method = 'estimate')
     and not exists (select 1 from training_load.metric_value_estimates e where e.metric_value_id = new.id) then
    raise exception 'estimate: an estimated value needs its provenance row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;
create constraint trigger metric_values_estimate_provenance
  after insert on training_load.metric_values
  deferrable initially deferred
  for each row execute function training_load.check_estimate_has_provenance();

-- An estimate occasion holds exactly one value by COMMIT (an empty one would be noise in the undo's counts).
create function training_load.check_estimate_occasion_has_value() returns trigger as $$
begin
  if exists (select 1 from training_load.metric_measurement_occasions o where o.id = new.id and o.entry_method = 'estimate')
     and (select count(*) from training_load.metric_values v where v.occasion_id = new.id) <> 1 then
    raise exception 'estimate: an estimate occasion holds one value' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;
create constraint trigger metric_measurement_occasions_estimate_value
  after insert on training_load.metric_measurement_occasions
  deferrable initially deferred
  for each row when (new.entry_method = 'estimate') execute function training_load.check_estimate_occasion_has_value();

-- The provenance row: of that value and occasion, by its author, with a method the variable allows.
create function training_load.validate_metric_value_estimate() returns trigger as $$
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
  return new;
end;
$$ language plpgsql;
create trigger metric_value_estimates_validate
  before insert on training_load.metric_value_estimates
  for each row execute function training_load.validate_metric_value_estimate();

-- Append-only; a DELETE only inside the session undo's own transaction.
create function training_load.protect_metric_value_estimates() returns trigger as $$
begin
  if tg_op = 'DELETE' and training_load.session_undo_marker_ok() then
    return old;
  end if;
  raise exception 'metric_value_estimates is append-only' using errcode = '23514';
end;
$$ language plpgsql;
create trigger metric_value_estimates_protect
  before update or delete on training_load.metric_value_estimates
  for each row execute function training_load.protect_metric_value_estimates();
create trigger metric_value_estimates_no_truncate
  before truncate on training_load.metric_value_estimates
  for each statement execute function training_load.forbid_update_delete();

-- ---------------------------------------------------------------------------
-- 5. M3: a later whole-session value of the variable supersedes the estimate
-- ---------------------------------------------------------------------------
create function training_load.supersede_estimate_on_value() returns trigger as $$
declare
  v_new record;
begin
  select o.event_participant_id, o.entry_method, o.segment_id, o.superseded_by_occasion_id, o.import_conflict_status
    into v_new from training_load.metric_measurement_occasions o where o.id = new.occasion_id;
  if v_new.segment_id is not null or v_new.superseded_by_occasion_id is not null or v_new.import_conflict_status is not null
     or v_new.entry_method not in ('api_import', 'csv_import', 'estimate') then
    return null;
  end if;
  update training_load.metric_measurement_occasions o
     set superseded_by_occasion_id = new.occasion_id
   where o.event_participant_id = v_new.event_participant_id
     and o.entry_method = 'estimate' and o.superseded_by_occasion_id is null and o.id <> new.occasion_id
     and exists (select 1 from training_load.metric_values x where x.occasion_id = o.id and x.metric_definition_id = new.metric_definition_id);
  return null;
end;
$$ language plpgsql;
create trigger metric_values_supersede_estimate
  after insert on training_load.metric_values
  for each row execute function training_load.supersede_estimate_on_value();

-- v13 leaves the revision fields of an occasion updatable by any path (corrections set them; only identity and content are
-- frozen, v13:134-148). For an estimate occasion this narrows them: it is superseded once, and only by a whole-session
-- occasion of the same participant (a measured, effective one, or another estimate) that holds a value of the same
-- variable; its conflict status stays null.
create function training_load.guard_estimate_occasion_revision() returns trigger as $$
declare
  v_by record;
begin
  if old.entry_method is distinct from 'estimate' then
    return new;
  end if;
  if new.import_conflict_status is not null or new.supersedes_occasion_id is distinct from old.supersedes_occasion_id then
    raise exception 'estimate: an estimate occasion has no conflict status and supersedes nothing' using errcode = '23514';
  end if;
  if new.superseded_by_occasion_id is not distinct from old.superseded_by_occasion_id then
    return new;
  end if;
  if old.superseded_by_occasion_id is not null then
    raise exception 'estimate: an estimate is superseded once' using errcode = '23514';
  end if;
  select o.event_participant_id, o.segment_id, o.entry_method, o.import_conflict_status, o.superseded_by_occasion_id into v_by
    from training_load.metric_measurement_occasions o where o.id = new.superseded_by_occasion_id;
  -- The superseding occasion is effective and holds a value of the same variable (M3: only the same variable's later value).
  if not found or new.superseded_by_occasion_id = old.id or v_by.event_participant_id is distinct from old.event_participant_id
     or v_by.segment_id is not null or v_by.import_conflict_status is not null or v_by.superseded_by_occasion_id is not null
     or v_by.entry_method not in ('api_import', 'csv_import', 'estimate')
     or not exists (select 1 from training_load.metric_values e
                      join training_load.metric_values b on b.metric_definition_id = e.metric_definition_id
                     where e.occasion_id = old.id and b.occasion_id = new.superseded_by_occasion_id) then
    raise exception 'estimate: an estimate is superseded only by a whole-session value of the same athlete' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger metric_measurement_occasions_estimate_revision
  before update on training_load.metric_measurement_occasions
  for each row execute function training_load.guard_estimate_occasion_revision();

-- ---------------------------------------------------------------------------
-- 6. The dashboards' series: the policy that shows estimates
-- ---------------------------------------------------------------------------
do $$
declare
  c text;
begin
  select conname into c from pg_constraint where conrelid = 'training_load.dashboard_widget_series'::regclass
    and contype = 'c' and pg_get_constraintdef(oid) like '%source_policy%all_with_conflicts%';
  execute format('alter table training_load.dashboard_widget_series drop constraint %I', c);
end;
$$;
alter table training_load.dashboard_widget_series
  add constraint dashboard_widget_series_source_policy_check
  check (source_policy in ('all_with_conflicts', 'source_connection', 'manual', 'api_import', 'csv_import', 'derived', 'not_applicable', 'estimate'));

-- ---------------------------------------------------------------------------
-- 7. The session undo: v60's scope and undo with the estimates counted and removed
-- ---------------------------------------------------------------------------
create or replace function training_load.session_undo_scope(p_event uuid) returns jsonb as $$
declare
  v_est_occ integer;
  v_est_val integer;
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
  -- v63: estimates are listed and removed with the session; they never block (contract rule 8).
  select count(*)::int into v_est_occ from training_load.metric_measurement_occasions where id = any(v_occ) and entry_method = 'estimate';
  select count(*)::int into v_est_val from training_load.metric_value_estimates where occasion_id = any(v_occ);
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
    'estimateOccasionCount', v_est_occ,
    'estimateValueCount', v_est_val,
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

create or replace function training_load.undo_imported_session(
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
  'v63: the sanctioned undo of one imported GPEXE session, its roster work and estimates included (platform admin only). See migrations_v2/202611121000_training_load_v63_metric_value_estimates.sql.';
